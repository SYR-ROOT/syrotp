import { and, eq, sql } from "drizzle-orm";
import { db, schema, type DB } from "../db/index.js";
import { type Tx } from "./webhooks.js";
import { config } from "../config.js";
import { generateCode } from "../lib/crypto.js";
import { newId, VERIFICATION_PREFIX } from "../lib/ids.js";
import {
  ApiError,
  badRequest,
  conflict,
  notFound,
  phoneNotBound,
  serviceUnavailable,
} from "../lib/errors.js";
import { maskPhone } from "../lib/phone.js";
import { metrics } from "./metrics.js";
import { buildVerificationEventData, emitVerificationEventInTx } from "./webhooks.js";

/**
 * Atomically transition a still-pending verification past its TTL
 * to `expired`, AND — only when this caller wins the race — emit
 * the matching webhook event in the same transaction.
 *
 * Designed for the `void lazyExpireAndEmit(...)` background pattern
 * used by the read paths: never await the result, never let an
 * error reach the read response. If the transition has already
 * happened (another request beat us to it), the event has already
 * been emitted by that caller — `.returning()` returns 0 rows here
 * and we simply do nothing.
 */
function lazyExpireAndEmit(verificationId: string): void {
  void db
    .transaction(async (tx) => {
      const result = await tx
        .update(schema.verifications)
        .set({ status: "expired" })
        .where(
          and(
            eq(schema.verifications.id, verificationId),
            eq(schema.verifications.status, "pending"),
          ),
        )
        .returning();
      if (result.length === 0) return;
      const row = result[0]!;
      await emitVerificationEventInTx(
        tx,
        "verification.expired",
        row.appId,
        buildVerificationEventData(row, "verification.expired"),
      );
    })
    .catch(() => {
      // Best-effort: a transient DB failure here just means the
      // next reader will try again. The verification stays pending
      // until somebody wins.
    });
}

export interface StartVerificationInput {
  appId: string;
  phoneE164: string;
  purpose: string;
  clientRef?: string;
  locale?: string;
  ip?: string;
  /**
   * Optional carrier hint (e.g. "syriatel", "mtn"). When set, the
   * router prefers a healthy receiver whose `operator` matches; if
   * none is available it falls back to any healthy receiver. The
   * preference is recorded as a single `syrotp_receiver_selected_total`
   * metric label, never as a high-cardinality value.
   */
  preferredOperator?: string;
}

export interface PublicVerification {
  id: string;
  status: "pending" | "verified" | "expired" | "cancelled" | "failed";
  phone_masked: string;
  send_to?: string;
  message?: string;
  client_ref?: string | null;
  purpose?: string;
  verified_at?: string;
  expires_at: string;
  created_at: string;
  attempts?: number;
}

/**
 * Pick a healthy receiver for this app. Health rules:
 *   - same app
 *   - enabled
 *   - heartbeat within RECEIVER_HEARTBEAT_TIMEOUT_SECONDS
 *   - least pending verifications first (rough load balance)
 *
 * When `preferredOperator` is given, the router runs the same query
 * narrowed to that operator first. If no healthy match exists for
 * the preferred operator, it falls back to any healthy receiver —
 * the user gets a working flow rather than a `no_receiver` 503 just
 * because their preferred carrier is offline.
 *
 * Returns the chosen receiver's snapshot details + whether the
 * preferred operator was honored, so the caller can stamp the right
 * value on the verification row + emit an honest metric label.
 */
type PickedReceiver = {
  id: string;
  msisdn: string;
  operator: string | null;
  /** "preferred" → honored a preference; "fallback" → preference set but no match;
   *  "none" → no preference was given. */
  match: "preferred" | "fallback" | "none";
};

async function pickReceiver(
  exec: DB | Tx,
  appId: string,
  preferredOperator?: string,
): Promise<PickedReceiver | null> {
  if (preferredOperator) {
    const preferred = await runHealthyReceiverQuery(exec, appId, preferredOperator);
    if (preferred) {
      return { ...preferred, match: "preferred" };
    }
  }
  const fallback = await runHealthyReceiverQuery(exec, appId, undefined);
  if (!fallback) return null;
  return {
    ...fallback,
    match: preferredOperator ? "fallback" : "none",
  };
}

async function runHealthyReceiverQuery(
  exec: DB | Tx,
  appId: string,
  operator: string | undefined,
): Promise<{ id: string; msisdn: string; operator: string | null } | null> {
  const rows = await exec.execute<{ id: string; msisdn: string; operator: string | null }>(sql`
    SELECT r.id, r.msisdn, r.operator
    FROM receivers r
    LEFT JOIN (
      SELECT receiver_id, COUNT(*)::int AS pending_count
      FROM verifications
      WHERE status = 'pending'
      GROUP BY receiver_id
    ) v ON v.receiver_id = r.id
    WHERE r.app_id = ${appId}
      AND r.enabled = true
      AND r.last_heartbeat_at IS NOT NULL
      AND r.last_heartbeat_at > now() - (${config.RECEIVER_HEARTBEAT_TIMEOUT_SECONDS} || ' seconds')::interval
      ${operator ? sql`AND r.operator = ${operator}` : sql``}
    ORDER BY COALESCE(v.pending_count, 0) ASC, r.created_at ASC
    LIMIT 1
  `);
  return rows[0] ?? null;
}

export async function startVerification(
  input: StartVerificationInput,
): Promise<PublicVerification & { send_to: string; message: string }> {
  // v0.8 PR #37 — HARD invariant: the caller must have a `verified`
  // phone-binding row for (app_id, phone_e164) BEFORE we accept any
  // verification request. The HMAC on inbound proves the gateway is
  // real; the binding proves the developer has shown the gateway can
  // receive an SMS from this specific phone. Without this check, a
  // dishonest gateway operator could fake the inbound's `from_e164`.
  //
  // No bypass. No feature flag. No metrics-only mode.
  // No soft warning. The rejection is 403 `phone_not_bound`.
  const bound = await db
    .select({ id: schema.phoneBindings.id })
    .from(schema.phoneBindings)
    .where(
      and(
        eq(schema.phoneBindings.appId, input.appId),
        eq(schema.phoneBindings.phoneE164, input.phoneE164),
        eq(schema.phoneBindings.status, "verified"),
      ),
    )
    .limit(1);
  if (bound.length === 0) {
    throw phoneNotBound();
  }

  // The count + insert below MUST be atomic with respect to concurrent
  // requests for the same (app, phone), otherwise two callers can both
  // read `count == MAX - 1`, both pass the gate, and both INSERT,
  // overshooting MAX_PENDING_PER_PHONE. The race exists in single-
  // process deployments too (Node yields the event loop between awaits)
  // and is amplified by v0.9 PR #41 multi-instance topology.
  //
  // Fix: wrap both in a transaction and take a Postgres advisory lock
  // keyed on (app_id, phone_e164). Granularity is per-(app,phone), so
  // different phones don't contend; the lock is released automatically
  // when the transaction commits or aborts. No schema change, no Redis
  // primitive, no leader election. (v0.9 PR #42.)
  //
  // Receiver pick happens INSIDE the lock so we don't waste a pick on a
  // request that turns out to be over the cap; the pick itself is read-
  // only so it doesn't extend the lock window meaningfully.
  //
  // v1.x FIX 6 — Code-collision retry. The partial unique index
  // `verifications_pending_uniq` (migration 0006) enforces that no
  // two pending rows share (receiver_id, phone_e164, code). A
  // collision is astronomically unlikely with the default 6-char
  // base-31 codes (~887M combinations) bounded by the per-(app,
  // phone) pending cap, but when it does happen the INSERT below
  // throws 23505. We catch it specifically on this index and retry
  // with a fresh code, up to MAX_CODE_COLLISION_RETRIES times,
  // before surfacing the error. The retry surrounds the whole
  // transaction because the doomed transaction must roll back before
  // we can try again — an INSERT inside a poisoned tx is a no-op.
  const id = newId(VERIFICATION_PREFIX);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.VERIFICATION_TTL_SECONDS * 1000);
  const messagePrefix = "VERIFY";
  const lockKey = `${input.appId}:${input.phoneE164}`;

  const txResult = await runWithCodeCollisionRetry((code) => db.transaction(async (tx) => {
    // Per-(app, phone) advisory lock — different phones don't contend.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
    `);

    // Cap concurrent pending verifications per (app, phone) — anti-enumeration
    // & abuse. The advisory lock above is keyed on (app_id, phone_e164), so
    // scoping the count to the same tenant is what makes the gate coherent:
    //
    //   - Without the appId predicate, MAX_PENDING_PER_PHONE would be a
    //     GLOBAL cap across every tenant that happens to use this phone.
    //     A noisy neighbor (or a deliberate attacker holding a single
    //     attacker-owned app) could exhaust the cap and DoS every other
    //     tenant trying to verify the same number. It would also leak
    //     a cross-tenant oracle: "is phone X currently in-flight in some
    //     OTHER app?" — exactly the kind of side-channel the per-tenant
    //     model is supposed to prevent.
    //
    //   - With the appId predicate, the cap is per (app, phone): tenants
    //     are isolated, the supporting `verifications_phone_idx`
    //     (phone_e164, status) plus the appId equality remains
    //     index-friendly, and the lock granularity (app_id, phone_e164)
    //     matches the count granularity exactly.
    const pendingForPhone = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.verifications)
      .where(
        and(
          eq(schema.verifications.appId, input.appId),
          eq(schema.verifications.phoneE164, input.phoneE164),
          eq(schema.verifications.status, "pending"),
        ),
      );
    const phonePending = pendingForPhone[0]?.count ?? 0;
    if (phonePending >= config.MAX_PENDING_PER_PHONE) {
      throw conflict("too_many_pending", "too many pending verifications for this phone");
    }

    const receiver = await pickReceiver(tx, input.appId, input.preferredOperator);
    if (!receiver) {
      throw serviceUnavailable("no_receiver", "no healthy receiver available");
    }

    // Snapshot the receiver's wire details so a future in-place update of
    // `receivers.msisdn` / `.operator` doesn't change what the user sees on
    // the hosted page after they've already read the SMS instructions.
    await tx.insert(schema.verifications).values({
      id,
      appId: input.appId,
      phoneE164: input.phoneE164,
      purpose: input.purpose,
      clientRef: input.clientRef,
      locale: input.locale,
      receiverId: receiver.id,
      receiverMsisdnSnapshot: receiver.msisdn,
      receiverOperatorSnapshot: receiver.operator,
      code,
      messagePrefix,
      status: "pending",
      expiresAt,
      createdIp: input.ip,
    });

    return { receiver, code };
  }));

  metrics.receiverSelected(txResult.receiver.match);
  const receiver = txResult.receiver;
  const code = txResult.code;

  return {
    id,
    status: "pending",
    phone_masked: maskPhone(input.phoneE164),
    send_to: receiver.msisdn,
    message: `${messagePrefix} ${code}`,
    client_ref: input.clientRef ?? null,
    purpose: input.purpose,
    expires_at: expiresAt.toISOString(),
    created_at: now.toISOString(),
    attempts: 0,
  };
}

/**
 * Maximum attempts to generate a non-colliding verification code
 * before giving up. With 6-char base-31 codes and the per-(app,
 * phone) pending cap, the per-attempt collision probability is on
 * the order of 1e-8, so even 3 retries gives a vanishing exhaustion
 * probability. The retry budget exists to bound worst-case latency
 * if an operator runs with shorter codes (config allows down to 4
 * chars) and a hot phone.
 */
const MAX_CODE_COLLISION_RETRIES = 3;

/**
 * Run an attempt with a freshly-generated verification code; if the
 * attempt fails with a 23505 unique violation on the partial index
 * `verifications_pending_uniq`, generate a new code and retry, up to
 * MAX_CODE_COLLISION_RETRIES times.
 *
 * Errors that are NOT this specific collision (including OTHER 23505
 * violations elsewhere on `verifications`) propagate unchanged so
 * they're never silently swallowed. The narrow match against the
 * index name is intentional — we never want a future unique
 * constraint elsewhere on this table to be hidden by the retry loop.
 */
async function runWithCodeCollisionRetry<T>(
  attempt: (code: string) => Promise<T>,
): Promise<T> {
  for (let i = 0; i < MAX_CODE_COLLISION_RETRIES; i++) {
    const code = generateCode(config.VERIFICATION_CODE_LENGTH);
    try {
      return await attempt(code);
    } catch (err) {
      if (!isPendingCodeCollision(err)) {
        throw err;
      }
      metrics.verificationCodeCollision("retried");
    }
  }
  metrics.verificationCodeCollision("exhausted");
  // 503 because the failure is a transient state-space pressure
  // problem, not a client error. We deliberately do NOT echo the
  // index name or row detail to the caller — that information
  // belongs in operator metrics, not on the wire.
  throw serviceUnavailable(
    "code_generation_collision",
    "could not allocate a unique verification code after multiple attempts; retry the request",
  );
}

/**
 * Did this error come from the partial unique index on pending
 * verifications? postgres-js exposes the SQLSTATE on `err.code` and
 * the index name on `err.constraint_name` for unique violations.
 */
function isPendingCodeCollision(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; constraint_name?: unknown };
  return e.code === "23505" && e.constraint_name === "verifications_pending_uniq";
}

/**
 * Public-facing view of a verification.
 * `kind === "public"` callers (frontend public key) get a leaner view that
 * never exposes the secret message contents after issuance.
 */
export async function getVerification(
  appId: string,
  id: string,
  kind: "public" | "secret",
): Promise<PublicVerification> {
  const rows = await db
    .select()
    .from(schema.verifications)
    .where(and(eq(schema.verifications.id, id), eq(schema.verifications.appId, appId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("verification");

  // Lazy-expire: if it was pending but past TTL, treat as expired —
  // and (only on the winning transition) emit the webhook event.
  let status = row.status;
  if (status === "pending" && row.expiresAt.getTime() <= Date.now()) {
    status = "expired";
    lazyExpireAndEmit(id);
  }

  const out: PublicVerification = {
    id: row.id,
    status,
    phone_masked: maskPhone(row.phoneE164),
    client_ref: row.clientRef,
    purpose: row.purpose,
    expires_at: row.expiresAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    attempts: row.attempts,
    ...(row.verifiedAt ? { verified_at: row.verifiedAt.toISOString() } : {}),
  };

  // Only secret keys ever see the receiver number again after creation;
  // public keys never get to learn which receiver was used after the fact.
  if (kind === "secret" && status === "pending") {
    // Note: re-emitting message is convenient but slightly increases blast
    // radius if a backend log leaks. Gate behind explicit secret-key access.
    // We do NOT re-emit `message` here on purpose; clients should remember it.
  }

  return out;
}

export async function cancelVerification(
  appId: string,
  id: string,
): Promise<PublicVerification> {
  // The state change and the matching webhook event live in one
  // transaction so a "cancelled" row without its event — or vice
  // versa — is impossible. Existence + not-pending checks share the
  // same tx so a concurrent lazy-expire can't race past us.
  await db.transaction(async (tx) => {
    const result = await tx
      .update(schema.verifications)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(
        and(
          eq(schema.verifications.id, id),
          eq(schema.verifications.appId, appId),
          eq(schema.verifications.status, "pending"),
        ),
      )
      .returning();

    if (result.length === 0) {
      const existing = await tx
        .select({ id: schema.verifications.id, status: schema.verifications.status })
        .from(schema.verifications)
        .where(and(eq(schema.verifications.id, id), eq(schema.verifications.appId, appId)))
        .limit(1);
      if (existing.length === 0) throw notFound("verification");
      throw conflict("not_pending", "verification is not pending");
    }

    const row = result[0]!;
    await emitVerificationEventInTx(
      tx,
      "verification.cancelled",
      row.appId,
      buildVerificationEventData(row, "verification.cancelled"),
    );
  });

  return getVerification(appId, id, "secret");
}

/**
 * Validate purpose: short, alphanumeric-ish. Reject control chars, newlines,
 * and anything that could be abused if reflected into UIs or logs.
 */
export function validatePurpose(p: string): void {
  if (!/^[a-zA-Z0-9_\-:.]{2,64}$/.test(p)) {
    throw badRequest("invalid_purpose", "purpose must be 2-64 chars matching [a-zA-Z0-9_-:.]");
  }
}

// ----- Hosted verification page -------------------------------------------

export interface HostedVerification {
  id: string;
  status: "pending" | "verified" | "expired" | "cancelled" | "failed";
  phone_masked: string;
  expires_at: string;
  created_at: string;
  verified_at: string | null;
  /** Receiver msisdn — only emitted while status === "pending". */
  send_to: string | null;
  /** "VERIFY <code>" — only emitted while status === "pending". */
  message: string | null;
}

export interface HostedVerificationStatus {
  status: "pending" | "verified" | "expired" | "cancelled" | "failed";
  expires_at: string;
  verified_at: string | null;
}

/**
 * Hosted-page lookup. Differs from `getVerification` in two important
 * ways: there's no `appId` scope (the URL-bearer is the auth), and the
 * receiver's send-to + the rendered "VERIFY <code>" message are
 * surfaced (only while pending) so the user can copy them and SMS
 * the code out.
 *
 * Returns `null` when no row matches — the caller maps to 404 without
 * leaking whether the id is malformed or simply unknown.
 *
 * The verification id is a ULID-style 128-bit identifier (regex-validated
 * `^vrf_[A-Za-z0-9]+$` at the route layer); enumeration is computationally
 * out of reach. Even if leaked, the worst case is the attacker learns the
 * masked phone, the receiver msisdn, and the OTP — none of which let them
 * impersonate the user, since the server still match-checks the inbound
 * SMS against the expected sender phone.
 */
export async function getHostedVerification(id: string): Promise<HostedVerification | null> {
  // Read both the at-start snapshot AND the live receivers join so
  // we can `?? `-fall-back to the join for old rows that were
  // created before migration 0003 added the snapshot columns. New
  // rows always have the snapshot populated; the join cost is
  // negligible (PK lookup) and keeps the read path uniform.
  const rows = await db
    .select({
      id: schema.verifications.id,
      status: schema.verifications.status,
      phoneE164: schema.verifications.phoneE164,
      expiresAt: schema.verifications.expiresAt,
      createdAt: schema.verifications.createdAt,
      verifiedAt: schema.verifications.verifiedAt,
      code: schema.verifications.code,
      messagePrefix: schema.verifications.messagePrefix,
      receiverMsisdnSnapshot: schema.verifications.receiverMsisdnSnapshot,
      receiverMsisdnJoined: schema.receivers.msisdn,
    })
    .from(schema.verifications)
    .leftJoin(schema.receivers, eq(schema.verifications.receiverId, schema.receivers.id))
    .where(eq(schema.verifications.id, id))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // Lazy-expire: same logic as getVerification(). If a row was
  // pending past its TTL, render it as expired and best-effort
  // persist the transition.
  let status = row.status;
  if (status === "pending" && row.expiresAt.getTime() <= Date.now()) {
    status = "expired";
    lazyExpireAndEmit(id);
  }

  // Stable-by-design: prefer the at-start snapshot. The receivers
  // join is only used for rows predating migration 0003 — once those
  // ages out of the system, the join becomes pure defense in depth.
  const effectiveMsisdn = row.receiverMsisdnSnapshot ?? row.receiverMsisdnJoined;

  const isPending = status === "pending";
  return {
    id: row.id,
    status,
    phone_masked: maskPhone(row.phoneE164),
    expires_at: row.expiresAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    verified_at: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    send_to: isPending ? effectiveMsisdn : null,
    message: isPending ? `${row.messagePrefix} ${row.code}` : null,
  };
}

/**
 * Even leaner shape for the polling endpoint. Includes only the
 * transition-relevant fields — no message, no send_to, no
 * phone_masked, no client_ref.
 */
export async function getHostedVerificationStatus(
  id: string,
): Promise<HostedVerificationStatus | null> {
  const rows = await db
    .select({
      status: schema.verifications.status,
      expiresAt: schema.verifications.expiresAt,
      verifiedAt: schema.verifications.verifiedAt,
    })
    .from(schema.verifications)
    .where(eq(schema.verifications.id, id))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  let status = row.status;
  if (status === "pending" && row.expiresAt.getTime() <= Date.now()) {
    status = "expired";
    lazyExpireAndEmit(id);
  }

  return {
    status,
    expires_at: row.expiresAt.toISOString(),
    verified_at: row.verifiedAt ? row.verifiedAt.toISOString() : null,
  };
}

export { ApiError };
