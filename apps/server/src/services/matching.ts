import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { newId, INBOUND_PREFIX } from "../lib/ids.js";
import { normalizePhone } from "../lib/phone.js";
import { config } from "../config.js";
import { metrics } from "./metrics.js";
import { consumeBindNonce, extractBindNonce } from "./phoneBindings.js";
import { buildVerificationEventData, emitVerificationEventInTx } from "./webhooks.js";

export interface MatchInput {
  receiverId: string;
  receiverMsisdn: string;
  from: string;
  to: string;
  body: string;
  receivedAt: Date;
  idempotencyKey: string;
}

export type MatchOutcome =
  | { stored: true; matched: true; verificationId: string; inboundId: string; kind?: undefined }
  | { stored: true; matched: true; bindingId: string; inboundId: string; kind: "binding" }
  | { stored: true; matched: false; reason: "no_match" | "expired" | "binding_no_match"; inboundId: string }
  | { stored: false; matched: false; reason: "duplicate"; inboundId: string };

/**
 * Extract the verification code from the SMS body.
 * Accepts:
 *   "VERIFY A7K9P2"
 *   "verify a7k9p2"
 *   "  VERIFY   A7K9P2  "
 *   "VERIFYA7K9P2"  (no space — common autocorrect glitch)
 *
 * Returns the canonicalized code (uppercase, no whitespace) or null.
 */
export function extractCode(body: string, prefix = "VERIFY"): string | null {
  if (typeof body !== "string") return null;
  const upper = body.trim().toUpperCase();
  if (!upper.startsWith(prefix.toUpperCase())) return null;
  const tail = upper.slice(prefix.length).replace(/\s+/g, "");
  if (tail.length < 4 || tail.length > 32) return null;
  if (!/^[A-Z0-9]+$/.test(tail)) return null;
  return tail;
}

/**
 * Process an inbound SMS: store it (idempotent), try to match it to a
 * pending verification, and update both records atomically.
 *
 * Idempotency: (receiver_id, idempotency_key) is unique. A duplicate POST
 * yields the original outcome without double-counting.
 */
export async function processInbound(input: MatchInput): Promise<MatchOutcome> {
  // Normalize sender for stable matching. If parsing fails, store the raw
  // value so it's auditable, but it can never match (no valid pending row
  // is keyed off a malformed sender).
  let fromE164: string;
  try {
    fromE164 = normalizePhone(input.from, config.DEFAULT_PHONE_REGION).e164;
  } catch {
    fromE164 = input.from.slice(0, 32);
  }

  // Try the BIND prefix FIRST (v0.8 PR #36). If the body looks
  // like a binding message but its nonce is malformed, we
  // deliberately do NOT fall through to the verify path — a
  // half-broken "BIND XXX" shouldn't be reinterpreted as a verify
  // code, otherwise an attacker could blur the security model by
  // crafting messages that look like one thing and get matched as
  // another.
  const bindNonce = extractBindNonce(input.body);
  const code = bindNonce === null ? extractCode(input.body) : null;
  const inboundId = newId(INBOUND_PREFIX);

  // Try insert; if dup on idempotency, fetch the existing row and return.
  try {
    await db.insert(schema.inboundSms).values({
      id: inboundId,
      receiverId: input.receiverId,
      fromE164,
      toMsisdn: input.to,
      body: input.body.slice(0, 1600),
      receivedAt: input.receivedAt,
      idempotencyKey: input.idempotencyKey,
    });
  } catch (err) {
    // Unique violation => already stored.
    const existing = await db
      .select({
        id: schema.inboundSms.id,
        matchedVerificationId: schema.inboundSms.matchedVerificationId,
      })
      .from(schema.inboundSms)
      .where(
        and(
          eq(schema.inboundSms.receiverId, input.receiverId),
          eq(schema.inboundSms.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    const prior = existing[0];
    if (prior) {
      return { stored: false, matched: false, reason: "duplicate", inboundId: prior.id };
    }
    throw err;
  }

  // BIND <nonce> branch — phone-binding ceremony (v0.8 PR #36).
  // Promotes a pending phone_binding row to verified when the
  // sender + receiver + nonce + TTL all match.
  if (bindNonce !== null) {
    const outcome = await consumeBindNonce({
      receiverId: input.receiverId,
      fromE164,
      nonce: bindNonce,
    });
    if (outcome.matched) {
      // Annotate the inbound row so audit / metrics can tell
      // which binding this SMS verified. The schema column is
      // named `matched_verification_id` — for BIND messages it
      // points at the binding row. The column is opaque text;
      // future schema work can split it if needed.
      await db
        .update(schema.inboundSms)
        .set({ matchedVerificationId: outcome.bindingId })
        .where(eq(schema.inboundSms.id, inboundId));
      return {
        stored: true,
        matched: true,
        bindingId: outcome.bindingId,
        inboundId,
        kind: "binding",
      };
    }
    return { stored: true, matched: false, reason: "binding_no_match", inboundId };
  }

  if (!code) {
    return { stored: true, matched: false, reason: "no_match", inboundId };
  }

  // Match against a pending, non-expired verification on this receiver, for
  // this exact code, where the sender's phone matches. We require ALL of:
  //   - same receiver (so codes never cross receivers)
  //   - sender matches the phone the developer asked us to verify
  //   - status pending AND expires_at > server-now
  //
  // SECURITY: we compare against the SERVER clock, not the gateway-supplied
  // received_at. A compromised gateway must not be able to backdate a late
  // SMS to revive an expired verification.
  //
  // The atomic UPDATE guarantees only one inbound can claim a given
  // verification — eliminates a TOCTOU race where two SMS arrive close
  // together.
  //
  // v1.x FIX 6 — Single-row claim. The UPDATE targets exactly one row
  // by picking it via a single-row sub-SELECT (LIMIT 1 + FOR UPDATE
  // SKIP LOCKED). This is defense-in-depth against the (now schema-
  // prevented) case where two pending verifications could share
  // (receiver_id, phone_e164, code) and the matcher would otherwise
  // flip BOTH and silently drop the second one (webhook delivery only
  // reads claimed[0]). The partial unique index
  // `verifications_pending_uniq` (migration 0006) makes the collision
  // a 23505 at insert time, so the multi-row case cannot legitimately
  // occur — but the explicit LIMIT 1 plus the post-condition assert
  // below means that even if the index is missing (e.g. an operator
  // skipped the migration), no inbound can ever claim more than one
  // verification.
  //
  // FOR UPDATE SKIP LOCKED avoids head-of-line blocking when two
  // inbound SMS for two DIFFERENT verifications happen to scan the
  // same index region; we'd rather a concurrent flow skip a locked
  // row and pick a different match than block on it.
  //
  // Wrapped in a transaction so the claim, the matching webhook event,
  // and the inbound→verification back-link land atomically. A
  // verified-without-event row (or an event-without-verified-row)
  // can never appear.
  const serverNow = new Date();
  const verifiedRow = await db.transaction(async (tx) => {
    const claimed = await tx
      .update(schema.verifications)
      .set({
        status: "verified",
        verifiedAt: serverNow,
        matchedInboundId: inboundId,
        attempts: sql`${schema.verifications.attempts} + 1`,
      })
      .where(
        sql`${schema.verifications.id} = (
          SELECT ${schema.verifications.id}
          FROM ${schema.verifications}
          WHERE ${schema.verifications.receiverId} = ${input.receiverId}
            AND ${schema.verifications.phoneE164} = ${fromE164}
            AND ${schema.verifications.code} = ${code}
            AND ${schema.verifications.status} = 'pending'
            AND ${schema.verifications.expiresAt} > ${serverNow.toISOString()}::timestamptz
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )`,
      )
      .returning();

    if (claimed.length === 0) return null;
    // Belt-and-braces: the LIMIT 1 sub-SELECT + the partial unique
    // index together make this unreachable. If we ever see >1 rows
    // claimed it means BOTH defenses have failed and a downstream
    // verifier silently dropped a verification — page the on-call.
    if (claimed.length > 1) {
      metrics.matchingInvariantViolated();
    }
    const row = claimed[0]!;

    await emitVerificationEventInTx(
      tx,
      "verification.verified",
      row.appId,
      buildVerificationEventData(row, "verification.verified"),
    );

    await tx
      .update(schema.inboundSms)
      .set({ matchedVerificationId: row.id })
      .where(eq(schema.inboundSms.id, inboundId));

    return row;
  });

  if (!verifiedRow) {
    // No pending+matching row. Could be: wrong code, wrong sender, expired,
    // or already verified. Don't leak which.
    await db
      .update(schema.inboundSms)
      .set({ matchedVerificationId: null })
      .where(eq(schema.inboundSms.id, inboundId));
    return { stored: true, matched: false, reason: "no_match", inboundId };
  }

  return { stored: true, matched: true, verificationId: verifiedRow.id, inboundId };
}
