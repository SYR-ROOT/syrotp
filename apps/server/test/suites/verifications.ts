/**
 * Suite 1: verifications
 *   T1  start verification returns pending without leaking phone existence
 *   T2  Syrian numbers in different formats normalize to one E.164
 *   T14 pending cap per phone enforced
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { resetDatabase } from "../helpers/db.js";
import { resetRedis } from "../helpers/redis.js";
import { createTestApp } from "../helpers/fixtures.js";
import { getTestApp } from "../helpers/app.js";

describe("verifications", () => {
  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  it("T1: start returns pending and never reveals phone existence", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();

    const phone1 = "0991234567";   // never seen before
    const phone2 = "0991234567";   // same — 2nd call should still succeed identically

    const r1 = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: phone1, purpose: "login" },
    });
    assert.equal(r1.statusCode, 201);
    const v1 = r1.json();
    assert.equal(v1.status, "pending");
    assert.match(v1.id, /^vrf_[A-Za-z0-9]+$/);
    assert.match(v1.message, /^VERIFY [A-Z2-9]{6}$/);
    assert.equal(v1.send_to, fx.receiverMsisdn);
    assert.equal(v1.phone_masked, "+96399****567");
    // phone is masked — never echoes the raw E.164 the developer sent
    assert.ok(!JSON.stringify(v1).includes("963991234567"));

    const r2 = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: phone2, purpose: "login" },
    });
    assert.equal(r2.statusCode, 201);
    // Different verification ID, identical-shape response — no enumeration signal.
    assert.notEqual(r2.json().id, v1.id);
  });

  it("T2: Syrian numbers in many formats all normalize to +963991234567", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();

    const variants = [
      "0991234567",
      "+963991234567",
      "963991234567",
      "00963991234567",
      "+963 99 123 4567",
    ];

    const ids: string[] = [];
    for (const phone of variants) {
      const r = await app.inject({
        method: "POST",
        url: "/v1/verifications",
        headers: { authorization: `Bearer ${fx.publicKey}` },
        payload: { phone, purpose: "login" },
      });
      assert.equal(r.statusCode, 201, `format ${phone} should normalize`);
      assert.equal(r.json().phone_masked, "+96399****567");
      ids.push(r.json().id);
    }
    assert.equal(new Set(ids).size, variants.length); // each one is its own row
  });

  it("rejects invalid phone numbers with stable code", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const r = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "not-a-phone", purpose: "login" },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error.code, "invalid_phone");
  });

  it("T14: refuses to exceed MAX_PENDING_PER_PHONE", async () => {
    // setup.ts pins MAX_PENDING_PER_PHONE=10. Create exactly the cap, then
    // expect the next one to be rejected.
    const fx = await createTestApp();
    const app = await getTestApp();
    const phone = "0991234567";
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/v1/verifications",
        headers: { authorization: `Bearer ${fx.publicKey}` },
        payload: { phone, purpose: "login" },
      });
      assert.equal(r.statusCode, 201, `iteration ${i}`);
    }
    const overflow = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone, purpose: "login" },
    });
    assert.equal(overflow.statusCode, 409);
    assert.equal(overflow.json().error.code, "too_many_pending");
  });

  it("503 when no healthy receiver is available", async () => {
    const fx = await createTestApp({ withHeartbeat: false });
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

  it("cancels a pending verification (secret key)", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const start = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    const id = start.json().id;

    const cancelled = await app.inject({
      method: "POST",
      url: `/v1/verifications/${id}/cancel`,
      headers: { authorization: `Bearer ${fx.secretKey}` },
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().status, "cancelled");

    const second = await app.inject({
      method: "POST",
      url: `/v1/verifications/${id}/cancel`,
      headers: { authorization: `Bearer ${fx.secretKey}` },
    });
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().error.code, "not_pending");
  });
});
