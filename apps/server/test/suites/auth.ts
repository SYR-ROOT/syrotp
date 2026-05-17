/**
 * Suite 3: API key auth and permissions.
 *   T19 public key can start verifications
 *   T20 secret key can read status / cancel
 *   T21 gateway key cannot use developer APIs
 *   missing/garbage tokens return 401
 *   revoked keys are rejected
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, schema } from "../../src/db/index.js";
import { resetDatabase } from "../helpers/db.js";
import { resetRedis } from "../helpers/redis.js";
import { createTestApp, createGatewayKey } from "../helpers/fixtures.js";
import { getTestApp } from "../helpers/app.js";

describe("auth & key permissions", () => {
  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  it("missing Authorization header is 401 (not 500)", async () => {
    const app = await getTestApp();
    const r = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      payload: { phone: "0991234567", purpose: "login" },
    });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().error.code, "unauthorized");
  });

  it("garbage Authorization is 401, never 500", async () => {
    const app = await getTestApp();
    for (const auth of [
      "Bearer",
      "Bearer ",
      "Basic abc",
      "Bearer pk_live_doesnotexist",
      "Bearer " + "x".repeat(2048),
    ]) {
      const r = await app.inject({
        method: "POST",
        url: "/v1/verifications",
        headers: { authorization: auth },
        payload: { phone: "0991234567", purpose: "login" },
      });
      assert.equal(r.statusCode, 401, `auth='${auth.slice(0, 20)}...' should be 401`);
    }
  });

  it("T19: public key can start a verification but cannot cancel", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const start = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    assert.equal(start.statusCode, 201);
    const id = start.json().id;

    // public key CAN cancel currently? Per services/verifications.ts:
    // cancelVerification accepts both kinds at the route level. Lock that
    // down here — a public key in a browser must NOT be able to cancel
    // arbitrary verifications.
    const cancel = await app.inject({
      method: "POST",
      url: `/v1/verifications/${id}/cancel`,
      headers: { authorization: `Bearer ${fx.publicKey}` },
    });
    // We expect 403 once the route restriction is tightened.
    assert.equal(
      cancel.statusCode,
      403,
      "public keys must NOT be able to cancel — see routes/verifications.ts",
    );
  });

  it("T20: secret key can read status and cancel", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const start = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    const id = start.json().id;

    const get = await app.inject({
      method: "GET",
      url: `/v1/verifications/${id}`,
      headers: { authorization: `Bearer ${fx.secretKey}` },
    });
    assert.equal(get.statusCode, 200);

    const cancel = await app.inject({
      method: "POST",
      url: `/v1/verifications/${id}/cancel`,
      headers: { authorization: `Bearer ${fx.secretKey}` },
    });
    assert.equal(cancel.statusCode, 200);
    assert.equal(cancel.json().status, "cancelled");
  });

  it("T21: gateway key cannot use developer APIs", async () => {
    const fx = await createTestApp();
    const gk = await createGatewayKey(fx.appId);
    const app = await getTestApp();
    const r = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${gk}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    assert.equal(r.statusCode, 403);
    assert.equal(r.json().error.code, "forbidden");
  });

  it("revoked keys are rejected with 401", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    // Revoke the secret key.
    await db
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(schema.apiKeys.kind, "secret"));
    const r = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    assert.equal(r.statusCode, 401);
  });

  it("disabled app rejects all keys with 401", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    await db.update(schema.apps).set({ disabled: true }).where(eq(schema.apps.id, fx.appId));
    const r = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    assert.equal(r.statusCode, 401);
  });
});
