/**
 * Suite: phone-binding ceremony (v0.8 PR #36).
 *
 * The ceremony produces a `verified` row in `phone_bindings` proving
 * the developer's gateway operator controls the SIM at the time of
 * binding. v0.8 PR #37 will turn this row's existence into a HARD
 * prerequisite for `startVerification`. PR #36 only ships the
 * ceremony machinery — these tests pin every property the ceremony
 * has to satisfy:
 *
 *   PB1   pk_live_* is rejected on every ceremony endpoint
 *   PB2   start ⇒ pending row, single-use nonce, TTL'd, plus
 *         send_to + bind_message in the response
 *   PB3   valid BIND inbound flips the row to verified + bound_at
 *   PB4   inbound with wrong nonce → no match, row stays pending
 *   PB5   inbound from a different phone than the binding claims →
 *         no match, row stays pending
 *   PB6   expired pending nonce → BIND inbound is no_match, row
 *         stays pending
 *   PB7   replay (same nonce twice) → second attempt is no_match
 *   PB8   revoke flips status, fills revoked_at, can revoke pending
 *         and verified rows alike
 *   PB9   multiple pending rows for the same (app, phone) are
 *         allowed (developer retries don't 409)
 *   PB10  partial unique constraint: only ONE verified row per
 *         (app, phone) at a time — second start after a verified
 *         row 409s `already_bound`
 *   PB11  BIND-shaped body with malformed nonce does NOT fall
 *         through to a VERIFY parse — it stays a binding miss
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { resetDatabase, rawQuery } from "../helpers/db.js";
import { resetRedis } from "../helpers/redis.js";
import { createTestApp } from "../helpers/fixtures.js";
import { getTestApp } from "../helpers/app.js";
import { inboundBody, signGateway } from "../helpers/sign.js";

interface BindingRow {
  id: string;
  app_id: string;
  receiver_id: string;
  phone_e164: string;
  status: string;
  nonce: string;
  expires_at: Date;
  bound_at: Date | null;
  revoked_at: Date | null;
}

async function startBinding(opts: {
  app: Awaited<ReturnType<typeof getTestApp>>;
  fx: Awaited<ReturnType<typeof createTestApp>>;
  phone?: string;
  receiverId?: string;
  authBearer?: string;
}): Promise<{
  binding_id: string;
  phone_e164: string;
  status: string;
  expires_at: string;
  send_to: string;
  bind_message: string;
}> {
  const r = await opts.app.inject({
    method: "POST",
    url: "/v1/phone-bindings/start",
    headers: { authorization: `Bearer ${opts.authBearer ?? opts.fx.secretKey}` },
    payload: {
      phone: opts.phone ?? "+963991234567",
      receiver_id: opts.receiverId ?? opts.fx.receiverId,
    },
  });
  assert.equal(r.statusCode, 201, `start failed: ${r.body}`);
  return r.json() as ReturnType<typeof startBinding> extends Promise<infer T> ? T : never;
}

async function getBindingRow(id: string): Promise<BindingRow> {
  const rows = await rawQuery<BindingRow>(
    `SELECT id, app_id, receiver_id, phone_e164, status, nonce,
            expires_at, bound_at, revoked_at
       FROM phone_bindings WHERE id = $1`,
    [id],
  );
  assert.equal(rows.length, 1, "binding row not found");
  return rows[0]!;
}

describe("phone bindings — v0.8 PR #36", () => {
  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  it("PB1: pk_live_* is rejected on every ceremony endpoint", async () => {
    const fx = await createTestApp({ seedBoundPhone: null });
    const app = await getTestApp();

    // 403 — `pk_live_*` is a valid key, just the wrong kind for
    // secret-only endpoints. The auth plugin returns 403 forbidden,
    // not 401 unauthorized, when the key resolves but its kind
    // isn't in the route's allow-list.
    const start = await app.inject({
      method: "POST",
      url: "/v1/phone-bindings/start",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "+963991234567", receiver_id: fx.receiverId },
    });
    assert.equal(start.statusCode, 403, `pk_live should be 403, got ${start.statusCode}`);

    const get = await app.inject({
      method: "GET",
      url: "/v1/phone-bindings/pbn_xxxxxxx",
      headers: { authorization: `Bearer ${fx.publicKey}` },
    });
    assert.equal(get.statusCode, 403);

    const revoke = await app.inject({
      method: "POST",
      url: "/v1/phone-bindings/pbn_xxxxxxx/revoke",
      headers: { authorization: `Bearer ${fx.publicKey}` },
    });
    assert.equal(revoke.statusCode, 403);
  });

  it("PB2: start creates a pending row with TTL'd nonce + send_to + bind_message", async () => {
    const fx = await createTestApp({ seedBoundPhone: null });
    const app = await getTestApp();

    const out = await startBinding({ app, fx });
    assert.match(out.binding_id, /^pbn_[A-Z0-9]+$/);
    assert.equal(out.phone_e164, "+963991234567");
    assert.equal(out.status, "pending");
    assert.equal(out.send_to, fx.receiverMsisdn);
    assert.match(out.bind_message, /^BIND [A-Z0-9]{8,}$/);

    const row = await getBindingRow(out.binding_id);
    assert.equal(row.status, "pending");
    assert.equal(row.bound_at, null);
    assert.equal(row.revoked_at, null);
    assert.ok(row.nonce.length >= 8, "nonce too short");
    assert.ok(
      row.expires_at.getTime() > Date.now() + 60_000,
      "expires_at should be at least a minute out",
    );
  });

  it("PB3: a valid BIND inbound flips the row to verified", async () => {
    const fx = await createTestApp({ seedBoundPhone: null });
    const app = await getTestApp();
    const start = await startBinding({ app, fx });

    const body = inboundBody({
      from: "+963991234567",
      to: fx.receiverMsisdn,
      body: start.bind_message,
    });
    const headers = signGateway(fx.receiverId, fx.signingKey, body);
    const r = await app.inject({
      method: "POST",
      url: "/v1/inbound/sms",
      headers,
      payload: body,
    });
    assert.equal(r.statusCode, 202);

    const row = await getBindingRow(start.binding_id);
    assert.equal(row.status, "verified");
    assert.ok(row.bound_at instanceof Date, "bound_at should be set");
  });

  it("PB4: BIND inbound with the wrong nonce does NOT promote the row", async () => {
    const fx = await createTestApp({ seedBoundPhone: null });
    const app = await getTestApp();
    const start = await startBinding({ app, fx });

    const body = inboundBody({
      from: "+963991234567",
      to: fx.receiverMsisdn,
      body: "BIND ZZZZZZZZZZZZZZZZZZZZ",
    });
    const headers = signGateway(fx.receiverId, fx.signingKey, body);
    await app.inject({
      method: "POST",
      url: "/v1/inbound/sms",
      headers,
      payload: body,
    });

    const row = await getBindingRow(start.binding_id);
    assert.equal(row.status, "pending");
    assert.equal(row.bound_at, null);
  });

  it("PB5: BIND inbound from a different phone does NOT promote", async () => {
    const fx = await createTestApp({ seedBoundPhone: null });
    const app = await getTestApp();
    const start = await startBinding({ app, fx, phone: "+963991234567" });

    const body = inboundBody({
      from: "+963999999999",
      to: fx.receiverMsisdn,
      body: start.bind_message,
    });
    const headers = signGateway(fx.receiverId, fx.signingKey, body);
    const r = await app.inject({
      method: "POST",
      url: "/v1/inbound/sms",
      headers,
      payload: body,
    });
    assert.equal(r.statusCode, 202);

    const row = await getBindingRow(start.binding_id);
    assert.equal(row.status, "pending");
  });

  it("PB6: expired nonce → BIND inbound is a no-match, row stays pending", async () => {
    const fx = await createTestApp({ seedBoundPhone: null });
    const app = await getTestApp();
    const start = await startBinding({ app, fx });

    // Force the row's expires_at into the past.
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await sql`UPDATE phone_bindings SET expires_at = now() - interval '10 seconds' WHERE id = ${start.binding_id}`;
    } finally {
      await sql.end({ timeout: 5 });
    }

    const body = inboundBody({
      from: "+963991234567",
      to: fx.receiverMsisdn,
      body: start.bind_message,
    });
    const headers = signGateway(fx.receiverId, fx.signingKey, body);
    await app.inject({
      method: "POST",
      url: "/v1/inbound/sms",
      headers,
      payload: body,
    });

    const row = await getBindingRow(start.binding_id);
    assert.equal(row.status, "pending");
    assert.equal(row.bound_at, null);
  });

  it("PB7: replay — second BIND with the same nonce is a no-match", async () => {
    const fx = await createTestApp({ seedBoundPhone: null });
    const app = await getTestApp();
    const start = await startBinding({ app, fx });

    // First bind succeeds.
    const body1 = inboundBody({
      from: "+963991234567",
      to: fx.receiverMsisdn,
      body: start.bind_message,
    });
    const headers1 = signGateway(fx.receiverId, fx.signingKey, body1);
    await app.inject({
      method: "POST",
      url: "/v1/inbound/sms",
      headers: headers1,
      payload: body1,
    });

    let row = await getBindingRow(start.binding_id);
    assert.equal(row.status, "verified");
    const firstBoundAt = row.bound_at!;

    // Second arrival with identical nonce + different idempotency
    // key (so the inbound dedup doesn't short-circuit).
    const body2 = inboundBody({
      from: "+963991234567",
      to: fx.receiverMsisdn,
      body: start.bind_message,
      idempotencyKey: "replay_attempt_" + Math.random().toString(36).slice(2),
    });
    const headers2 = signGateway(fx.receiverId, fx.signingKey, body2);
    const r2 = await app.inject({
      method: "POST",
      url: "/v1/inbound/sms",
      headers: headers2,
      payload: body2,
    });
    assert.equal(r2.statusCode, 202);

    row = await getBindingRow(start.binding_id);
    // bound_at didn't move; row already at verified.
    assert.equal(row.bound_at!.toISOString(), firstBoundAt.toISOString());
  });

  it("PB8: revoke flips status + revoked_at, works for pending and verified", async () => {
    const fx = await createTestApp({ seedBoundPhone: null });
    const app = await getTestApp();

    // Pending → revoked.
    const pending = await startBinding({ app, fx, phone: "+963991111111" });
    const r1 = await app.inject({
      method: "POST",
      url: `/v1/phone-bindings/${pending.binding_id}/revoke`,
      headers: { authorization: `Bearer ${fx.secretKey}` },
    });
    assert.equal(r1.statusCode, 200);
    let row = await getBindingRow(pending.binding_id);
    assert.equal(row.status, "revoked");
    assert.ok(row.revoked_at instanceof Date);

    // Verified → revoked. (Bind it first, then revoke.)
    const verified = await startBinding({ app, fx, phone: "+963992222222" });
    const body = inboundBody({
      from: "+963992222222",
      to: fx.receiverMsisdn,
      body: verified.bind_message,
    });
    const headers = signGateway(fx.receiverId, fx.signingKey, body);
    await app.inject({
      method: "POST",
      url: "/v1/inbound/sms",
      headers,
      payload: body,
    });
    let row2 = await getBindingRow(verified.binding_id);
    assert.equal(row2.status, "verified");

    const r2 = await app.inject({
      method: "POST",
      url: `/v1/phone-bindings/${verified.binding_id}/revoke`,
      headers: { authorization: `Bearer ${fx.secretKey}` },
    });
    assert.equal(r2.statusCode, 200);
    row2 = await getBindingRow(verified.binding_id);
    assert.equal(row2.status, "revoked");
    assert.ok(row2.revoked_at instanceof Date);
  });

  it("PB9: multiple pending rows for the same (app, phone) are allowed", async () => {
    const fx = await createTestApp({ seedBoundPhone: null });
    const app = await getTestApp();

    const a = await startBinding({ app, fx });
    const b = await startBinding({ app, fx });
    assert.notEqual(a.binding_id, b.binding_id);

    const rows = await rawQuery<{ count: string }>(
      `SELECT count(*)::text AS count FROM phone_bindings
        WHERE app_id = $1 AND phone_e164 = $2 AND status = 'pending'`,
      [fx.appId, "+963991234567"],
    );
    assert.equal(rows[0]!.count, "2");
  });

  it("PB10: partial unique constraint — second start after a verified row 409s already_bound", async () => {
    const fx = await createTestApp({ seedBoundPhone: null });
    const app = await getTestApp();

    const first = await startBinding({ app, fx, phone: "+963991234567" });
    const body = inboundBody({
      from: "+963991234567",
      to: fx.receiverMsisdn,
      body: first.bind_message,
    });
    const headers = signGateway(fx.receiverId, fx.signingKey, body);
    await app.inject({
      method: "POST",
      url: "/v1/inbound/sms",
      headers,
      payload: body,
    });
    const row = await getBindingRow(first.binding_id);
    assert.equal(row.status, "verified");

    // Trying to start a second binding for the same (app, phone)
    // while a verified row exists must fail with 409 already_bound.
    const r = await app.inject({
      method: "POST",
      url: "/v1/phone-bindings/start",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { phone: "+963991234567", receiver_id: fx.receiverId },
    });
    assert.equal(r.statusCode, 409, `expected 409, got ${r.statusCode}: ${r.body}`);
    assert.equal(r.json().error.code, "already_bound");
  });

  it("PB11: BIND-shaped body with malformed nonce does NOT fall through to VERIFY", async () => {
    const fx = await createTestApp({ seedBoundPhone: null });
    const app = await getTestApp();
    // No pending bindings, but also a "VERIFY"-looking suffix that
    // a permissive parser might accept.
    const body = inboundBody({
      from: "+963991234567",
      to: fx.receiverMsisdn,
      body: "BIND VERIFY 123456",
    });
    const headers = signGateway(fx.receiverId, fx.signingKey, body);
    const r = await app.inject({
      method: "POST",
      url: "/v1/inbound/sms",
      headers,
      payload: body,
    });
    assert.equal(r.statusCode, 202);
    const out = r.json();
    // The matcher treats this as a BIND attempt (no match — no
    // such nonce). It must NOT be reinterpreted as a verify code.
    assert.equal(out.matched, false);

    // No verification rows exist on this app, so we can't directly
    // assert "no verification got verified" — but we CAN assert
    // the inbound was stored as a bind no-match and didn't create
    // any phone_binding rows either.
    const bindings = await rawQuery<{ count: string }>(
      `SELECT count(*)::text AS count FROM phone_bindings WHERE app_id = $1`,
      [fx.appId],
    );
    assert.equal(bindings[0]!.count, "0");
  });
});
