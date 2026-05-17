/**
 * Suite 8: concurrency & atomicity (T11).
 *
 * If two inbound SMS arrive that both look like they could verify the same
 * pending row, exactly ONE must succeed. The matcher relies on
 *   UPDATE ... SET status='verified' WHERE id=? AND status='pending'
 * which Postgres serializes — but we also exercise it under load to be
 * sure the application code doesn't introduce a TOCTOU window above it.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { resetDatabase } from "../helpers/db.js";
import { resetRedis } from "../helpers/redis.js";
import { createTestApp } from "../helpers/fixtures.js";
import { getTestApp } from "../helpers/app.js";
import { inboundBody, signGateway } from "../helpers/sign.js";
import { config } from "../../src/config.js";

describe("concurrency", () => {
  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  it("T11: 5 concurrent inbound SMS — exactly one wins", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const start = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    const v = start.json();

    // Five distinct inbound messages, each with a unique idempotency key
    // and unique nonce, all matching the same code. Only the first to
    // commit the UPDATE should claim the verification.
    const requests = Array.from({ length: 5 }, (_, i) => {
      const body = inboundBody({
        from: "+963991234567",
        to: fx.receiverMsisdn,
        body: v.message,
        idempotencyKey: `concurrent_${i}_${Date.now()}`,
      });
      const headers = signGateway(fx.receiverId, fx.signingKey, body);
      return app.inject({ method: "POST", url: "/v1/inbound/sms", headers, payload: body });
    });

    const responses = await Promise.all(requests);
    const matched = responses.filter((r) => r.json().matched === true);
    const notMatched = responses.filter((r) => r.json().matched === false);
    assert.equal(matched.length, 1, "exactly one inbound wins");
    assert.equal(notMatched.length, 4, "the rest see no_match");

    const status = await app.inject({
      method: "GET",
      url: `/v1/verifications/${v.id}`,
      headers: { authorization: `Bearer ${fx.secretKey}` },
    });
    assert.equal(status.json().status, "verified");
    assert.equal(status.json().attempts, 1, "only the winning inbound bumps attempts");
  });

  // ----- T12: verification creation MAX_PENDING_PER_PHONE race ----------
  //
  // Pre-v0.9 PR #42, `startVerification` did:
  //   SELECT count(*) WHERE phone=$1 AND status='pending'
  //   if (count >= MAX) throw 409
  //   INSERT
  // …with the await between SELECT and INSERT yielding the event loop.
  // Two concurrent calls for the same phone could both read count=N-1,
  // both pass the cap, and both INSERT, leaving N+1 pending rows.
  //
  // PR #42 wraps both in a tx with a per-(app, phone) advisory lock.
  // This test pins the actual invariant — not "no 500", but "the DB
  // never holds more than MAX pending rows for one phone, no matter
  // how many concurrent callers race the gate."

  it("T12: concurrent startVerification for the same phone never exceeds MAX_PENDING_PER_PHONE", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const max = config.MAX_PENDING_PER_PHONE;
    const overshoot = 5;
    const total = max + overshoot;

    const requests = Array.from({ length: total }, () =>
      app.inject({
        method: "POST",
        url: "/v1/verifications",
        headers: { authorization: `Bearer ${fx.publicKey}` },
        payload: { phone: "0991234567", purpose: "login" },
      }),
    );

    const responses = await Promise.all(requests);
    const successes = responses.filter((r) => r.statusCode === 201);
    const conflicts = responses.filter((r) => r.statusCode === 409);

    assert.equal(
      successes.length,
      max,
      `expected exactly ${max} successes, got ${successes.length}`,
    );
    assert.equal(
      conflicts.length,
      overshoot,
      `expected exactly ${overshoot} 409s, got ${conflicts.length}`,
    );
    for (const r of conflicts) {
      const j = r.json();
      assert.equal(j.error?.code, "too_many_pending", "all 409s should be too_many_pending");
    }

    // Hard invariant — query the DB directly and assert the row count
    // matches MAX exactly. A "no 500" assertion isn't enough; the only
    // thing that proves the race is fixed is "the table never held more
    // than MAX pending rows for this phone, no matter the timing."
    const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      const rows = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count
          FROM verifications
         WHERE phone_e164 = ${"+963991234567"}
           AND status = 'pending'
      `;
      assert.equal(
        rows[0]?.count,
        max,
        `pending row count must equal MAX_PENDING_PER_PHONE (${max}); got ${rows[0]?.count}`,
      );
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
