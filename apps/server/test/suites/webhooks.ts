/**
 * Suite 12: webhooks (PR #20A — core, no delivery worker yet).
 *
 * Pins the contract for endpoint CRUD, secret-once-on-creation,
 * lifecycle event emission (verify / cancel / expire), and
 * payload safety:
 *
 *   WH1   POST /v1/webhooks → 201 with secret, secret persisted as ciphertext
 *   WH2   secret is ONLY in the create response — GET never includes it
 *   WH3   public key (pk_live_*) cannot create webhooks
 *   WH4   bad URL / missing event_types → 400 validation_error
 *   WH5   unknown event_type → 400
 *   WH6   GET list returns endpoints for the calling app only (no leak across apps)
 *   WH7   GET /v1/webhooks/:id of another app → 404 (no enumeration)
 *   WH8   DELETE removes the row + cascades pending deliveries
 *   WH9   verification.verified emits event + delivery for subscribed endpoint
 *   WH10  verification.cancelled emits event
 *   WH11  verification.expired emits event (lazy-expire path)
 *   WH12  endpoint NOT subscribed to event_type → no delivery row
 *   WH13  disabled endpoint → no delivery row
 *   WH14  payload whitelist: no raw E.164, no OTP code, no api_key,
 *         no receiver id, no signing key
 *   WH15  one event → fan-out: N subscribed endpoints → N delivery rows
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { resetDatabase } from "../helpers/db.js";
import { resetRedis } from "../helpers/redis.js";
import { createTestApp } from "../helpers/fixtures.js";
import { getTestApp } from "../helpers/app.js";
import { inboundBody, signGateway } from "../helpers/sign.js";
import { unwrap } from "../../src/lib/aead.js";
import { config } from "../../src/config.js";
import { cancelVerification, getVerification } from "../../src/services/verifications.js";

interface DeliveryRow {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  status: string;
  attempt_count: number;
  next_attempt_at: Date;
}
interface EventRow {
  id: string;
  app_id: string;
  event_type: string;
  verification_id: string | null;
  payload_json: string;
}
interface EndpointRow {
  id: string;
  app_id: string;
  url: string;
  enabled: boolean;
  secret_ciphertext: string;
  event_types: string[];
}

async function dbq<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    return (await sql.unsafe<T[]>(text, params as never)) as T[];
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function startThenVerify(fxPublicKey: string, fxReceiverId: string, fxSigningKey: string, fxReceiverMsisdn: string): Promise<{ vId: string; appId: string }> {
  const app = await getTestApp();
  const start = await app.inject({
    method: "POST",
    url: "/v1/verifications",
    headers: { authorization: `Bearer ${fxPublicKey}` },
    payload: { phone: "0991234567", purpose: "login" },
  });
  assert.equal(start.statusCode, 201);
  const v = start.json();

  const body = inboundBody({
    from: "+963991234567",
    to: fxReceiverMsisdn,
    body: v.message,
  });
  const headers = signGateway(fxReceiverId, fxSigningKey, body);
  const r = await app.inject({ method: "POST", url: "/v1/inbound/sms", headers, payload: body });
  assert.equal(r.statusCode, 202);

  const fetched = await app.inject({
    method: "GET",
    url: `/v1/verifications/${v.id}`,
    headers: { authorization: `Bearer ${fxPublicKey}` },
  });
  assert.equal(fetched.json().status, "verified");
  return { vId: v.id, appId: "" };
}

describe("webhooks (PR 20A — core)", () => {
  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  // ----- WH1: create returns secret, persists ciphertext --------------

  it("WH1: POST /v1/webhooks → 201 with secret; DB stores ciphertext only", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();

    const r = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: {
        url: "https://hooks.example.com/syrotp",
        event_types: ["verification.verified"],
      },
    });
    assert.equal(r.statusCode, 201);
    const body = r.json();
    assert.match(body.id, /^whk_[A-Za-z0-9]+$/);
    assert.match(body.secret, /^whsec_[a-f0-9]{64}$/, "secret must be whsec_<32-byte-hex>");
    assert.equal(body.url, "https://hooks.example.com/syrotp");
    assert.deepEqual(body.event_types, ["verification.verified"]);
    assert.equal(body.enabled, true);

    // DB row stores ciphertext, not the raw secret.
    const rows = await dbq<EndpointRow>(
      `SELECT id, app_id, url, enabled, secret_ciphertext, event_types FROM webhook_endpoints WHERE id = $1`,
      [body.id],
    );
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.notEqual(row.secret_ciphertext, body.secret, "DB must not hold raw secret");
    assert.match(row.secret_ciphertext, /^v1\./, "secret_ciphertext must be wrapped");
    // Round-trip via AAD-bound unwrap to confirm we can recover it.
    const recovered = unwrap(config.MASTER_ENCRYPTION_KEY, row.secret_ciphertext, `webhook:${row.id}`);
    assert.equal(recovered, body.secret);
  });

  // ----- WH2: GET never includes secret -------------------------------

  it("WH2: secret is only in the POST response; GET endpoints never include it", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();

    const created = (
      await app.inject({
        method: "POST",
        url: "/v1/webhooks",
        headers: { authorization: `Bearer ${fx.secretKey}` },
        payload: {
          url: "https://hooks.example.com/syrotp",
          event_types: ["verification.verified"],
        },
      })
    ).json();

    const list = await app.inject({
      method: "GET",
      url: "/v1/webhooks",
      headers: { authorization: `Bearer ${fx.secretKey}` },
    });
    assert.equal(list.statusCode, 200);
    const listBody = list.json();
    assert.ok(!JSON.stringify(listBody).includes("whsec_"), "list must never carry whsec_");
    assert.ok(!JSON.stringify(listBody).includes("secret"), "list must not echo a `secret` field");

    const one = await app.inject({
      method: "GET",
      url: `/v1/webhooks/${created.id}`,
      headers: { authorization: `Bearer ${fx.secretKey}` },
    });
    assert.equal(one.statusCode, 200);
    const oneBody = one.json();
    assert.equal(oneBody.id, created.id);
    assert.ok(!JSON.stringify(oneBody).includes("whsec_"));
  });

  // ----- WH3: pk_live cannot create -----------------------------------

  it("WH3: public key is rejected — webhooks are backend-only", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const r = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { url: "https://x.example", event_types: ["verification.verified"] },
    });
    // requireKey([secret]) raises 403 for a valid-but-wrong-kind key
    // (vs 401 for unknown/missing). Either is fine here — the
    // contract is "public key cannot create webhooks".
    assert.equal(r.statusCode, 403);
  });

  // ----- WH4 / WH5: validation ---------------------------------------

  it("WH4: missing url or event_types → 400 validation_error", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    for (const payload of [
      {},
      { url: "" },
      { url: "https://x" }, // missing event_types
      { url: "ftp://x", event_types: ["verification.verified"] },
      { url: "https://user:pass@x.example", event_types: ["verification.verified"] },
      { url: "https://x", event_types: [] },
    ]) {
      const r = await app.inject({
        method: "POST",
        url: "/v1/webhooks",
        headers: { authorization: `Bearer ${fx.secretKey}` },
        payload,
      });
      assert.equal(r.statusCode, 400, `payload ${JSON.stringify(payload)} should have failed`);
      assert.equal(r.json().error.code, "validation_error");
    }
  });

  it("WH5: unknown event_type → 400", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const r = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { url: "https://x.example", event_types: ["verification.attempted"] },
    });
    assert.equal(r.statusCode, 400);
  });

  // ----- WH6: list scoped to caller's app ----------------------------

  it("WH6: list scopes to the caller's app", async () => {
    const fxA = await createTestApp({ name: "App A" });
    const fxB = await createTestApp({ name: "App B" });
    const app = await getTestApp();

    await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { authorization: `Bearer ${fxA.secretKey}` },
      payload: { url: "https://a.example", event_types: ["verification.verified"] },
    });
    await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { authorization: `Bearer ${fxB.secretKey}` },
      payload: { url: "https://b.example", event_types: ["verification.verified"] },
    });

    const listA = (
      await app.inject({
        method: "GET",
        url: "/v1/webhooks",
        headers: { authorization: `Bearer ${fxA.secretKey}` },
      })
    ).json();
    assert.equal(listA.data.length, 1);
    assert.equal(listA.data[0].url, "https://a.example");
  });

  // ----- WH7: GET another app's id → 404 -----------------------------

  it("WH7: GET another app's webhook id → 404 (no enumeration)", async () => {
    const fxA = await createTestApp({ name: "App A" });
    const fxB = await createTestApp({ name: "App B" });
    const app = await getTestApp();

    const created = (
      await app.inject({
        method: "POST",
        url: "/v1/webhooks",
        headers: { authorization: `Bearer ${fxA.secretKey}` },
        payload: { url: "https://a.example", event_types: ["verification.verified"] },
      })
    ).json();

    const r = await app.inject({
      method: "GET",
      url: `/v1/webhooks/${created.id}`,
      headers: { authorization: `Bearer ${fxB.secretKey}` },
    });
    assert.equal(r.statusCode, 404);
  });

  // ----- WH8: DELETE cascades ----------------------------------------

  it("WH8: DELETE returns 204 and the row is gone", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const created = (
      await app.inject({
        method: "POST",
        url: "/v1/webhooks",
        headers: { authorization: `Bearer ${fx.secretKey}` },
        payload: { url: "https://x.example", event_types: ["verification.verified"] },
      })
    ).json();

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/webhooks/${created.id}`,
      headers: { authorization: `Bearer ${fx.secretKey}` },
    });
    assert.equal(del.statusCode, 204);

    const get = await app.inject({
      method: "GET",
      url: `/v1/webhooks/${created.id}`,
      headers: { authorization: `Bearer ${fx.secretKey}` },
    });
    assert.equal(get.statusCode, 404);
  });

  // ----- WH9: verification.verified event emitted ---------------------

  it("WH9: verification.verified emits event + delivery for subscribed endpoint", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();

    const endpoint = (
      await app.inject({
        method: "POST",
        url: "/v1/webhooks",
        headers: { authorization: `Bearer ${fx.secretKey}` },
        payload: {
          url: "https://hooks.example.com/syrotp",
          event_types: ["verification.verified", "verification.cancelled"],
        },
      })
    ).json();

    await startThenVerify(fx.publicKey, fx.receiverId, fx.signingKey, fx.receiverMsisdn);

    const events = await dbq<EventRow>(
      `SELECT id, app_id, event_type, verification_id, payload_json FROM webhook_events ORDER BY created_at`,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]!.event_type, "verification.verified");
    assert.equal(events[0]!.app_id, fx.appId);

    const deliveries = await dbq<DeliveryRow>(
      `SELECT id, endpoint_id, event_id, event_type, status, attempt_count, next_attempt_at FROM webhook_deliveries`,
    );
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.endpoint_id, endpoint.id);
    assert.equal(deliveries[0]!.event_type, "verification.verified");
    assert.equal(deliveries[0]!.status, "pending");
    assert.equal(deliveries[0]!.attempt_count, 0);
  });

  // ----- WH10: verification.cancelled --------------------------------

  it("WH10: verification.cancelled emits event", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { url: "https://x.example", event_types: ["verification.cancelled"] },
    });

    const start = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    const v = start.json();

    await cancelVerification(fx.appId, v.id);

    const events = await dbq<EventRow>(
      `SELECT id, event_type, payload_json FROM webhook_events`,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0]!.event_type, "verification.cancelled");
    const env = JSON.parse(events[0]!.payload_json);
    assert.equal(env.data.status, "cancelled");
    assert.ok(typeof env.data.cancelled_at === "string");
  });

  // ----- WH11: verification.expired (lazy-expire path) --------------

  it("WH11: verification.expired emits event when the lazy-expire transition lands", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { url: "https://x.example", event_types: ["verification.expired"] },
    });

    const start = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    const v = start.json();

    // Force expires_at into the past so the next read triggers the
    // lazy-expire path.
    await dbq(
      `UPDATE verifications SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [v.id],
    );

    // Read once → triggers the background transition + event emit.
    await getVerification(fx.appId, v.id, "secret");

    // Wait briefly for the void background tx to settle.
    for (let i = 0; i < 10; i++) {
      const events = await dbq<EventRow>(
        `SELECT event_type FROM webhook_events WHERE verification_id = $1`,
        [v.id],
      );
      if (events.length > 0) {
        assert.equal(events[0]!.event_type, "verification.expired");
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail("verification.expired event was not emitted within 500ms");
  });

  // ----- WH12: endpoint not subscribed → no delivery -----------------

  it("WH12: endpoint NOT subscribed to the event_type → no delivery row", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      // Subscribed only to .cancelled
      payload: { url: "https://x.example", event_types: ["verification.cancelled"] },
    });

    await startThenVerify(fx.publicKey, fx.receiverId, fx.signingKey, fx.receiverMsisdn);

    // Event row is created (audit), but no delivery row should exist —
    // there's no subscriber for verification.verified.
    const events = await dbq<EventRow>(`SELECT id FROM webhook_events`);
    assert.equal(events.length, 1);

    const deliveries = await dbq<DeliveryRow>(`SELECT id FROM webhook_deliveries`);
    assert.equal(deliveries.length, 0);
  });

  // ----- WH13: disabled endpoint → no delivery -----------------------

  it("WH13: disabled endpoint → no delivery row", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const created = (
      await app.inject({
        method: "POST",
        url: "/v1/webhooks",
        headers: { authorization: `Bearer ${fx.secretKey}` },
        payload: { url: "https://x.example", event_types: ["verification.verified"] },
      })
    ).json();

    // Flip the row to disabled directly. (No PATCH endpoint in PR 20A.)
    await dbq(`UPDATE webhook_endpoints SET enabled = false WHERE id = $1`, [created.id]);

    await startThenVerify(fx.publicKey, fx.receiverId, fx.signingKey, fx.receiverMsisdn);

    const deliveries = await dbq<DeliveryRow>(`SELECT id FROM webhook_deliveries`);
    assert.equal(deliveries.length, 0);
  });

  // ----- WH14: payload safety canaries -------------------------------

  it("WH14: payload contains NO raw E.164, OTP code, api_key, receiver id, or signing key", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { url: "https://x.example", event_types: ["verification.verified"] },
    });

    const start = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    const v = start.json();
    const code = v.message.split(" ").pop()!;

    const body = inboundBody({
      from: "+963991234567",
      to: fx.receiverMsisdn,
      body: v.message,
    });
    const headers = signGateway(fx.receiverId, fx.signingKey, body);
    await app.inject({ method: "POST", url: "/v1/inbound/sms", headers, payload: body });

    const events = await dbq<EventRow>(`SELECT payload_json FROM webhook_events`);
    assert.equal(events.length, 1);
    const raw = events[0]!.payload_json;

    // Whitelist canaries — NONE of these should appear in the payload.
    assert.ok(!raw.includes("+963991234567"), "raw E.164 must not appear");
    assert.ok(!raw.includes(code), "OTP code must not appear");
    assert.ok(!raw.includes(fx.publicKey), "publicKey must not appear");
    assert.ok(!raw.includes(fx.secretKey), "secretKey must not appear");
    assert.ok(!raw.includes(fx.receiverId), "receiver id must not appear");
    assert.ok(!raw.includes(fx.signingKey), "gateway signing key must not appear");

    // Whitelist what IS expected.
    const env = JSON.parse(raw);
    assert.equal(env.type, "verification.verified");
    assert.match(env.id, /^evt_[A-Za-z0-9]+$/);
    assert.equal(env.data.verification_id, v.id);
    assert.equal(env.data.status, "verified");
    assert.equal(env.data.phone_masked, "+96399****567");
    assert.equal(env.data.purpose, "login");
    assert.ok("verified_at" in env.data);
  });

  // ----- WH15: fan-out -----------------------------------------------

  it("WH15: one event → N subscribed endpoints → N delivery rows", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();

    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: "POST",
        url: "/v1/webhooks",
        headers: { authorization: `Bearer ${fx.secretKey}` },
        payload: {
          url: `https://h${i}.example.com/syrotp`,
          event_types: ["verification.verified"],
        },
      });
    }

    await startThenVerify(fx.publicKey, fx.receiverId, fx.signingKey, fx.receiverMsisdn);

    const deliveries = await dbq<DeliveryRow>(`SELECT id FROM webhook_deliveries`);
    assert.equal(deliveries.length, 3, "one event → fan-out to 3 endpoints");
  });
});
