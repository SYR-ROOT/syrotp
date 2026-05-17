/**
 * Suite: phone-binding enforcement on `startVerification` (v0.8 PR #37).
 *
 * The hard invariant: `POST /v1/verifications` rejects with
 * `403 phone_not_bound` whenever no `verified` row in
 * `phone_bindings` exists for `(app_id, phone_e164)`. No bypass,
 * no feature flag, no soft warning.
 *
 *   PE1   No binding ⇒ 403 `phone_not_bound`
 *   PE2   Verified binding ⇒ 201 (existing happy path)
 *   PE3   Revoked binding ⇒ 403
 *   PE4   Pending binding ⇒ 403 (only `verified` counts)
 *   PE5   Verified binding for a different app ⇒ 403 (app-scoped)
 *   PE6   Verified binding for the same (app, phone) but a
 *         different receiver still allows verification — binding
 *         is app-scoped per the v0.8 design decision
 *   PE7   Phone normalization — caller passing local format
 *         "0991234567" matches the seeded "+963991234567" binding
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { resetDatabase } from "../helpers/db.js";
import { resetRedis } from "../helpers/redis.js";
import { addReceiver, createTestApp, seedVerifiedBinding } from "../helpers/fixtures.js";
import { getTestApp } from "../helpers/app.js";

async function postStart(opts: {
  app: Awaited<ReturnType<typeof getTestApp>>;
  fx: Awaited<ReturnType<typeof createTestApp>>;
  phone: string;
}) {
  return opts.app.inject({
    method: "POST",
    url: "/v1/verifications",
    headers: { authorization: `Bearer ${opts.fx.publicKey}` },
    payload: { phone: opts.phone, purpose: "login" },
  });
}

describe("phone-binding enforcement — v0.8 PR #37", () => {
  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  it("PE1: startVerification rejects unbound phone with 403 phone_not_bound", async () => {
    const fx = await createTestApp({ seedBoundPhone: null });
    const app = await getTestApp();

    const r = await postStart({ app, fx, phone: "+963991234567" });
    assert.equal(r.statusCode, 403, `expected 403, got ${r.statusCode}: ${r.body}`);
    assert.equal(r.json().error.code, "phone_not_bound");
  });

  it("PE2: startVerification accepts a verified-bound phone", async () => {
    // Default `createTestApp()` already seeds a verified binding
    // for "+963991234567" — this is the dominant test phone.
    const fx = await createTestApp();
    const app = await getTestApp();

    const r = await postStart({ app, fx, phone: "+963991234567" });
    assert.equal(r.statusCode, 201, `expected 201, got ${r.statusCode}: ${r.body}`);
    assert.equal(r.json().status, "pending");
  });

  it("PE3: a revoked binding rejects with 403", async () => {
    const fx = await createTestApp({ seedBoundPhone: null });
    const app = await getTestApp();

    // Seed a verified row, then revoke it via the API.
    const bindingId = await seedVerifiedBinding({
      appId: fx.appId,
      receiverId: fx.receiverId,
      phoneE164: "+963991234567",
    });
    const revoke = await app.inject({
      method: "POST",
      url: `/v1/phone-bindings/${bindingId}/revoke`,
      headers: { authorization: `Bearer ${fx.secretKey}` },
    });
    assert.equal(revoke.statusCode, 200);

    const r = await postStart({ app, fx, phone: "+963991234567" });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().error.code, "phone_not_bound");
  });

  it("PE4: a pending binding rejects with 403 (only verified counts)", async () => {
    const fx = await createTestApp({ seedBoundPhone: null });
    const app = await getTestApp();

    // Start the ceremony but don't complete it — leaves a pending row.
    const start = await app.inject({
      method: "POST",
      url: "/v1/phone-bindings/start",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { phone: "+963991234567", receiver_id: fx.receiverId },
    });
    assert.equal(start.statusCode, 201);
    assert.equal(start.json().status, "pending");

    const r = await postStart({ app, fx, phone: "+963991234567" });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().error.code, "phone_not_bound");
  });

  it("PE5: a verified binding for a different app does NOT cross over", async () => {
    const fxOther = await createTestApp({
      msisdn: "+963998887000",
      seedBoundPhone: "+963991234567",
    });
    void fxOther; // its app has the verified binding; ours doesn't

    const fx = await createTestApp({ seedBoundPhone: null });
    const app = await getTestApp();

    const r = await postStart({ app, fx, phone: "+963991234567" });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().error.code, "phone_not_bound");
  });

  it("PE6: a verified binding for app+phone is app-scoped — receiver doesn't matter", async () => {
    // Per the design decision: enforcement is at (app_id, phone_e164),
    // NOT (app_id, phone_e164, receiver_id). So a binding tied to
    // receiver A still satisfies a verification that the router
    // sends to receiver B (in the same app).
    const fx = await createTestApp({ msisdn: "+963998887777", seedBoundPhone: null });
    const extra = await addReceiver(fx.appId, {
      msisdn: "+963998887888",
      operator: "mtn",
    });

    // Seed binding tied to the FIRST receiver.
    await seedVerifiedBinding({
      appId: fx.appId,
      receiverId: fx.receiverId,
      phoneE164: "+963991234567",
    });

    const app = await getTestApp();
    const r = await postStart({ app, fx, phone: "+963991234567" });
    assert.equal(r.statusCode, 201, `expected 201, got ${r.statusCode}: ${r.body}`);
    // The router can pick either receiver; the test passes as long
    // as the verification was created (proving enforcement passed).
    const body = r.json();
    assert.ok(
      body.send_to === fx.receiverMsisdn || body.send_to === extra.msisdn,
      `unexpected send_to: ${body.send_to}`,
    );
  });

  it("PE7: phone normalization — local format matches a seeded E.164 binding", async () => {
    const fx = await createTestApp(); // seeds +963991234567 by default
    const app = await getTestApp();

    // The dev sends the local format; the server normalizes to
    // +963991234567 BEFORE the binding lookup, so the seeded row
    // matches.
    const r = await postStart({ app, fx, phone: "0991234567" });
    assert.equal(r.statusCode, 201, `expected 201, got ${r.statusCode}: ${r.body}`);
  });
});
