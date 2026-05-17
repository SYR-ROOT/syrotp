import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { config } from "../config.js";
import { hmacSha256Hex, safeEqual, sha256Hex } from "../lib/crypto.js";
import { unwrap, wrap } from "../lib/aead.js";
import { redis } from "../lib/redis.js";

export interface VerifyHmacInput {
  receiverId: string;
  timestampHeader: string;
  nonceHeader: string;
  signatureHeader: string;
  rawBody: Buffer;
}

export type VerifyHmacResult =
  | { ok: true; receiver: { id: string; appId: string; msisdn: string } }
  | { ok: false; reason: string };

/**
 * Verify an inbound gateway request's HMAC signature.
 *
 * Threat model:
 *   - Attacker captures a valid signed request → wants to replay or forge.
 *   - We require timestamp + nonce + body hash in the signed payload, plus
 *     a short skew window, plus a one-time nonce check in Redis.
 *
 * Signature input: "<timestamp>.<nonce>.<sha256(body)>"
 *   - body sha256 binds the signature to these exact bytes
 *   - timestamp binds it to a specific moment (skew window)
 *   - nonce binds it to a specific request (single-use)
 *
 * At-rest protection:
 *   - The signing key column stores AES-256-GCM(MASTER_KEY, signing_key,
 *     aad="receiver:<id>"). A DB-only breach yields ciphertext that
 *     cannot be used without the master key (kept in env / secret manager).
 *   - The AAD ties the ciphertext to its row id, so swapping rows fails.
 */
export async function verifyGatewayHmac(input: VerifyHmacInput): Promise<VerifyHmacResult> {
  const { receiverId, timestampHeader, nonceHeader, signatureHeader, rawBody } = input;

  if (!/^rcv_[A-Za-z0-9]+$/.test(receiverId)) return { ok: false, reason: "bad_receiver_id" };
  if (!/^[0-9a-f]{32,128}$/i.test(nonceHeader)) return { ok: false, reason: "bad_nonce" };
  if (!/^[0-9a-f]{64}$/i.test(signatureHeader)) return { ok: false, reason: "bad_signature_format" };

  const ts = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad_timestamp" };
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > config.INBOUND_TIMESTAMP_SKEW_SECONDS) {
    return { ok: false, reason: "timestamp_skew" };
  }

  const rows = await db
    .select({
      id: schema.receivers.id,
      appId: schema.receivers.appId,
      msisdn: schema.receivers.msisdn,
      secretWrapped: schema.receivers.secretHash,
      enabled: schema.receivers.enabled,
    })
    .from(schema.receivers)
    .where(eq(schema.receivers.id, receiverId))
    .limit(1);

  const receiver = rows[0];
  if (!receiver || !receiver.enabled) return { ok: false, reason: "unknown_receiver" };

  // Decrypt the signing key. AAD binds it to this exact row id.
  let signingKey: string;
  try {
    signingKey = unwrap(
      config.MASTER_ENCRYPTION_KEY,
      receiver.secretWrapped,
      `receiver:${receiver.id}`,
    );
  } catch {
    // Either tampered, wrong master key, or stored under a different aad.
    return { ok: false, reason: "key_unavailable" };
  }

  const bodyHash = sha256Hex(rawBody);
  const payload = `${ts}.${nonceHeader}.${bodyHash}`;
  const expected = hmacSha256Hex(signingKey, payload);
  if (!safeEqual(expected, signatureHeader)) return { ok: false, reason: "bad_signature" };

  // Replay guard: a nonce can only be used once within the skew window.
  // SET NX with TTL gives us atomic "first writer wins."
  const nonceKey = `syrotp:nonce:${receiverId}:${nonceHeader}`;
  const set = await redis.set(nonceKey, "1", "EX", config.INBOUND_TIMESTAMP_SKEW_SECONDS, "NX");
  if (set !== "OK") return { ok: false, reason: "replay" };

  return {
    ok: true,
    receiver: { id: receiver.id, appId: receiver.appId, msisdn: receiver.msisdn },
  };
}

/**
 * Wrap a fresh signing key for storage. Called once per receiver at
 * provisioning time; the raw value is handed to the gateway and forgotten
 * by the server.
 */
export function wrapGatewaySigningKey(rawKey: string, receiverId: string): string {
  return wrap(config.MASTER_ENCRYPTION_KEY, rawKey, `receiver:${receiverId}`);
}
