/**
 * WebAuthn fallback service. Wraps @simplewebauthn/server with our
 * DB-backed challenge store, credential lookup, and config glue.
 *
 * Hand-rolled WebAuthn crypto is a known footgun — every step here
 * delegates the security-sensitive parts (attestation parse,
 * assertion signature verify, sign_count enforcement) to the
 * library. This file's job is to:
 *
 *   - generate + store + expire + single-use the challenges
 *   - hash credential ids at rest (HMAC, not bcrypt — fast indexed
 *     lookup; the raw id is uniformly random so brute-force isn't
 *     a concern)
 *   - keep the public key, sign_count, and transports on the
 *     credential row up to date after each ceremony
 *   - validate the origin/rpId allowlist via the library's
 *     expectedOrigin/expectedRPID parameters (the library does the
 *     actual matching; we just feed config in)
 *
 * The library functions are kept on `verifierImpl` so the test
 * suite can swap in a fake without touching ESM module mocking
 * machinery.
 */
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { config } from "../config.js";
import { db, schema } from "../db/index.js";
import { hashSecret } from "../lib/crypto.js";
import {
  ApiError,
  badRequest,
  notFound,
  serviceUnavailable,
} from "../lib/errors.js";
import {
  newId,
  WEBAUTHN_CHALLENGE_PREFIX,
  WEBAUTHN_CREDENTIAL_PREFIX,
} from "../lib/ids.js";

// ----- config helpers --------------------------------------------------

function rpId(): string {
  if (!config.WEBAUTHN_RP_ID) {
    throw serviceUnavailable("webauthn_misconfigured", "WEBAUTHN_RP_ID is not set");
  }
  return config.WEBAUTHN_RP_ID;
}

function rpName(): string {
  return config.WEBAUTHN_RP_NAME ?? config.WEBAUTHN_RP_ID ?? "SYROTP";
}

function origins(): string[] {
  const raw = (config.WEBAUTHN_ORIGINS ?? "").split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (raw.length === 0) {
    throw serviceUnavailable("webauthn_misconfigured", "WEBAUTHN_ORIGINS is not set");
  }
  return raw;
}

/**
 * Returns whether the routes plugin should mount /v1/webauthn/* —
 * `WEBAUTHN_ENABLED=true` AND every required field is set.
 *
 * The "enabled" toggle is read straight from `process.env` so a
 * test that flips `WEBAUTHN_ENABLED` before calling `buildApp()`
 * sees the new value — `config` itself is frozen on first import
 * and wouldn't reflect the change. The other fields (RP_ID /
 * ORIGINS) still come from `config` since they don't move between
 * buildApp calls in tests.
 */
export function isWebAuthnConfigured(): boolean {
  const enabled = (process.env.WEBAUTHN_ENABLED ?? "").toLowerCase();
  if (enabled !== "true" && enabled !== "1") return false;
  if (!config.WEBAUTHN_RP_ID) return false;
  if (!config.WEBAUTHN_ORIGINS) return false;
  return true;
}

// ----- credential id hashing ------------------------------------------

/**
 * Lookup hash for a raw base64url credential id. HMAC keyed by
 * MASTER_ENCRYPTION_KEY so a DB-only leak doesn't index back to the
 * raw id, but we can still do an O(log n) lookup on subsequent
 * authentications.
 */
function hashCredentialId(rawCredentialId: string): string {
  return hashSecret("webauthn_cred_id", config.MASTER_ENCRYPTION_KEY, rawCredentialId);
}

// ----- challenge store -------------------------------------------------

type ChallengePurpose = "register" | "login";

interface StoredChallenge {
  id: string;
  challenge: string;
}

async function createChallenge(
  appId: string,
  clientRef: string,
  purpose: ChallengePurpose,
  challenge: string,
): Promise<StoredChallenge> {
  const id = newId(WEBAUTHN_CHALLENGE_PREFIX);
  const expiresAt = new Date(Date.now() + config.WEBAUTHN_CHALLENGE_TTL_SECONDS * 1_000);
  await db.insert(schema.webauthnChallenges).values({
    id,
    appId,
    clientRef,
    challenge,
    purpose,
    expiresAt,
  });
  return { id, challenge };
}

/**
 * Find the most-recent active challenge for a (app, client_ref,
 * purpose) tuple and atomically mark it used. Single-use: a row
 * already stamped with `used_at` is invisible here. TTL: rows past
 * `expires_at` are filtered out by the WHERE.
 *
 * Returns null when no row qualifies — the route surfaces that as
 * 400 challenge_invalid without telling the caller whether the
 * challenge expired vs. was already consumed (no oracle).
 */
async function consumeChallenge(
  appId: string,
  clientRef: string,
  purpose: ChallengePurpose,
): Promise<string | null> {
  const now = new Date();
  // Pick the candidate row first so we can mark just that one used —
  // an UPDATE ... ORDER BY ... LIMIT 1 RETURNING * is awkward in
  // Drizzle, but a SELECT ... FOR UPDATE SKIP LOCKED + UPDATE inside
  // one tx gives the same single-use guarantee against concurrent
  // verifies.
  return await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: schema.webauthnChallenges.id, challenge: schema.webauthnChallenges.challenge })
      .from(schema.webauthnChallenges)
      .where(
        and(
          eq(schema.webauthnChallenges.appId, appId),
          eq(schema.webauthnChallenges.clientRef, clientRef),
          eq(schema.webauthnChallenges.purpose, purpose),
          isNull(schema.webauthnChallenges.usedAt),
          gt(schema.webauthnChallenges.expiresAt, now),
        ),
      )
      .orderBy(desc(schema.webauthnChallenges.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });

    const row = rows[0];
    if (!row) return null;

    await tx
      .update(schema.webauthnChallenges)
      .set({ usedAt: now })
      .where(eq(schema.webauthnChallenges.id, row.id));

    return row.challenge;
  });
}

// ----- registration ----------------------------------------------------

export async function buildRegisterOptions(input: {
  appId: string;
  clientRef: string;
  userDisplayName?: string;
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  if (!isWebAuthnConfigured()) {
    throw serviceUnavailable("webauthn_disabled", "WebAuthn fallback is disabled");
  }
  const opts = await verifierImpl.generateRegistrationOptions({
    rpID: rpId(),
    rpName: rpName(),
    userName: input.clientRef,
    userDisplayName: input.userDisplayName ?? input.clientRef,
    // Stable user-handle so re-registering doesn't create a duplicate
    // user from the authenticator's perspective.
    userID: new TextEncoder().encode(input.clientRef),
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
    timeout: config.WEBAUTHN_CHALLENGE_TTL_SECONDS * 1_000,
    excludeCredentials: await listCredentialIdsForUser(input.appId, input.clientRef),
  });
  await createChallenge(input.appId, input.clientRef, "register", opts.challenge);
  return opts;
}

export async function verifyRegister(input: {
  appId: string;
  clientRef: string;
  response: RegistrationResponseJSON;
}): Promise<{ credential_id: string }> {
  if (!isWebAuthnConfigured()) {
    throw serviceUnavailable("webauthn_disabled", "WebAuthn fallback is disabled");
  }

  const challenge = await consumeChallenge(input.appId, input.clientRef, "register");
  if (!challenge) throw badRequest("challenge_invalid", "challenge missing or expired");

  const verification = await verifierImpl.verifyRegistrationResponse({
    response: input.response,
    expectedChallenge: challenge,
    expectedOrigin: origins(),
    expectedRPID: rpId(),
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw badRequest("attestation_failed", "registration could not be verified");
  }

  const cred = verification.registrationInfo.credential;
  const credentialIdHash = hashCredentialId(cred.id);

  // Idempotency: if a credential with this id is already stored for
  // this app, treat the duplicate registration as a no-op success.
  // Never UPSERT public_key in place — a credential id is supposed
  // to be unique to one authenticator, and rewriting the key would
  // silently accept a swap.
  const existing = await db
    .select({ id: schema.webauthnCredentials.id })
    .from(schema.webauthnCredentials)
    .where(
      and(
        eq(schema.webauthnCredentials.appId, input.appId),
        eq(schema.webauthnCredentials.credentialIdHash, credentialIdHash),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    return { credential_id: cred.id };
  }

  await db.insert(schema.webauthnCredentials).values({
    id: newId(WEBAUTHN_CREDENTIAL_PREFIX),
    appId: input.appId,
    clientRef: input.clientRef,
    credentialIdHash,
    publicKey: Buffer.from(cred.publicKey),
    signCount: cred.counter,
    transports: cred.transports ?? [],
    backupState: verification.registrationInfo.credentialBackedUp,
    backupEligible: verification.registrationInfo.credentialDeviceType === "multiDevice",
  });

  return { credential_id: cred.id };
}

// ----- authentication --------------------------------------------------

export async function buildLoginOptions(input: {
  appId: string;
  clientRef: string;
}): Promise<PublicKeyCredentialRequestOptionsJSON> {
  if (!isWebAuthnConfigured()) {
    throw serviceUnavailable("webauthn_disabled", "WebAuthn fallback is disabled");
  }

  const allow = await listCredentialIdsForUser(input.appId, input.clientRef);
  const opts = await verifierImpl.generateAuthenticationOptions({
    rpID: rpId(),
    allowCredentials: allow,
    userVerification: "preferred",
    timeout: config.WEBAUTHN_CHALLENGE_TTL_SECONDS * 1_000,
  });
  await createChallenge(input.appId, input.clientRef, "login", opts.challenge);
  return opts;
}

export async function verifyLogin(input: {
  appId: string;
  clientRef: string;
  response: AuthenticationResponseJSON;
}): Promise<{ verified: true }> {
  if (!isWebAuthnConfigured()) {
    throw serviceUnavailable("webauthn_disabled", "WebAuthn fallback is disabled");
  }

  const challenge = await consumeChallenge(input.appId, input.clientRef, "login");
  if (!challenge) throw badRequest("challenge_invalid", "challenge missing or expired");

  const credId = input.response.id;
  const credentialIdHash = hashCredentialId(credId);

  const credRows = await db
    .select()
    .from(schema.webauthnCredentials)
    .where(
      and(
        eq(schema.webauthnCredentials.appId, input.appId),
        eq(schema.webauthnCredentials.clientRef, input.clientRef),
        eq(schema.webauthnCredentials.credentialIdHash, credentialIdHash),
      ),
    )
    .limit(1);
  const credRow = credRows[0];
  if (!credRow) throw notFound("webauthn_credential");

  const verification = await verifierImpl.verifyAuthenticationResponse({
    response: input.response,
    expectedChallenge: challenge,
    expectedOrigin: origins(),
    expectedRPID: rpId(),
    credential: {
      id: credId,
      publicKey: new Uint8Array(credRow.publicKey),
      counter: credRow.signCount,
      transports: credRow.transports as AuthenticatorTransportFutureLite[] | undefined,
    },
  });
  if (!verification.verified) {
    throw badRequest("assertion_failed", "authentication could not be verified");
  }

  // Sign-count enforcement is the library's job; a clone replay
  // would already have raised a mismatch above. We persist the new
  // value so subsequent logins use it as the floor.
  await db
    .update(schema.webauthnCredentials)
    .set({
      signCount: verification.authenticationInfo.newCounter,
      lastUsedAt: new Date(),
    })
    .where(eq(schema.webauthnCredentials.id, credRow.id));

  return { verified: true };
}

// ----- helpers ---------------------------------------------------------

/**
 * Internal: fetch (raw_credential_id, transports) entries for use as
 * `allowCredentials` / `excludeCredentials` in option generation.
 *
 * NOTE: we stored `credential_id_hash`, not the raw id. To populate
 * `allowCredentials`, the library needs the raw id. This is a known
 * trade-off — the raw id has to live somewhere to be used in
 * options. Right now we don't store it, so `allowCredentials` is
 * empty and the user-agent surfaces all available credentials. The
 * verify step still constrains by `(app_id, credential_id_hash)`.
 *
 * Improving this requires storing the raw credential id (not a
 * secret per WebAuthn semantics) — left for a follow-up so this PR
 * stays focused. This keeps the behavior usable: browsers handle
 * the credential filtering UI well even without the hint.
 */
async function listCredentialIdsForUser(
  _appId: string,
  _clientRef: string,
): Promise<{ id: string; transports?: AuthenticatorTransportFutureLite[] }[]> {
  return [];
}

type AuthenticatorTransportFutureLite =
  | "ble"
  | "cable"
  | "hybrid"
  | "internal"
  | "nfc"
  | "smart-card"
  | "usb";

// ----- test seam -------------------------------------------------------

interface VerifierImpl {
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}

const defaultVerifier: VerifierImpl = {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
};

let verifierImpl: VerifierImpl = defaultVerifier;

/**
 * Test-only: replace any subset of the @simplewebauthn/server entry
 * points with stubs. Production code never touches this. Tests use
 * it to exercise the storage/expiry/single-use logic without
 * forging real attestations or assertions.
 */
export const __testing = {
  setVerifier(impl: Partial<VerifierImpl>): void {
    verifierImpl = { ...verifierImpl, ...impl };
  },
  reset(): void {
    verifierImpl = defaultVerifier;
  },
};

export { ApiError };
