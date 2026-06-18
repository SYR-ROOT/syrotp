/**
 * Suite 10: admin dashboard.
 *
 * Read-only, server-rendered HTML, behind Basic Auth. The 9 security
 * properties listed in the v0.3 PR 2 spec are each pinned by an `it()`
 * below — a regression on any of them fails CI.
 *
 * Setup tactic: the dashboard reads ADMIN_USER / ADMIN_PASSWORD_HASH
 * from process.env at *plugin-register* time. We mutate env between
 * tests and rebuild a fresh app via `buildApp()` directly — bypassing
 * the cached `getTestApp()` so each test sees the configuration it
 * declares.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../../src/app.js";
import { hashAdminPassword } from "../../src/admin/web/passwords.js";
import { resetDatabase } from "../helpers/db.js";
import { resetRedis } from "../helpers/redis.js";
import { createTestApp, seedVerifiedBinding } from "../helpers/fixtures.js";
import { inboundBody, signGateway } from "../helpers/sign.js";

const ADMIN_USER = "admin-test";
const ADMIN_PASSWORD = "test-password-not-secret-12345";
const VALID_HASH = hashAdminPassword(ADMIN_PASSWORD);

const basicAuth = (user: string, pwd: string): string =>
  "Basic " + Buffer.from(`${user}:${pwd}`, "utf8").toString("base64");

async function buildWithAdmin(enabled: boolean): Promise<FastifyInstance> {
  const prev = {
    user: process.env.ADMIN_USER,
    hash: process.env.ADMIN_PASSWORD_HASH,
  };
  if (enabled) {
    process.env.ADMIN_USER = ADMIN_USER;
    process.env.ADMIN_PASSWORD_HASH = VALID_HASH;
  } else {
    delete process.env.ADMIN_USER;
    delete process.env.ADMIN_PASSWORD_HASH;
  }
  try {
    const app = await buildApp();
    await app.ready();
    return app;
  } finally {
    // Restore so the next test starts clean — each test rebuilds.
    if (prev.user !== undefined) process.env.ADMIN_USER = prev.user;
    else delete process.env.ADMIN_USER;
    if (prev.hash !== undefined) process.env.ADMIN_PASSWORD_HASH = prev.hash;
    else delete process.env.ADMIN_PASSWORD_HASH;
  }
}

describe("admin dashboard", () => {
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

  // ----- 1. disabled by default ------------------------------------

  it("AD1: /admin returns 404 when ADMIN env vars are unset", async () => {
    testApp = await buildWithAdmin(false);
    for (const path of ["/admin", "/admin/receivers", "/admin/verifications", "/admin/inbound-sms", "/admin/health"]) {
      const r = await testApp.inject({ method: "GET", url: path });
      assert.equal(r.statusCode, 404, `path ${path}`);
    }
  });

  // ----- 2. unauthorized → 401 -------------------------------------

  it("AD2: /admin without Authorization header returns 401", async () => {
    testApp = await buildWithAdmin(true);
    const r = await testApp.inject({ method: "GET", url: "/admin" });
    assert.equal(r.statusCode, 401);
    // WWW-Authenticate hint is what tells browsers to prompt for creds.
    assert.match(String(r.headers["www-authenticate"] ?? ""), /Basic/);
  });

  // ----- 3. wrong password → 401 -----------------------------------

  it("AD3: wrong password returns 401", async () => {
    testApp = await buildWithAdmin(true);
    const r = await testApp.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: basicAuth(ADMIN_USER, "wrong-password") },
    });
    assert.equal(r.statusCode, 401);
  });

  it("AD3b: wrong username returns 401 (no oracle)", async () => {
    testApp = await buildWithAdmin(true);
    const r = await testApp.inject({
      method: "GET",
      url: "/admin",
      headers: { authorization: basicAuth("not-the-admin", ADMIN_PASSWORD) },
    });
    assert.equal(r.statusCode, 401);
  });

  // ----- 4. valid credentials → 200 --------------------------------

  it("AD4: valid credentials return 200", async () => {
    testApp = await buildWithAdmin(true);
    for (const path of ["/admin", "/admin/receivers", "/admin/verifications", "/admin/inbound-sms", "/admin/health"]) {
      const r = await testApp.inject({
        method: "GET",
        url: path,
        headers: { authorization: basicAuth(ADMIN_USER, ADMIN_PASSWORD) },
      });
      assert.equal(r.statusCode, 200, `path ${path}`);
      assert.match(String(r.headers["content-type"] ?? ""), /text\/html/);
    }
  });

  // ----- 5. constant-time password compare -------------------------

  it("AD5: ADMIN_PASSWORD_HASH is compared via scrypt + timingSafeEqual", async () => {
    // We can't directly observe constant-time-ness, but we CAN assert
    // that:
    //   (a) the stored value is parsed as `scrypt$<salt>$<hash>`
    //   (b) verifyAdminPassword returns false for any unrelated password
    //       — including ones whose first byte differs from the right
    //       password's hash output (proxy for "no early-exit on first
    //       mismatched byte")
    const { verifyAdminPassword } = await import("../../src/admin/web/passwords.js");
    // verifyAdminPassword is async — scrypt is offloaded to libuv's
    // thread pool so the main event loop doesn't stall under brute-
    // force load. Await every call here.
    assert.equal(await verifyAdminPassword(VALID_HASH, ADMIN_PASSWORD), true);
    assert.equal(await verifyAdminPassword(VALID_HASH, "x"), false);
    assert.equal(await verifyAdminPassword(VALID_HASH, ""), false);
    assert.equal(await verifyAdminPassword(VALID_HASH, ADMIN_PASSWORD + "x"), false);
    // Tampered stored value must not authenticate even with the right pwd.
    const tampered = VALID_HASH.slice(0, -1) + (VALID_HASH.endsWith("0") ? "1" : "0");
    assert.equal(await verifyAdminPassword(tampered, ADMIN_PASSWORD), false);
    // Garbage stored values must be rejected without throwing.
    assert.equal(await verifyAdminPassword("not-a-hash", ADMIN_PASSWORD), false);
    assert.equal(await verifyAdminPassword("scrypt$bad$bad", ADMIN_PASSWORD), false);
  });

  // ----- 6. phone never rendered in full ---------------------------

  it("AD6: receivers/verifications pages never expose full phone numbers", async () => {
    const fx = await createTestApp({ msisdn: "+963991234567" });
    testApp = await buildWithAdmin(true);

    // Drive a verification so verifications page has data.
    // The phone is intentionally unique (not the default seeded
    // `+963991234567`) so the masked-vs-unmasked assertions below
    // can target a specific number — seed its binding explicitly.
    await seedVerifiedBinding({
      appId: fx.appId,
      receiverId: fx.receiverId,
      phoneE164: "+963991234500",
    });
    const start = await testApp.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234500", purpose: "login" },
    });
    assert.equal(start.statusCode, 201);

    const headers = { authorization: basicAuth(ADMIN_USER, ADMIN_PASSWORD) };
    const r1 = await testApp.inject({ method: "GET", url: "/admin/receivers", headers });
    const r2 = await testApp.inject({ method: "GET", url: "/admin/verifications", headers });

    // Full E.164 must NOT appear verbatim on either page.
    assert.doesNotMatch(r1.body, /\+963991234567/, "receivers exposed full receiver MSISDN");
    assert.doesNotMatch(r2.body, /\+963991234500/, "verifications exposed full caller phone");
    // The masked form (* in the middle) should be present so operators
    // can still tell phones apart.
    assert.match(r1.body, /\+96399\*+/);
  });

  // ----- 7. inbound body never rendered in full --------------------

  it("AD7: inbound-sms page never exposes full SMS body / verification code", async () => {
    const fx = await createTestApp();
    testApp = await buildWithAdmin(true);

    const start = await testApp.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    const v = start.json();
    const code = v.message.replace(/^VERIFY\s+/, "");

    const body = inboundBody({
      from: "+963991234567",
      to: fx.receiverMsisdn,
      body: v.message,
    });
    const sigHeaders = signGateway(fx.receiverId, fx.signingKey, body);
    await testApp.inject({ method: "POST", url: "/v1/inbound/sms", headers: sigHeaders, payload: body });

    const r = await testApp.inject({
      method: "GET",
      url: "/admin/inbound-sms",
      headers: { authorization: basicAuth(ADMIN_USER, ADMIN_PASSWORD) },
    });
    assert.equal(r.statusCode, 200);
    // The verification code must NEVER appear on the dashboard.
    assert.doesNotMatch(r.body, new RegExp(code), "verification code leaked into inbound-sms page");
    // The full message body must not appear; only the verb + length.
    assert.doesNotMatch(r.body, new RegExp(`VERIFY\\s+${code}`));
    // The length-marker SHOULD appear so operators can spot odd-sized bodies.
    assert.match(r.body, /\(\d+ bytes\)/);
  });

  // ----- 8. no API keys / signatures / secrets ---------------------

  it("AD8: admin pages never expose API keys, signing keys, or HMAC headers", async () => {
    const fx = await createTestApp();
    testApp = await buildWithAdmin(true);

    const headers = { authorization: basicAuth(ADMIN_USER, ADMIN_PASSWORD) };
    const pages = await Promise.all(
      ["/admin", "/admin/receivers", "/admin/verifications", "/admin/inbound-sms", "/admin/health"]
        .map((url) => testApp!.inject({ method: "GET", url, headers })),
    );
    const blob = pages.map((p) => p.body).join("\n---\n");

    assert.doesNotMatch(blob, new RegExp(fx.publicKey), "pk_live_ leaked");
    assert.doesNotMatch(blob, new RegExp(fx.secretKey), "sk_live_ leaked");
    assert.doesNotMatch(blob, new RegExp(fx.signingKey), "gateway signing key leaked");
    // The wrap blob in receivers.secret_hash should never be rendered either.
    assert.doesNotMatch(blob, /v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  });

  // ----- 9. security headers ---------------------------------------

  it("AD9: every /admin response sets X-Frame-Options, Referrer-Policy, and a strict CSP", async () => {
    testApp = await buildWithAdmin(true);
    const headers = { authorization: basicAuth(ADMIN_USER, ADMIN_PASSWORD) };
    for (const url of ["/admin", "/admin/receivers", "/admin/health"]) {
      const r = await testApp.inject({ method: "GET", url, headers });
      assert.equal(r.statusCode, 200);
      assert.equal(r.headers["x-frame-options"], "DENY");
      assert.equal(r.headers["referrer-policy"], "no-referrer");
      assert.equal(r.headers["x-content-type-options"], "nosniff");
      const csp = String(r.headers["content-security-policy"] ?? "");
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /base-uri 'none'/);
      // No script-src allowance — server-rendered HTML, no JS.
      assert.doesNotMatch(csp, /script-src/);
    }
  });
});
