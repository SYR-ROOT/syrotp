/**
 * Suite 4: rate limiting.
 *   T7  replay protection: same nonce twice is rejected
 *   T8  timestamp skew: too-old or too-future is rejected
 *   T12 per-phone rate (covered above as T14 — phone cap is the moral equivalent)
 *   T13 per-IP rate on /v1/verifications
 *
 * We exercise the inbound rate limit by lowering it via Redis state we
 * control. The config-loaded values are pinned in setup.ts, so for these
 * tests we drive enough requests to hit them.
 *
 * NOTE: setup.ts sets RATE_LIMIT_START_PER_IP_PER_MIN=1000 by default to
 * keep other suites flake-free. To make T13 deterministic without rebuilding
 * the app, we instead pre-fill the rate-limit counter for our IP to within
 * 1 of the limit and verify the next call gets 429.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import { resetDatabase } from "../helpers/db.js";
import { resetRedis } from "../helpers/redis.js";
import { createTestApp } from "../helpers/fixtures.js";
import { getTestApp } from "../helpers/app.js";
import { inboundBody, signGateway } from "../helpers/sign.js";

describe("rate limiting & replay", () => {
  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  it("T7: replay attack — same nonce twice is rejected", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const start = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    const v = start.json();

    const body = inboundBody({
      from: "+963991234567",
      to: fx.receiverMsisdn,
      body: v.message,
    });
    const fixedNonce = "a".repeat(32);
    const headers = signGateway(fx.receiverId, fx.signingKey, body, { nonce: fixedNonce });

    const r1 = await app.inject({ method: "POST", url: "/v1/inbound/sms", headers, payload: body });
    assert.equal(r1.statusCode, 202);

    // Re-sign a NEW body with the SAME nonce — must be rejected as replay
    // even though the signature is freshly computed and valid.
    const body2 = inboundBody({
      from: "+963991234567",
      to: fx.receiverMsisdn,
      body: "VERIFY ZZZZZZ",
      idempotencyKey: "different_idem_key",
    });
    const headers2 = signGateway(fx.receiverId, fx.signingKey, body2, { nonce: fixedNonce });
    const r2 = await app.inject({ method: "POST", url: "/v1/inbound/sms", headers: headers2, payload: body2 });
    assert.equal(r2.statusCode, 401, "replayed nonce must be rejected");
  });

  it("T8: timestamp too far in the past or future is rejected", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const body = inboundBody({
      from: "+963991234567",
      to: fx.receiverMsisdn,
      body: "VERIFY ABCDEF",
    });
    const nowSec = Math.floor(Date.now() / 1000);

    const tooOld = signGateway(fx.receiverId, fx.signingKey, body, {
      timestamp: nowSec - 9999,
    });
    const r1 = await app.inject({ method: "POST", url: "/v1/inbound/sms", headers: tooOld, payload: body });
    assert.equal(r1.statusCode, 401);

    const tooFuture = signGateway(fx.receiverId, fx.signingKey, body, {
      timestamp: nowSec + 9999,
    });
    const r2 = await app.inject({ method: "POST", url: "/v1/inbound/sms", headers: tooFuture, payload: body });
    assert.equal(r2.statusCode, 401);

    const malformed = signGateway(fx.receiverId, fx.signingKey, body, {
      timestamp: NaN as unknown as number,
    });
    const r3 = await app.inject({ method: "POST", url: "/v1/inbound/sms", headers: malformed, payload: body });
    assert.equal(r3.statusCode, 401);
  });

  it("T13: per-IP rate limit on /v1/verifications returns 429 with Retry-After", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();

    // Pre-fill the bucket directly. The bucket key matches what the service
    // computes: syrotp:rl:start:ip:<ip>:<window>. We use the floor of the
    // current 60-second window.
    const r = new Redis(process.env.REDIS_URL!);
    const window = Math.floor(Date.now() / 1000 / 60);
    const limit = Number(process.env.RATE_LIMIT_START_PER_IP_PER_MIN ?? "1000");
    // Inject() reports req.ip as 127.0.0.1 by default.
    const bucket = `syrotp:rl:start:ip:127.0.0.1:${window}`;
    await r.set(bucket, String(limit), "EX", 70);
    await r.quit();

    const overflow = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    assert.equal(overflow.statusCode, 429);
    assert.match(overflow.headers["retry-after"] as string, /^\d+$/);
    assert.equal(overflow.json().error.code, "rate_limited");
  });
});
