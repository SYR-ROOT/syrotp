/**
 * Test fixtures: insert apps, keys, receivers via the same code paths the
 * production bootstrap script uses, so tests exercise the real wrap/hash
 * primitives and not a parallel implementation.
 */
import { db, schema } from "../../src/db/index.js";
import { config } from "../../src/config.js";
import { generateApiKey, generateNonce, hashSecret } from "../../src/lib/crypto.js";
import {
  newId,
  APP_PREFIX,
  API_KEY_PREFIX,
  PHONE_BINDING_PREFIX,
  RECEIVER_PREFIX,
} from "../../src/lib/ids.js";
import { wrapGatewaySigningKey } from "../../src/services/hmac.js";

export interface TestApp {
  appId: string;
  publicKey: string;
  secretKey: string;
  receiverId: string;
  receiverMsisdn: string;
  signingKey: string; // raw — what the gateway holds
}

export async function createTestApp(opts: {
  name?: string;
  msisdn?: string;
  /** Operator label for the bootstrap receiver. Used by multi-receiver tests. */
  receiverOperator?: string | null;
  receiverEnabled?: boolean;
  withHeartbeat?: boolean;
  /**
   * Auto-seed a `verified` phone-binding for the given phone (E.164)
   * so v0.8 PR #37's hard invariant is satisfied for the dominant
   * test phone without every suite having to wire the ceremony
   * manually. Default `"+963991234567"` covers ~90% of suites.
   *
   * Pass `null` to skip the auto-seed — used by the phone-binding
   * suites that exercise the ceremony directly (PR #36 PB tests,
   * PR #37 PE tests).
   */
  seedBoundPhone?: string | null;
} = {}): Promise<TestApp> {
  const appId = newId(APP_PREFIX);
  await db.insert(schema.apps).values({ id: appId, name: opts.name ?? "Test App" });

  const pk = generateApiKey("pk_live");
  const sk = generateApiKey("sk_live");
  await db.insert(schema.apiKeys).values([
    {
      id: newId(API_KEY_PREFIX),
      appId,
      kind: "public",
      keyHash: hashSecret("api_key", config.MASTER_ENCRYPTION_KEY, pk),
      keyPrefix: pk.slice(0, 12),
      label: "test-public",
    },
    {
      id: newId(API_KEY_PREFIX),
      appId,
      kind: "secret",
      keyHash: hashSecret("api_key", config.MASTER_ENCRYPTION_KEY, sk),
      keyPrefix: sk.slice(0, 12),
      label: "test-secret",
    },
  ]);

  const receiverId = newId(RECEIVER_PREFIX);
  const signingKey = generateNonce(32);
  const wrapped = wrapGatewaySigningKey(signingKey, receiverId);
  await db.insert(schema.receivers).values({
    id: receiverId,
    appId,
    name: "Test Receiver",
    msisdn: opts.msisdn ?? "+963998887777",
    operator: opts.receiverOperator ?? null,
    secretHash: wrapped,
    enabled: opts.receiverEnabled ?? true,
    lastHeartbeatAt: opts.withHeartbeat === false ? null : new Date(),
  });

  // v0.8 PR #37 — auto-seed a verified phone-binding for the
  // dominant test phone unless the caller explicitly opts out.
  // The ceremony machinery itself (PR #36) is exercised by the PB
  // tests, which pass `seedBoundPhone: null` to opt out.
  const seedPhone =
    opts.seedBoundPhone === null ? null : (opts.seedBoundPhone ?? "+963991234567");
  if (seedPhone) {
    await seedVerifiedBinding({ appId, receiverId, phoneE164: seedPhone });
  }

  return {
    appId,
    publicKey: pk,
    secretKey: sk,
    receiverId,
    receiverMsisdn: opts.msisdn ?? "+963998887777",
    signingKey,
  };
}

/**
 * Insert a `verified` phone-binding row directly. Bypasses the
 * BIND-SMS ceremony — for tests that need the binding to exist
 * without exercising the ceremony itself.
 */
export async function seedVerifiedBinding(opts: {
  appId: string;
  receiverId: string;
  phoneE164: string;
}): Promise<string> {
  const id = newId(PHONE_BINDING_PREFIX);
  await db.insert(schema.phoneBindings).values({
    id,
    appId: opts.appId,
    receiverId: opts.receiverId,
    phoneE164: opts.phoneE164,
    status: "verified",
    nonce: "test-seed-" + generateNonce(8),
    expiresAt: new Date(Date.now() + 60 * 60_000),
    boundAt: new Date(),
  });
  return id;
}

export interface ExtraReceiver {
  receiverId: string;
  msisdn: string;
  signingKey: string;
}

/**
 * Add a second-or-later receiver to an existing app. Used by the
 * multi-receiver routing tests to set up an operator-aware fleet.
 */
export async function addReceiver(
  appId: string,
  opts: {
    msisdn: string;
    operator?: string | null;
    enabled?: boolean;
    withHeartbeat?: boolean;
    name?: string;
  },
): Promise<ExtraReceiver> {
  const receiverId = newId(RECEIVER_PREFIX);
  const signingKey = generateNonce(32);
  const wrapped = wrapGatewaySigningKey(signingKey, receiverId);
  await db.insert(schema.receivers).values({
    id: receiverId,
    appId,
    name: opts.name ?? `Test Receiver ${opts.msisdn}`,
    msisdn: opts.msisdn,
    operator: opts.operator ?? null,
    secretHash: wrapped,
    enabled: opts.enabled ?? true,
    lastHeartbeatAt: opts.withHeartbeat === false ? null : new Date(),
  });
  return { receiverId, msisdn: opts.msisdn, signingKey };
}

/**
 * Create just an extra gateway key (for tests that need a `gw_live` key).
 */
export async function createGatewayKey(appId: string): Promise<string> {
  const gk = generateApiKey("gw_live");
  await db.insert(schema.apiKeys).values({
    id: newId(API_KEY_PREFIX),
    appId,
    kind: "gateway",
    keyHash: hashSecret("api_key", config.MASTER_ENCRYPTION_KEY, gk),
    keyPrefix: gk.slice(0, 12),
    label: "test-gateway",
  });
  return gk;
}
