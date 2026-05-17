/**
 * Suite 16: WebAuthn fallback (v0.5 PR 4).
 *
 * The four routes use @simplewebauthn/server for the actual
 * cryptographic verify. Forging a real attestation/assertion in CI
 * is impractical, so we stub the verify functions via
 * `services/webauthn.__testing.setVerifier(...)` and assert on the
 * storage / TTL / single-use / config-disabled / canary properties
 * the spec calls out:
 *
 *   WA1   WEBAUTHN_ENABLED=false → all four routes 404 (no auth surface)
 *   WA2   pk_live_* is rejected — backend-only surface
 *   WA3   register/options stamps a challenge row with TTL
 *   WA4   register/verify with no active challenge → 400 challenge_invalid
 *   WA5   register/verify happy path stores the credential row
 *   WA6   challenge is single-use — same response a second time → 400
 *   WA7   expired challenge → 400 challenge_invalid
 *   WA8   login/verify happy path bumps sign_count + last_used_at
 *   WA9   login/verify for an unknown credential id → 404
 *   WA10  no raw challenge bytes appear in logs (canary)
 *   WA11  bad origin / bad rpID surfaces as 400 (library raises;
 *         we surface as assertion_failed / attestation_failed)
 */
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { buildApp } from "../../src/app.js";
import { resetDatabase } from "../helpers/db.js";
import { resetRedis } from "../helpers/redis.js";
import { createTestApp } from "../helpers/fixtures.js";
import { getTestApp } from "../helpers/app.js";
import { __testing as webauthnTesting } from "../../src/services/webauthn.js";
import { startCapture, stopCapture } from "../helpers/logCapture.js";

interface CredentialRow {
  id: string;
  app_id: string;
  client_ref: string;
  credential_id_hash: string;
  sign_count: number;
  last_used_at: Date | null;
}
interface ChallengeRow {
  id: string;
  app_id: string;
  client_ref: string;
  challenge: string;
  purpose: string;
  expires_at: Date;
  used_at: Date | null;
}

async function dbq<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    return (await sql.unsafe<T[]>(text, params as never)) as T[];
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const FAKE_CRED_ID = "fake-credential-id-base64url";

function fakeRegistrationVerified() {
  return {
    verified: true as const,
    registrationInfo: {
      fmt: "none" as const,
      aaguid: "00000000-0000-0000-0000-000000000000",
      credential: {
        id: FAKE_CRED_ID,
        publicKey: new Uint8Array([0xa5, 0x01, 0x02, 0x03]), // pretend COSE bytes
        counter: 0,
        transports: ["internal"] as const,
      },
      credentialType: "public-key" as const,
      attestationObject: new Uint8Array(),
      userVerified: true,
      credentialDeviceType: "singleDevice" as const,
      credentialBackedUp: false,
      origin: "http://syrotp.test",
      rpID: "syrotp.test",
    },
  };
}

function fakeAuthenticationVerified(newCounter: number) {
  return {
    verified: true as const,
    authenticationInfo: {
      credentialID: FAKE_CRED_ID,
      newCounter,
      credentialDeviceType: "singleDevice" as const,
      credentialBackedUp: false,
      origin: "http://syrotp.test",
      rpID: "syrotp.test",
      userVerified: true,
    },
  };
}

describe("webauthn fallback", () => {
  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
    webauthnTesting.reset();
  });

  afterEach(() => {
    webauthnTesting.reset();
  });

  // ----- WA2: pk_live rejected ----------------------------------------

  it("WA2: pk_live_* is rejected on every webauthn endpoint", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    for (const path of [
      "/v1/webauthn/register/options",
      "/v1/webauthn/register/verify",
      "/v1/webauthn/login/options",
      "/v1/webauthn/login/verify",
    ]) {
      const r = await app.inject({
        method: "POST",
        url: path,
        headers: { authorization: `Bearer ${fx.publicKey}` },
        payload: { client_ref: "user_42" },
      });
      assert.equal(r.statusCode, 403, `path ${path} should be 403 for pk_live_*`);
    }
  });

  // ----- WA3: challenge stamped with TTL ------------------------------

  it("WA3: register/options stamps a challenge row with TTL", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();

    const r = await app.inject({
      method: "POST",
      url: "/v1/webauthn/register/options",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { client_ref: "user_42" },
    });
    assert.equal(r.statusCode, 200);
    const opts = r.json();
    assert.ok(typeof opts.challenge === "string" && opts.challenge.length > 0);

    const rows = await dbq<ChallengeRow>(
      `SELECT id, app_id, client_ref, challenge, purpose, expires_at, used_at
       FROM webauthn_challenges WHERE app_id = $1 AND client_ref = $2`,
      [fx.appId, "user_42"],
    );
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.purpose, "register");
    assert.equal(row.used_at, null);
    assert.equal(row.challenge, opts.challenge, "stored challenge matches the one we returned");
    const ttlMs = new Date(row.expires_at).getTime() - Date.now();
    assert.ok(ttlMs > 0 && ttlMs <= 70_000, `expires_at within ~60s, got ${ttlMs}ms`);
  });

  // ----- WA4: verify with no active challenge → 400 -------------------

  it("WA4: register/verify with no active challenge returns 400 challenge_invalid", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    webauthnTesting.setVerifier({
      verifyRegistrationResponse: async () => {
        throw new Error("library should not be reached when no challenge exists");
      },
    });

    const r = await app.inject({
      method: "POST",
      url: "/v1/webauthn/register/verify",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { client_ref: "user_42", response: { id: FAKE_CRED_ID } },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error.code, "challenge_invalid");
  });

  // ----- WA5: happy register path stores the credential ---------------

  it("WA5: register/verify happy path stores the credential row", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    webauthnTesting.setVerifier({
      verifyRegistrationResponse: async () => fakeRegistrationVerified() as never,
    });

    await app.inject({
      method: "POST",
      url: "/v1/webauthn/register/options",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { client_ref: "user_42" },
    });

    const verify = await app.inject({
      method: "POST",
      url: "/v1/webauthn/register/verify",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { client_ref: "user_42", response: { id: FAKE_CRED_ID } },
    });
    assert.equal(verify.statusCode, 200);
    assert.equal(verify.json().credential_id, FAKE_CRED_ID);

    const creds = await dbq<CredentialRow>(
      `SELECT id, app_id, client_ref, credential_id_hash, sign_count, last_used_at
       FROM webauthn_credentials WHERE app_id = $1`,
      [fx.appId],
    );
    assert.equal(creds.length, 1);
    assert.equal(creds[0]!.client_ref, "user_42");
    assert.equal(creds[0]!.sign_count, 0);
    assert.equal(creds[0]!.last_used_at, null);
    // The DB stores the hash, not the raw id.
    assert.notEqual(creds[0]!.credential_id_hash, FAKE_CRED_ID);
    assert.match(creds[0]!.credential_id_hash, /^[0-9a-f]{64}$/);
  });

  // ----- WA6: challenge is single-use --------------------------------

  it("WA6: replaying the same challenge twice → 400 challenge_invalid on the second", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    webauthnTesting.setVerifier({
      verifyRegistrationResponse: async () => fakeRegistrationVerified() as never,
    });

    await app.inject({
      method: "POST",
      url: "/v1/webauthn/register/options",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { client_ref: "user_42" },
    });
    const first = await app.inject({
      method: "POST",
      url: "/v1/webauthn/register/verify",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { client_ref: "user_42", response: { id: FAKE_CRED_ID } },
    });
    assert.equal(first.statusCode, 200);

    const second = await app.inject({
      method: "POST",
      url: "/v1/webauthn/register/verify",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { client_ref: "user_42", response: { id: FAKE_CRED_ID } },
    });
    assert.equal(second.statusCode, 400);
    assert.equal(second.json().error.code, "challenge_invalid");
  });

  // ----- WA7: expired challenge → 400 --------------------------------

  it("WA7: expired challenge → 400 challenge_invalid", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    webauthnTesting.setVerifier({
      verifyRegistrationResponse: async () => fakeRegistrationVerified() as never,
    });

    await app.inject({
      method: "POST",
      url: "/v1/webauthn/register/options",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { client_ref: "user_42" },
    });
    // Force the challenge into the past.
    await dbq(
      `UPDATE webauthn_challenges SET expires_at = now() - interval '1 second'
       WHERE app_id = $1`,
      [fx.appId],
    );

    const verify = await app.inject({
      method: "POST",
      url: "/v1/webauthn/register/verify",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { client_ref: "user_42", response: { id: FAKE_CRED_ID } },
    });
    assert.equal(verify.statusCode, 400);
    assert.equal(verify.json().error.code, "challenge_invalid");
  });

  // ----- WA8: login bumps sign_count + last_used_at -------------------

  it("WA8: login/verify happy path bumps sign_count + last_used_at", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    webauthnTesting.setVerifier({
      verifyRegistrationResponse: async () => fakeRegistrationVerified() as never,
      verifyAuthenticationResponse: async () => fakeAuthenticationVerified(7) as never,
    });

    // Register once so a credential row exists.
    await app.inject({
      method: "POST",
      url: "/v1/webauthn/register/options",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { client_ref: "user_42" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/webauthn/register/verify",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { client_ref: "user_42", response: { id: FAKE_CRED_ID } },
    });

    // Now login.
    await app.inject({
      method: "POST",
      url: "/v1/webauthn/login/options",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { client_ref: "user_42" },
    });
    const login = await app.inject({
      method: "POST",
      url: "/v1/webauthn/login/verify",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { client_ref: "user_42", response: { id: FAKE_CRED_ID } },
    });
    assert.equal(login.statusCode, 200);
    assert.equal(login.json().verified, true);

    const creds = await dbq<CredentialRow>(
      `SELECT id, sign_count, last_used_at FROM webauthn_credentials WHERE app_id = $1`,
      [fx.appId],
    );
    assert.equal(creds[0]!.sign_count, 7);
    assert.ok(creds[0]!.last_used_at !== null, "last_used_at should be stamped");
  });

  // ----- WA9: login for unknown credential → 404 ---------------------

  it("WA9: login/verify for an unregistered credential id → 404", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();

    await app.inject({
      method: "POST",
      url: "/v1/webauthn/login/options",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { client_ref: "user_42" },
    });
    const r = await app.inject({
      method: "POST",
      url: "/v1/webauthn/login/verify",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { client_ref: "user_42", response: { id: FAKE_CRED_ID } },
    });
    assert.equal(r.statusCode, 404);
  });

  // ----- WA10: raw challenge never appears in logs --------------------

  it("WA10: the raw challenge bytes never appear in any log line", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();

    startCapture();
    let logs: string[] = [];
    try {
      const opts = (
        await app.inject({
          method: "POST",
          url: "/v1/webauthn/register/options",
          headers: { authorization: `Bearer ${fx.secretKey}` },
          payload: { client_ref: "user_42" },
        })
      ).json();
      const challenge = String(opts.challenge);
      assert.ok(challenge.length > 0);

      // Hammer some additional flows to give the logger plenty to chew on.
      await app.inject({
        method: "POST",
        url: "/v1/webauthn/login/options",
        headers: { authorization: `Bearer ${fx.secretKey}` },
        payload: { client_ref: "user_42" },
      });

      logs = stopCapture();
      for (const line of logs) {
        assert.ok(
          !line.includes(challenge),
          `raw challenge must NOT appear in any log line; saw it in: ${line.slice(0, 200)}`,
        );
      }
    } finally {
      // stopCapture is idempotent-ish: only restore if we own it.
      if (logs.length === 0) stopCapture();
    }
  });

  // ----- WA11: library reports verify failure → 400 -------------------

  it("WA11: library reports verified=false → 400 attestation_failed", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    webauthnTesting.setVerifier({
      verifyRegistrationResponse: async () => ({ verified: false } as never),
    });

    await app.inject({
      method: "POST",
      url: "/v1/webauthn/register/options",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { client_ref: "user_42" },
    });
    const r = await app.inject({
      method: "POST",
      url: "/v1/webauthn/register/verify",
      headers: { authorization: `Bearer ${fx.secretKey}` },
      payload: { client_ref: "user_42", response: { id: FAKE_CRED_ID } },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error.code, "attestation_failed");
  });
});

describe("webauthn fallback — disabled", () => {
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

  // ----- WA1: routes 404 when WEBAUTHN_ENABLED is false ---------------

  it("WA1: WEBAUTHN_ENABLED=false unmounts every /v1/webauthn/* route", async () => {
    const prev = process.env.WEBAUTHN_ENABLED;
    process.env.WEBAUTHN_ENABLED = "false";
    try {
      testApp = await buildApp();
      await testApp.ready();
      for (const path of [
        "/v1/webauthn/register/options",
        "/v1/webauthn/register/verify",
        "/v1/webauthn/login/options",
        "/v1/webauthn/login/verify",
      ]) {
        const r = await testApp.inject({ method: "POST", url: path, payload: {} });
        assert.equal(r.statusCode, 404, `path ${path} should be 404 when disabled`);
      }
    } finally {
      if (prev !== undefined) process.env.WEBAUTHN_ENABLED = prev;
      else delete process.env.WEBAUTHN_ENABLED;
    }
  });
});
