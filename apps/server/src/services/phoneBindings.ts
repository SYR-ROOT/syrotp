/**
 * Phone-binding ceremony — v0.8 PR #36.
 *
 * A `phone_binding` row records that a phone number has proven (via
 * an SMS round-trip from the gateway) that it controls the SIM at
 * the time of binding. v0.8 PR #37 will turn the existence of a
 * `verified` row into a HARD prerequisite for `startVerification`.
 *
 * This file ships only the ceremony machinery — the existing
 * `startVerification` path is intentionally untouched in PR #36.
 *
 * Lifecycle (see also `migrations/0005_phone_bindings.sql`):
 *   - `pending`  created by `startBinding(...)`. Single-use nonce,
 *                TTL'd `expires_at`.
 *   - `verified` flipped by `consumeBindNonce(...)` when an inbound
 *                SMS carries `BIND <nonce>` from the claimed phone
 *                within the TTL on the same receiver.
 *   - `revoked`  flipped by `revokeBinding(...)`. Soft delete; the
 *                row stays for history. PR #37 will treat `revoked`
 *                the same as no row (verification rejected).
 */
import { and, eq, gt, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { db, schema } from "../db/index.js";
import { ApiError, badRequest, conflict, notFound } from "../lib/errors.js";
import { newId, PHONE_BINDING_PREFIX } from "../lib/ids.js";
import { normalizePhone } from "../lib/phone.js";

export type PhoneBindingStatus = "pending" | "verified" | "revoked";

export interface PhoneBinding {
  id: string;
  app_id: string;
  receiver_id: string;
  phone_e164: string;
  status: PhoneBindingStatus;
  expires_at: string;
  bound_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface StartBindingInput {
  appId: string;
  receiverId: string;
  /** As supplied by the developer; will be normalized to E.164. */
  phone: string;
}

export interface StartBindingResult {
  binding: PhoneBinding;
  /** The receiver's msisdn the SMS must be addressed to. */
  send_to: string;
  /** The exact body the user must SMS — `BIND <nonce>`. */
  bind_message: string;
}

/**
 * Generate a 24-character base32-ish nonce. Avoids `0`/`O`/`1`/`I`
 * confusion for a user typing the SMS by hand if the gateway's
 * autofill misfires. 120 bits of entropy.
 */
function generateNonce(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(24);
  let out = "";
  for (let i = 0; i < 24; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

/**
 * Create a new pending binding. The developer's gateway operator
 * then sends `BIND <nonce>` from the claimed phone to the
 * receiver's msisdn within the TTL window.
 *
 * Multiple pending bindings for the same `(app_id, phone_e164)`
 * are permitted — the developer can retry without manually
 * cleaning up. The active-uniqueness invariant is enforced only
 * on `verified` rows (partial unique index in migration 0005).
 */
export async function startBinding(
  input: StartBindingInput,
): Promise<StartBindingResult> {
  const phoneE164 = normalizePhone(input.phone, config.DEFAULT_PHONE_REGION).e164;

  // Verify the receiver belongs to this app — otherwise an attacker
  // with one app's sk_live could pin a binding to another app's
  // receiver, which is structurally meaningless but would clutter the
  // table and confuse abuse signals.
  const receiver = await db
    .select({
      id: schema.receivers.id,
      msisdn: schema.receivers.msisdn,
      enabled: schema.receivers.enabled,
    })
    .from(schema.receivers)
    .where(
      and(
        eq(schema.receivers.id, input.receiverId),
        eq(schema.receivers.appId, input.appId),
      ),
    )
    .limit(1);

  const r = receiver[0];
  if (!r) throw notFound("receiver");
  if (!r.enabled) throw conflict("receiver_disabled", "receiver is disabled");

  // Deny if a verified binding already exists for this (app, phone).
  // The developer should `revoke` the old one explicitly before
  // creating a new one — silent overwrite would mask abuse.
  const existing = await db
    .select({ id: schema.phoneBindings.id })
    .from(schema.phoneBindings)
    .where(
      and(
        eq(schema.phoneBindings.appId, input.appId),
        eq(schema.phoneBindings.phoneE164, phoneE164),
        eq(schema.phoneBindings.status, "verified"),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    throw conflict(
      "already_bound",
      "phone is already verified-bound; revoke the existing binding first",
    );
  }

  const id = newId(PHONE_BINDING_PREFIX);
  const nonce = generateNonce();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.PHONE_BINDING_TTL_SECONDS * 1000);

  await db.insert(schema.phoneBindings).values({
    id,
    appId: input.appId,
    receiverId: input.receiverId,
    phoneE164,
    status: "pending",
    nonce,
    expiresAt,
  });

  return {
    binding: {
      id,
      app_id: input.appId,
      receiver_id: input.receiverId,
      phone_e164: phoneE164,
      status: "pending",
      expires_at: expiresAt.toISOString(),
      bound_at: null,
      revoked_at: null,
      created_at: now.toISOString(),
    },
    send_to: r.msisdn,
    bind_message: `BIND ${nonce}`,
  };
}

/** Public-facing fetch by id. App-scoped — sk_live keys can only
 * read their own bindings. */
export async function getBinding(
  appId: string,
  id: string,
): Promise<PhoneBinding> {
  const rows = await db
    .select()
    .from(schema.phoneBindings)
    .where(
      and(eq(schema.phoneBindings.id, id), eq(schema.phoneBindings.appId, appId)),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("phone_binding");
  return rowToPublic(row);
}

/** Soft-revoke. `verified` and `pending` rows can both be revoked
 * — revoking a pending row simply ends the ceremony. Already-revoked
 * rows are a no-op. */
export async function revokeBinding(
  appId: string,
  id: string,
): Promise<PhoneBinding> {
  const result = await db
    .update(schema.phoneBindings)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(
      and(
        eq(schema.phoneBindings.id, id),
        eq(schema.phoneBindings.appId, appId),
      ),
    )
    .returning();
  const row = result[0];
  if (!row) throw notFound("phone_binding");
  return rowToPublic(row);
}

export interface ConsumeBindNonceInput {
  /** Receiver that received the inbound SMS. */
  receiverId: string;
  /** Sender's phone, already normalized to E.164. */
  fromE164: string;
  /** Nonce extracted from the SMS body (the `<nonce>` half of `BIND <nonce>`). */
  nonce: string;
}

export type ConsumeBindNonceOutcome =
  | { matched: true; bindingId: string; appId: string }
  | { matched: false; reason: "no_match" | "expired" | "phone_mismatch" | "already_consumed" };

/**
 * Atomically promote a pending binding to verified, but only when:
 *   - the nonce matches a `pending` row,
 *   - that row's receiver matches the inbound's receiver (so a
 *     binding ceremony for one receiver can't be hijacked by an
 *     SMS forwarded by a different receiver),
 *   - the inbound's `from_e164` matches the binding's claimed phone,
 *   - `expires_at > now()`.
 *
 * Anything else → no match. Logs MUST NOT print the nonce — caller
 * is responsible for keeping it out of structured logs.
 */
export async function consumeBindNonce(
  input: ConsumeBindNonceInput,
): Promise<ConsumeBindNonceOutcome> {
  const serverNow = new Date();

  // Atomic: only flip pending → verified if all the conditions
  // hold. The conditional UPDATE eliminates a TOCTOU between the
  // existence check and the status flip.
  const claimed = await db
    .update(schema.phoneBindings)
    .set({ status: "verified", boundAt: serverNow })
    .where(
      and(
        eq(schema.phoneBindings.nonce, input.nonce),
        eq(schema.phoneBindings.status, "pending"),
        eq(schema.phoneBindings.receiverId, input.receiverId),
        eq(schema.phoneBindings.phoneE164, input.fromE164),
        gt(schema.phoneBindings.expiresAt, serverNow),
      ),
    )
    .returning();

  if (claimed.length > 0) {
    const row = claimed[0]!;
    return { matched: true, bindingId: row.id, appId: row.appId };
  }

  // Disambiguate the failure for callers that want metric labels.
  // We DO NOT leak this disambiguation back to the gateway — the
  // gateway response stays generic.
  const probe = await db
    .select({
      id: schema.phoneBindings.id,
      status: schema.phoneBindings.status,
      phoneE164: schema.phoneBindings.phoneE164,
      expiresAt: schema.phoneBindings.expiresAt,
      receiverId: schema.phoneBindings.receiverId,
    })
    .from(schema.phoneBindings)
    .where(eq(schema.phoneBindings.nonce, input.nonce))
    .limit(1);

  const p = probe[0];
  if (!p) return { matched: false, reason: "no_match" };
  if (p.status !== "pending") return { matched: false, reason: "already_consumed" };
  if (p.expiresAt <= serverNow) return { matched: false, reason: "expired" };
  if (p.receiverId !== input.receiverId || p.phoneE164 !== input.fromE164) {
    return { matched: false, reason: "phone_mismatch" };
  }
  // Shouldn't reach here — the original UPDATE would have matched.
  return { matched: false, reason: "no_match" };
}

/**
 * Extract the nonce from a `BIND <nonce>` SMS body. Returns null if
 * the body isn't a binding message (signaling to the inbound
 * matcher that it should fall through to the verification path).
 *
 * Tolerates the same surface noise as `extractCode`:
 *   "BIND ABC..."  → "ABC..."
 *   "bind abc"     → "ABC"
 *   "  BIND   X "  → "X"
 *   "BINDX"        → "X"  (no-space autocorrect)
 *
 * Does NOT fall through to VERIFY-handling on parse failure — a
 * message that LOOKS like BIND but doesn't carry a valid nonce
 * shape is REJECTED, not reinterpreted as a verify code. Otherwise
 * an attacker could craft "BIND" + a verify code lookalike and
 * blur the security model.
 */
export function extractBindNonce(body: string): string | null {
  if (typeof body !== "string") return null;
  const upper = body.trim().toUpperCase();
  if (!upper.startsWith("BIND")) return null;
  const tail = upper.slice("BIND".length).replace(/\s+/g, "");
  if (tail.length < 8 || tail.length > 64) return null;
  if (!/^[A-Z0-9]+$/.test(tail)) return null;
  return tail;
}

function rowToPublic(row: typeof schema.phoneBindings.$inferSelect): PhoneBinding {
  return {
    id: row.id,
    app_id: row.appId,
    receiver_id: row.receiverId,
    phone_e164: row.phoneE164,
    status: row.status as PhoneBindingStatus,
    expires_at: row.expiresAt.toISOString(),
    bound_at: row.boundAt ? row.boundAt.toISOString() : null,
    revoked_at: row.revokedAt ? row.revokedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  };
}

export { ApiError, badRequest };
