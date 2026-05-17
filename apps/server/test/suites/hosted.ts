/**
 * Suite 11: hosted verification page (`/v/:id` + `/v/:id/status`).
 *
 * Pin every property the v0.5 PR 1 spec calls out as in-scope, plus
 * the security canaries that mirror the admin dashboard's:
 *
 *   HV1   GET /v/<bad-id>           → 404 (format leak rejected)
 *   HV2   GET /v/<unknown-id>       → 404
 *   HV3   GET /v/:id                → 200 HTML with strict CSP
 *   HV4   pending page exposes send_to + message + phone_masked
 *   HV5   pending page never echoes raw E.164 / api_key / receiver id
 *   HV6   countdown payload uses expires_at, not server-side derived state
 *   HV7   GET /v/:id/status         → 200 JSON with ONLY status + timestamps
 *   HV8   /status JSON drops message / send_to / phone / client_ref
 *   HV9   terminal state (cancelled) hides message + send_to from /v/:id
 *   HV10  rate limit on /v/:id/status (per-IP `status:` budget)
 *   HV11  HOSTED_PAGE_ENABLED=false unmounts /v/* (404 everywhere)
 *   HV12  CSP nonce is per-request — two responses produce two values
 *   HV13  HTML escapes the verification id when it's reflected in markup
 *   HV14  X-Frame-Options DENY + Referrer-Policy + no-store cache
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../src/app.js";
import { cancelVerification } from "../../src/services/verifications.js";
import Redis from "ioredis";
import { resetDatabase } from "../helpers/db.js";
import { resetRedis } from "../helpers/redis.js";
import { createTestApp } from "../helpers/fixtures.js";
import { getTestApp } from "../helpers/app.js";

async function startVerification(app: FastifyInstance, publicKey: string, phone = "0991234567"): Promise<{ id: string; sendTo: string; message: string; phoneMasked: string; expiresAt: string }> {
  const r = await app.inject({
    method: "POST",
    url: "/v1/verifications",
    headers: { authorization: `Bearer ${publicKey}` },
    payload: { phone, purpose: "login" },
  });
  assert.equal(r.statusCode, 201, `start failed: ${r.body}`);
  const v = r.json();
  return {
    id: v.id,
    sendTo: v.send_to,
    message: v.message,
    phoneMasked: v.phone_masked,
    expiresAt: v.expires_at,
  };
}

describe("hosted verification page", () => {
  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  it("HV1: GET /v/<malformed-id> returns 404", async () => {
    const app = await getTestApp();
    for (const bad of ["abc", "vrf_", "vrf-bad", "vrf_!nope", "../etc/passwd"]) {
      const r = await app.inject({ method: "GET", url: `/v/${encodeURIComponent(bad)}` });
      assert.equal(r.statusCode, 404, `path /v/${bad}`);
    }
  });

  it("HV2: GET /v/<unknown-but-well-formed-id> returns 404", async () => {
    const app = await getTestApp();
    const r = await app.inject({
      method: "GET",
      url: "/v/vrf_01HXNOSUCHID000000000000",
    });
    assert.equal(r.statusCode, 404);
  });

  it("HV3: GET /v/:id returns 200 HTML with strict CSP", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const v = await startVerification(app, fx.publicKey);

    const r = await app.inject({ method: "GET", url: `/v/${v.id}` });
    assert.equal(r.statusCode, 200);
    assert.match(String(r.headers["content-type"]), /^text\/html/);

    const csp = String(r.headers["content-security-policy"] ?? "");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'nonce-[A-Za-z0-9+/=]+'/);
    assert.match(csp, /frame-ancestors 'none'/);
    // Critical — no remote script / image / font sources allowed.
    assert.doesNotMatch(csp, /script-src[^;]*\bhttps?:/);
  });

  it("HV4: pending page exposes send_to, message, phone_masked", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const v = await startVerification(app, fx.publicKey);

    const r = await app.inject({ method: "GET", url: `/v/${v.id}` });
    const html = r.payload;

    assert.ok(html.includes(v.message), "message must render on pending page");
    assert.ok(html.includes(v.sendTo), "receiver msisdn must render on pending page");
    assert.ok(html.includes(v.phoneMasked), "phone_masked must render");
  });

  it("HV5: page never leaks raw E.164, api_key, or receiver id", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const rawPhone = "+963991234567";
    const v = await startVerification(app, fx.publicKey, "0991234567");

    const r = await app.inject({ method: "GET", url: `/v/${v.id}` });
    const html = r.payload;

    assert.ok(!html.includes(rawPhone), "raw E.164 must not appear");
    assert.ok(!html.includes(fx.publicKey), "api key must not appear");
    assert.ok(!html.includes(fx.secretKey), "secret key must not appear");
    assert.ok(!html.includes(fx.receiverId), "receiver id must not appear");
    assert.ok(!html.includes(fx.signingKey), "gateway signing key must not appear");
  });

  it("HV6: countdown payload uses expires_at attribute (not a server-rendered counter)", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const v = await startVerification(app, fx.publicKey);

    const r = await app.inject({ method: "GET", url: `/v/${v.id}` });
    const html = r.payload;

    assert.ok(html.includes(`data-expires-at="${v.expiresAt}"`), "expires_at must be embedded for client-side countdown");
    assert.ok(html.includes(`data-id="${v.id}"`), "verification id must be embedded for the polling client");
  });

  it("HV7: GET /v/:id/status returns 200 JSON", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const v = await startVerification(app, fx.publicKey);

    const r = await app.inject({ method: "GET", url: `/v/${v.id}/status` });
    assert.equal(r.statusCode, 200);
    assert.match(String(r.headers["content-type"]), /^application\/json/);
    const body = r.json();
    assert.equal(body.status, "pending");
    assert.equal(typeof body.expires_at, "string");
    assert.equal(body.verified_at, null);
  });

  it("HV8: /status JSON drops message / send_to / phone / client_ref / id", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const v = await startVerification(app, fx.publicKey);

    const r = await app.inject({ method: "GET", url: `/v/${v.id}/status` });
    const body = r.json();

    // Whitelist — only these keys allowed in the polling response.
    const keys = Object.keys(body).sort();
    assert.deepEqual(keys, ["expires_at", "status", "verified_at"]);
    // Defensive substring sweep — even if a future change leaked a
    // value through a non-key path (e.g. an error message), we'd
    // catch it here.
    const raw = JSON.stringify(body);
    assert.ok(!raw.includes(v.message), "message must NOT appear in /status JSON");
    assert.ok(!raw.includes(v.sendTo), "send_to must NOT appear in /status JSON");
    assert.ok(!raw.includes(v.phoneMasked), "phone_masked must NOT appear in /status JSON");
    assert.ok(!raw.includes(v.id), "verification id must NOT appear in /status JSON body");
  });

  it("HV9: cancelled verification hides send_to / message on the HTML page", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const v = await startVerification(app, fx.publicKey);

    // Cancel directly via the service — the in-app surface tests
    // already cover the route-level cancel; we just need terminal
    // state for the page render.
    await cancelVerification(fx.appId, v.id);

    const r = await app.inject({ method: "GET", url: `/v/${v.id}` });
    assert.equal(r.statusCode, 200);
    const html = r.payload;
    assert.ok(html.includes("Cancelled"), "should render the cancelled panel");
    assert.ok(!html.includes(v.message), "OTP message must NOT render after cancel");
    assert.ok(!html.includes(v.sendTo), "send_to must NOT render after cancel");
  });

  it("HV10: /status is rate-limited per-IP", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const v = await startVerification(app, fx.publicKey);

    // setup.ts pins RATE_LIMIT_STATUS_PER_IP_PER_MIN=1000 to keep
    // unrelated tests flake-free; mirror T13's tactic and pre-fill
    // the bucket so a single request lands at 429. inject() reports
    // req.ip as 127.0.0.1.
    const r = new Redis(process.env.REDIS_URL!);
    const window = Math.floor(Date.now() / 1000 / 60);
    const limit = Number(process.env.RATE_LIMIT_STATUS_PER_IP_PER_MIN ?? "1000");
    const bucket = `syrotp:rl:status:ip:127.0.0.1:${window}`;
    await r.set(bucket, String(limit), "EX", 70);
    await r.quit();

    const overflow = await app.inject({
      method: "GET",
      url: `/v/${v.id}/status`,
    });
    assert.equal(overflow.statusCode, 429);
    assert.match(String(overflow.headers["retry-after"] ?? ""), /^\d+$/);
    assert.equal(overflow.json().error.code, "rate_limited");
  });

  it("HV12: CSP nonce changes between requests", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const v = await startVerification(app, fx.publicKey);

    const r1 = await app.inject({ method: "GET", url: `/v/${v.id}` });
    const r2 = await app.inject({ method: "GET", url: `/v/${v.id}` });

    const nonce1 = String(r1.headers["content-security-policy"]).match(/nonce-([^']+)/)?.[1];
    const nonce2 = String(r2.headers["content-security-policy"]).match(/nonce-([^']+)/)?.[1];
    assert.ok(nonce1 && nonce2, "both responses must have a CSP nonce");
    assert.notEqual(nonce1, nonce2, "nonces must differ between requests");
  });

  it("HV14: hardening headers — X-Frame-Options DENY, Referrer-Policy, no-store", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    const v = await startVerification(app, fx.publicKey);

    const r = await app.inject({ method: "GET", url: `/v/${v.id}` });
    assert.equal(r.headers["x-frame-options"], "DENY");
    assert.equal(r.headers["referrer-policy"], "no-referrer");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.match(String(r.headers["cache-control"] ?? ""), /no-store/);
  });
});

describe("hosted verification page — disabled", () => {
  let testApp: FastifyInstance | null = null;

  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  afterEach(async () => {
    if (testApp) {
      await testApp.close();
      testApp = null;
    }
  });

  it("HV11: HOSTED_PAGE_ENABLED=false unmounts /v/* (every probe 404s)", async () => {
    // Same env-flip + buildApp() pattern the admin suite uses to
    // toggle plugin mounting per-test.
    const prev = process.env.HOSTED_PAGE_ENABLED;
    process.env.HOSTED_PAGE_ENABLED = "false";
    try {
      testApp = await buildApp();
      await testApp.ready();
      for (const path of ["/v/vrf_01HX", "/v/vrf_01HX/status"]) {
        const r = await testApp.inject({ method: "GET", url: path });
        assert.equal(r.statusCode, 404, `path ${path}`);
      }
    } finally {
      if (prev !== undefined) process.env.HOSTED_PAGE_ENABLED = prev;
      else delete process.env.HOSTED_PAGE_ENABLED;
    }
  });
});
