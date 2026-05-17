/**
 * Suite 15: multi-receiver routing.
 *
 * Pins the v0.5 routing contract:
 *
 *   MR1   choose any healthy receiver when no preference is given
 *   MR2   ignore stale (no recent heartbeat) receiver
 *   MR3   ignore disabled receiver
 *   MR4   prefer same-operator when caller passes `operator`
 *   MR5   fall back to any healthy when preferred operator unavailable
 *   MR6   no healthy receiver → 503 no_receiver
 *   MR7   start_verification stamps the receiver msisdn + operator on the row
 *   MR8   hosted page reads the snapshot, NOT the live receivers join
 *   MR9   in-place receivers.msisdn change does NOT shift the hosted page
 *         display (the snapshot is the source of truth)
 *   MR10  pre-snapshot rows (NULL snapshot) still render via the receivers
 *         join — backward-compat for verifications older than migration 0003
 *   MR11  bad operator string (control chars, too long) → 400 validation_error
 *   MR12  cancelling and re-checking still shows the same receiver_id
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { resetDatabase } from "../helpers/db.js";
import { resetRedis } from "../helpers/redis.js";
import { addReceiver, createTestApp, seedVerifiedBinding } from "../helpers/fixtures.js";
import { getTestApp } from "../helpers/app.js";

interface VerificationRow {
  id: string;
  receiver_id: string;
  receiver_msisdn_snapshot: string | null;
  receiver_operator_snapshot: string | null;
}

async function dbq<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    return (await sql.unsafe<T[]>(text, params as never)) as T[];
  } finally {
    await sql.end({ timeout: 5 });
  }
}

describe("multi-receiver routing", () => {
  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  // ----- MR1: any healthy when no preference --------------------------

  it("MR1: chooses a healthy receiver when no operator preference is given", async () => {
    const fx = await createTestApp({ msisdn: "+963998887777" });
    const app = await getTestApp();

    const r = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    assert.equal(r.statusCode, 201);
    assert.equal(r.json().send_to, "+963998887777");
  });

  // ----- MR2 / MR3: stale + disabled excluded -------------------------

  it("MR2: stale receiver (no recent heartbeat) is excluded", async () => {
    // Bootstrap with a healthy primary so the inbound smoke isn't
    // impacted; then add a stale receiver that should NEVER be picked.
    const fx = await createTestApp({ msisdn: "+963998887777" });
    await addReceiver(fx.appId, {
      msisdn: "+963990001111",
      withHeartbeat: false,
    });
    const app = await getTestApp();

    // Pick 5 times — none should land on the stale receiver.
    // v0.8 PR #37 enforces that every (app, phone) pair has a
    // verified binding; seed each loop phone before it's used.
    for (let i = 0; i < 5; i++) {
      const phone = `+963999000${100 + i}`;
      await seedVerifiedBinding({ appId: fx.appId, receiverId: fx.receiverId, phoneE164: phone });
      const r = await app.inject({
        method: "POST",
        url: "/v1/verifications",
        headers: { authorization: `Bearer ${fx.publicKey}` },
        payload: { phone, purpose: "login" },
      });
      assert.equal(r.json().send_to, "+963998887777");
    }
  });

  it("MR3: disabled receiver is excluded", async () => {
    const fx = await createTestApp({ msisdn: "+963998887777" });
    await addReceiver(fx.appId, {
      msisdn: "+963990002222",
      enabled: false,
    });
    const app = await getTestApp();
    for (let i = 0; i < 5; i++) {
      const phone = `+963999000${200 + i}`;
      await seedVerifiedBinding({ appId: fx.appId, receiverId: fx.receiverId, phoneE164: phone });
      const r = await app.inject({
        method: "POST",
        url: "/v1/verifications",
        headers: { authorization: `Bearer ${fx.publicKey}` },
        payload: { phone, purpose: "login" },
      });
      assert.equal(r.json().send_to, "+963998887777");
    }
  });

  // ----- MR4 / MR5: operator-aware routing ----------------------------

  it("MR4: prefers same-operator receiver when caller passes `operator`", async () => {
    const fx = await createTestApp({
      msisdn: "+963998887777",
      receiverOperator: "syriatel",
    });
    await addReceiver(fx.appId, {
      msisdn: "+963990003333",
      operator: "mtn",
    });
    const app = await getTestApp();

    const r = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234567", purpose: "login", operator: "mtn" },
    });
    assert.equal(r.statusCode, 201);
    assert.equal(r.json().send_to, "+963990003333", "should route to mtn receiver");
  });

  it("MR5: falls back to any healthy when preferred operator is unavailable", async () => {
    const fx = await createTestApp({
      msisdn: "+963998887777",
      receiverOperator: "syriatel",
    });
    // Only syriatel is healthy. Caller asks for mtn.
    const app = await getTestApp();

    const r = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234567", purpose: "login", operator: "mtn" },
    });
    assert.equal(r.statusCode, 201, "fallback must succeed instead of 503");
    assert.equal(r.json().send_to, "+963998887777");
  });

  // ----- MR6: no healthy → 503 ---------------------------------------

  it("MR6: no healthy receiver → 503 no_receiver", async () => {
    const fx = await createTestApp({
      msisdn: "+963998887777",
      withHeartbeat: false, // bootstrap stale → no healthy receiver at all
    });
    const app = await getTestApp();

    const r = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().error.code, "no_receiver");
  });

  // ----- MR7: snapshots populated -----------------------------------

  it("MR7: start_verification stamps msisdn + operator snapshots on the row", async () => {
    const fx = await createTestApp({
      msisdn: "+963998887777",
      receiverOperator: "syriatel",
    });
    const app = await getTestApp();
    const r = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    const v = r.json();

    const rows = await dbq<VerificationRow>(
      `SELECT id, receiver_id, receiver_msisdn_snapshot, receiver_operator_snapshot
       FROM verifications WHERE id = $1`,
      [v.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.receiver_msisdn_snapshot, "+963998887777");
    assert.equal(rows[0]!.receiver_operator_snapshot, "syriatel");
  });

  // ----- MR8: hosted page reads the snapshot --------------------------

  it("MR8: hosted page renders the snapshot value", async () => {
    const fx = await createTestApp({
      msisdn: "+963998887777",
      receiverOperator: "syriatel",
    });
    const app = await getTestApp();
    const start = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    const v = start.json();

    const r = await app.inject({ method: "GET", url: `/v/${v.id}` });
    assert.equal(r.statusCode, 200);
    assert.ok(r.payload.includes("+963998887777"), "page must show snapshot msisdn");
  });

  // ----- MR9: in-place receiver change must NOT shift the page -------

  it("MR9: a later in-place change to receivers.msisdn does NOT shift the hosted page", async () => {
    const fx = await createTestApp({ msisdn: "+963998887777" });
    const app = await getTestApp();
    const start = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    const v = start.json();

    // Simulate an admin / migration / replication tweak — change the
    // live receiver msisdn out from under the verification.
    await dbq(`UPDATE receivers SET msisdn = $1 WHERE id = $2`, [
      "+963999999999",
      fx.receiverId,
    ]);

    const r = await app.inject({ method: "GET", url: `/v/${v.id}` });
    assert.equal(r.statusCode, 200);
    assert.ok(
      r.payload.includes("+963998887777"),
      "page must still show the snapshot value, not the live receivers row",
    );
    assert.ok(
      !r.payload.includes("+963999999999"),
      "page MUST NOT echo the post-start receivers.msisdn change",
    );
  });

  // ----- MR10: backward-compat for pre-snapshot rows -----------------

  it("MR10: rows with NULL snapshot fall back to receivers join", async () => {
    const fx = await createTestApp({ msisdn: "+963998887777" });
    const app = await getTestApp();
    const start = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    const v = start.json();

    // Simulate a verification created BEFORE migration 0003 by
    // nulling out the snapshot columns post-hoc.
    await dbq(
      `UPDATE verifications
         SET receiver_msisdn_snapshot = NULL,
             receiver_operator_snapshot = NULL
         WHERE id = $1`,
      [v.id],
    );

    const r = await app.inject({ method: "GET", url: `/v/${v.id}` });
    assert.equal(r.statusCode, 200);
    assert.ok(
      r.payload.includes("+963998887777"),
      "old row must still render via the receivers join",
    );
  });

  // ----- MR11: bad operator string -----------------------------------

  it("MR11: bad operator string is rejected with 400 validation_error", async () => {
    const fx = await createTestApp({ msisdn: "+963998887777" });
    const app = await getTestApp();
    for (const operator of [
      "has space",
      "has;semicolon",
      "x".repeat(33), // exceeds max length
      "<script>",
    ]) {
      const r = await app.inject({
        method: "POST",
        url: "/v1/verifications",
        headers: { authorization: `Bearer ${fx.publicKey}` },
        payload: { phone: "0991234567", purpose: "login", operator },
      });
      assert.equal(r.statusCode, 400, `operator ${JSON.stringify(operator)} should fail`);
      assert.equal(r.json().error.code, "validation_error");
    }
  });

  // ----- MR12: receiver stays put across reads ----------------------

  it("MR12: re-reading a verification reports the same receiver_id (no churn)", async () => {
    const fx = await createTestApp({ msisdn: "+963998887777" });
    await addReceiver(fx.appId, { msisdn: "+963990004444" });
    const app = await getTestApp();

    const start = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    const v = start.json();

    const rows = await dbq<VerificationRow>(
      `SELECT id, receiver_id, receiver_msisdn_snapshot, receiver_operator_snapshot
       FROM verifications WHERE id = $1`,
      [v.id],
    );
    const stampedReceiverId = rows[0]!.receiver_id;
    const stampedMsisdn = rows[0]!.receiver_msisdn_snapshot;

    // Hammer the read path; the receiver_id MUST NOT change.
    for (let i = 0; i < 5; i++) {
      const fetched = await app.inject({
        method: "GET",
        url: `/v1/verifications/${v.id}`,
        headers: { authorization: `Bearer ${fx.publicKey}` },
      });
      assert.equal(fetched.statusCode, 200);
    }
    const after = await dbq<VerificationRow>(
      `SELECT id, receiver_id, receiver_msisdn_snapshot FROM verifications WHERE id = $1`,
      [v.id],
    );
    assert.equal(after[0]!.receiver_id, stampedReceiverId);
    assert.equal(after[0]!.receiver_msisdn_snapshot, stampedMsisdn);
  });
});
