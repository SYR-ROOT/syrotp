/**
 * Suite: per-app rate limits (v0.8 PR #38).
 *
 * Stack on top of the existing per-IP / per-receiver buckets — the
 * narrower guard runs first, the broader per-app bucket second.
 * These tests pre-fill the per-app counter in Redis to within 1
 * of the limit and assert the next request gets 429 with bucket
 * label `*_per_app`, while leaving per-IP / per-receiver counters
 * alone (so we know the rejection came from the app bucket, not
 * the older one).
 *
 *   RA1   start: per-app limit kicks in independently of per-IP
 *   RA2   inbound: per-app limit kicks in (after per-receiver)
 *   RA3   binding: per-app limit kicks in (no per-IP guard exists)
 *   RA4   buckets keyed on app_id — different apps don't share
 *   RA5   per-IP / per-receiver still works in parallel
 *   RA6   429 body code is `rate_limited`; future operators can
 *         disambiguate via the `syrotp_rate_limited_total{bucket=...}`
 *         metric (the public response stays uniform)
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import Redis from "ioredis";
import { resetDatabase } from "../helpers/db.js";
import { resetRedis } from "../helpers/redis.js";
import { createTestApp } from "../helpers/fixtures.js";
import { getTestApp } from "../helpers/app.js";
import { inboundBody, signGateway } from "../helpers/sign.js";

/**
 * Pre-fill a Redis rate-limit counter to `count`. Mirrors the
 * key shape produced by `services/rateLimit.ts`.
 */
async function prefillBucket(key: string, count: number): Promise<void> {
  const r = new Redis(process.env.REDIS_URL!);
  try {
    const window = Math.floor(Date.now() / 1000 / 60);
    const bucket = `syrotp:rl:${key}:${window}`;
    await r.set(bucket, String(count), "EX", 70);
  } finally {
    await r.quit();
  }
}

describe("per-app rate limits — v0.8 PR #38", () => {
  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  it("RA1: start — per-app limit fires independently of per-IP", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();

    const limit = Number(process.env.RATE_LIMIT_VERIFICATIONS_PER_APP_PER_MIN ?? "1000");
    await prefillBucket(`start:app:${fx.appId}`, limit);

    // Per-IP bucket is still empty — only the app bucket should reject.
    const r = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    assert.equal(r.statusCode, 429, `expected 429, got ${r.statusCode}: ${r.body}`);
    assert.equal(r.json().error.code, "rate_limited");
    assert.match(r.headers["retry-after"] as string, /^\d+$/);
  });

  it("RA2: inbound — per-app limit fires (after per-receiver)", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();

    const limit = Number(process.env.RATE_LIMIT_INBOUND_PER_APP_PER_MIN ?? "1000");
    await prefillBucket(`inbound:app:${fx.appId}`, limit);

    const body = inboundBody({
      from: "+963991234567",
      to: fx.receiverMsisdn,
      body: "VERIFY ABCDEF",
    });
    const headers = signGateway(fx.receiverId, fx.signingKey, body);
    const r = await app.inject({ method: "POST", url: "/v1/inbound/sms", headers, payload: body });
    assert.equal(r.statusCode, 429, `expected 429, got ${r.statusCode}: ${r.body}`);
    assert.equal(r.json().error.code, "rate_limited");
  });

  it("RA3: binding — per-app limit fires", async () => {
    const fx = await createTestApp({ seedBoundPhone: null });
    const app = await getTestApp();

    const limit = Number(process.env.RATE_LIMIT_BINDINGS_PER_APP_PER_MIN ?? "1000");
    await prefillBucket(`phone_binding_start:app:${fx.appId}`, limit);

    const r = await app.inject({
      method: "POST",
      url: "/v1/phone-bindings/start",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { phone: "+963991111222", receiver_id: fx.receiverId },
    });
    assert.equal(r.statusCode, 429, `expected 429, got ${r.statusCode}: ${r.body}`);
  });

  it("RA4: buckets are keyed on app_id — different apps don't share", async () => {
    const fxA = await createTestApp();
    const fxB = await createTestApp();
    const app = await getTestApp();

    const limit = Number(process.env.RATE_LIMIT_VERIFICATIONS_PER_APP_PER_MIN ?? "1000");
    // Saturate app A's bucket.
    await prefillBucket(`start:app:${fxA.appId}`, limit);

    // App A: 429
    const ra = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fxA.publicKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    assert.equal(ra.statusCode, 429);

    // App B: 201 — different bucket key, untouched.
    const rb = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fxB.publicKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    assert.equal(rb.statusCode, 201, `app B should pass, got ${rb.statusCode}: ${rb.body}`);
  });

  it("RA5: per-IP guard still works alongside per-app", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();

    // Saturate the per-IP bucket (NOT the app bucket).
    const limit = Number(process.env.RATE_LIMIT_START_PER_IP_PER_MIN ?? "1000");
    await prefillBucket(`start:ip:127.0.0.1`, limit);

    const r = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    assert.equal(r.statusCode, 429, "per-IP bucket should reject");
  });

  it("RA6: 429 response carries the uniform `rate_limited` code (bucket disambiguation lives in metrics)", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();

    const appLimit = Number(process.env.RATE_LIMIT_VERIFICATIONS_PER_APP_PER_MIN ?? "1000");
    await prefillBucket(`start:app:${fx.appId}`, appLimit);

    const r = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    assert.equal(r.statusCode, 429);
    // Public response is intentionally uniform — operators see the
    // bucket label via the syrotp_rate_limited_total{bucket=...}
    // Prometheus counter, NOT via the API response. This protects
    // the SDK developer-experience: a 429 is a 429, regardless of
    // which bucket fired.
    assert.equal(r.json().error.code, "rate_limited");
    assert.ok(typeof r.json().error.message === "string");
  });
});
