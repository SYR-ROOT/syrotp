/**
 * Suite 2: inbound SMS — the heart of the protocol.
 *   T3  valid SMS verifies a pending verification
 *   T4  SMS from a different sender does NOT verify
 *   T5  wrong code does NOT verify
 *   T6  expired verification does NOT verify
 *   T9  raw-body sensitivity: flipping one byte breaks the signature
 *   T10 duplicate idempotency_key returns 409 and does not double-claim
 *   T17 unknown receiver id is rejected
 *   T18 disabled receiver is rejected
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, schema } from "../../src/db/index.js";
import { resetDatabase } from "../helpers/db.js";
import { resetRedis } from "../helpers/redis.js";
import { createTestApp } from "../helpers/fixtures.js";
import { getTestApp } from "../helpers/app.js";
import { inboundBody, signGateway } from "../helpers/sign.js";

async function startVerification(app: Awaited<ReturnType<typeof getTestApp>>, fx: Awaited<ReturnType<typeof createTestApp>>, phone = "0991234567") {
  const r = await app.inject({
    method: "POST",
    url: "/v1/verifications",
    headers: { authorization: `Bearer ${fx.publicKey}` },
    payload: { phone, purpose: "login" },
  });
  assert.equal(r.statusCode, 201);
  return r.json() as { id: string; message: string; send_to: string };
}

describe("inbound SMS", () => {
  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  it("T3: a valid signed SMS verifies the matching verification", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const v = await startVerification(app, fx);

    const body = inboundBody({
      from: "+963991234567",
      to: fx.receiverMsisdn,
      body: v.message,
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
    assert.equal(out.matched, true);
    assert.equal(out.verification_id, v.id);

    // Status now verified.
    const status = await app.inject({
      method: "GET",
      url: `/v1/verifications/${v.id}`,
      headers: { authorization: `Bearer ${fx.secretKey}` },
    });
    assert.equal(status.json().status, "verified");
  });

  it("T4: SMS from a different sender does NOT verify", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const v = await startVerification(app, fx, "0991234567");

    const body = inboundBody({
      from: "+963999999999", // different from the verification's phone
      to: fx.receiverMsisdn,
      body: v.message,
    });
    const headers = signGateway(fx.receiverId, fx.signingKey, body);
    const r = await app.inject({
      method: "POST",
      url: "/v1/inbound/sms",
      headers,
      payload: body,
    });
    assert.equal(r.statusCode, 202);
    assert.equal(r.json().matched, false);
    assert.equal(r.json().reason, "no_match");

    const status = await app.inject({
      method: "GET",
      url: `/v1/verifications/${v.id}`,
      headers: { authorization: `Bearer ${fx.secretKey}` },
    });
    assert.equal(status.json().status, "pending");
  });

  it("T5: wrong code does NOT verify", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const v = await startVerification(app, fx);

    const body = inboundBody({
      from: "+963991234567",
      to: fx.receiverMsisdn,
      body: "VERIFY ZZZZZZ", // not the issued code
    });
    const headers = signGateway(fx.receiverId, fx.signingKey, body);
    const r = await app.inject({
      method: "POST",
      url: "/v1/inbound/sms",
      headers,
      payload: body,
    });
    assert.equal(r.statusCode, 202);
    assert.equal(r.json().matched, false);
    void v;
  });

  it("T6: an expired verification does NOT verify", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const v = await startVerification(app, fx);

    // Force-expire the row in the DB.
    await db
      .update(schema.verifications)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.verifications.id, v.id));

    const body = inboundBody({
      from: "+963991234567",
      to: fx.receiverMsisdn,
      body: v.message,
    });
    const headers = signGateway(fx.receiverId, fx.signingKey, body);
    const r = await app.inject({
      method: "POST",
      url: "/v1/inbound/sms",
      headers,
      payload: body,
    });
    assert.equal(r.statusCode, 202);
    assert.equal(r.json().matched, false);
    assert.equal(r.json().reason, "no_match"); // we deliberately do NOT leak "expired"
  });

  it("T9: flipping one body byte breaks the signature", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const v = await startVerification(app, fx);

    const original = inboundBody({
      from: "+963991234567",
      to: fx.receiverMsisdn,
      body: v.message,
    });
    const headers = signGateway(fx.receiverId, fx.signingKey, original);

    // Tamper: change a single character in the body. The signature was
    // computed over the original — swap must be rejected. We flip one
    // digit of the sender phone, which is guaranteed to be present in
    // the JSON body regardless of what `v.message` happened to be.
    const tampered = original.replace('"+963991234567"', '"+963991234568"');
    assert.notEqual(tampered, original, "tamper must actually change bytes");

    const r = await app.inject({
      method: "POST",
      url: "/v1/inbound/sms",
      headers,
      payload: tampered,
    });
    assert.equal(r.statusCode, 401, "any byte change must invalidate the HMAC");
  });

  it("T10: duplicate idempotency_key returns 409 and does not re-verify", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const v = await startVerification(app, fx);

    const body = inboundBody({
      from: "+963991234567",
      to: fx.receiverMsisdn,
      body: v.message,
      idempotencyKey: "dup_key_abcdef",
    });
    const h1 = signGateway(fx.receiverId, fx.signingKey, body);
    const r1 = await app.inject({ method: "POST", url: "/v1/inbound/sms", headers: h1, payload: body });
    assert.equal(r1.statusCode, 202);
    assert.equal(r1.json().matched, true);

    const h2 = signGateway(fx.receiverId, fx.signingKey, body);
    const r2 = await app.inject({ method: "POST", url: "/v1/inbound/sms", headers: h2, payload: body });
    assert.equal(r2.statusCode, 409);
    assert.equal(r2.json().reason, "duplicate");
  });

  it("T17: unknown receiver id is rejected with 401", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const v = await startVerification(app, fx);
    const body = inboundBody({
      from: "+963991234567",
      to: fx.receiverMsisdn,
      body: v.message,
    });
    const headers = signGateway("rcv_DOESNOTEXIST", fx.signingKey, body);
    const r = await app.inject({ method: "POST", url: "/v1/inbound/sms", headers, payload: body });
    assert.equal(r.statusCode, 401);
  });

  it("T18: disabled receiver is rejected with 401", async () => {
    const fx = await createTestApp({ receiverEnabled: false });
    const app = await getTestApp();
    const body = inboundBody({
      from: "+963991234567",
      to: fx.receiverMsisdn,
      body: "VERIFY AAAAAA",
    });
    const headers = signGateway(fx.receiverId, fx.signingKey, body);
    const r = await app.inject({ method: "POST", url: "/v1/inbound/sms", headers, payload: body });
    assert.equal(r.statusCode, 401);
  });
});
