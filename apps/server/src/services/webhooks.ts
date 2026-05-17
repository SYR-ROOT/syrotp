/**
 * Webhook core service. PR #20A scope:
 *
 *   - Endpoint CRUD (used by the REST routes in routes/webhooks.ts).
 *   - Secret generation + AES-GCM wrap with `webhook:<id>` AAD so
 *     a row swap doesn't validate.
 *   - Event payload assembly. Keeps the safe-fields whitelist in one
 *     place — verification_id, status, phone_masked, purpose,
 *     client_ref, and a per-event timestamp. NO raw E.164, NO OTP
 *     code, NO API keys, NO receiver id.
 *   - Event emission: insert one `webhook_events` row + one
 *     `webhook_deliveries` row per subscribed enabled endpoint, all
 *     in the caller's transaction so a state change without its
 *     events (or vice-versa) is impossible.
 *
 * The actual HTTP delivery worker is PR #20B.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import { createHmac, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { db, schema } from "../db/index.js";
import { wrap } from "../lib/aead.js";
import { ApiError, badRequest, notFound } from "../lib/errors.js";
import {
  newId,
  WEBHOOK_DELIVERY_PREFIX,
  WEBHOOK_ENDPOINT_PREFIX,
  WEBHOOK_EVENT_PREFIX,
} from "../lib/ids.js";
import { maskPhone } from "../lib/phone.js";
import { metrics } from "./metrics.js";

// ----- closed event-type set -------------------------------------------

export const VERIFICATION_EVENT_TYPES = [
  "verification.verified",
  "verification.expired",
  "verification.cancelled",
] as const;

export type VerificationEventType = (typeof VERIFICATION_EVENT_TYPES)[number];

const VERIFICATION_EVENT_TYPE_SET = new Set<string>(VERIFICATION_EVENT_TYPES);

export function isValidEventType(value: string): value is VerificationEventType {
  return VERIFICATION_EVENT_TYPE_SET.has(value);
}

// ----- shape returned by the REST endpoints ----------------------------

export interface WebhookEndpointPublic {
  id: string;
  app_id: string;
  url: string;
  enabled: boolean;
  event_types: string[];
  created_at: string;
  updated_at: string;
}

export interface WebhookEndpointWithSecret extends WebhookEndpointPublic {
  /**
   * The raw signing secret. Returned ONCE on creation and never
   * re-emitted — at-rest storage is the wrapped ciphertext.
   */
  secret: string;
}

// ----- secret generation -----------------------------------------------

const SECRET_PREFIX = "whsec_";
const SECRET_RANDOM_BYTES = 32; // 256 bits

function generateWebhookSecret(): string {
  return SECRET_PREFIX + randomBytes(SECRET_RANDOM_BYTES).toString("hex");
}

function aadFor(endpointId: string): string {
  return `webhook:${endpointId}`;
}

// ----- create ----------------------------------------------------------

export interface CreateWebhookInput {
  appId: string;
  url: string;
  eventTypes: string[];
}

export async function createWebhookEndpoint(
  input: CreateWebhookInput,
): Promise<WebhookEndpointWithSecret> {
  validateUrl(input.url);
  const events = uniqueValidatedEventTypes(input.eventTypes);

  const id = newId(WEBHOOK_ENDPOINT_PREFIX);
  const secret = generateWebhookSecret();
  const wrapped = wrap(config.MASTER_ENCRYPTION_KEY, secret, aadFor(id));
  const now = new Date();

  await db.insert(schema.webhookEndpoints).values({
    id,
    appId: input.appId,
    url: input.url,
    secretCiphertext: wrapped,
    enabled: true,
    eventTypes: events,
    createdAt: now,
    updatedAt: now,
  });

  return {
    id,
    app_id: input.appId,
    url: input.url,
    enabled: true,
    event_types: events,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    secret,
  };
}

// ----- read / list / delete -------------------------------------------

export async function listWebhookEndpoints(appId: string): Promise<WebhookEndpointPublic[]> {
  const rows = await db
    .select()
    .from(schema.webhookEndpoints)
    .where(eq(schema.webhookEndpoints.appId, appId))
    .orderBy(desc(schema.webhookEndpoints.createdAt));
  return rows.map(toPublic);
}

export async function getWebhookEndpoint(
  appId: string,
  id: string,
): Promise<WebhookEndpointPublic> {
  const rows = await db
    .select()
    .from(schema.webhookEndpoints)
    .where(and(eq(schema.webhookEndpoints.appId, appId), eq(schema.webhookEndpoints.id, id)))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("webhook_endpoint");
  return toPublic(row);
}

export async function deleteWebhookEndpoint(appId: string, id: string): Promise<void> {
  // Cascade drops associated deliveries (FK on delete cascade).
  // Past events stay — they're an audit trail of what was emitted,
  // not a per-endpoint queue.
  const result = await db
    .delete(schema.webhookEndpoints)
    .where(and(eq(schema.webhookEndpoints.appId, appId), eq(schema.webhookEndpoints.id, id)))
    .returning({ id: schema.webhookEndpoints.id });
  if (result.length === 0) throw notFound("webhook_endpoint");
}

function toPublic(
  row: typeof schema.webhookEndpoints.$inferSelect,
): WebhookEndpointPublic {
  return {
    id: row.id,
    app_id: row.appId,
    url: row.url,
    enabled: row.enabled,
    event_types: row.eventTypes,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

// ----- input validation ------------------------------------------------

const URL_MAX = 2048;

function validateUrl(value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw badRequest("validation_error", "url is required");
  }
  if (value.length > URL_MAX) {
    throw badRequest("validation_error", `url exceeds ${URL_MAX} chars`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw badRequest("validation_error", "url is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw badRequest("validation_error", "url must be http(s)");
  }
  // Rejecting userinfo blocks `https://user:pass@evil/`-style URLs that
  // some libraries follow into the credentials.
  if (parsed.username || parsed.password) {
    throw badRequest("validation_error", "url must not include credentials");
  }
}

function uniqueValidatedEventTypes(input: unknown): VerificationEventType[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw badRequest("validation_error", "event_types must be a non-empty array");
  }
  const seen = new Set<string>();
  const out: VerificationEventType[] = [];
  for (const v of input) {
    if (typeof v !== "string" || !isValidEventType(v)) {
      throw badRequest("validation_error", `unknown event_type: ${String(v).slice(0, 64)}`);
    }
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// ----- payload assembly ------------------------------------------------

export interface VerificationEventData {
  verification_id: string;
  status: "verified" | "expired" | "cancelled";
  phone_masked: string;
  purpose: string;
  client_ref: string | null;
  verified_at?: string;
  expired_at?: string;
  cancelled_at?: string;
}

export interface VerificationEventEnvelope {
  id: string;
  type: VerificationEventType;
  created_at: string;
  data: VerificationEventData;
}

/**
 * Build the data block for a verification.* event from a
 * verifications row. Whitelist-based: a future column added to
 * `verifications` does NOT leak into the webhook unless someone
 * touches this function on purpose.
 */
export function buildVerificationEventData(
  row: typeof schema.verifications.$inferSelect,
  eventType: VerificationEventType,
): VerificationEventData {
  const data: VerificationEventData = {
    verification_id: row.id,
    status: eventType === "verification.verified"
      ? "verified"
      : eventType === "verification.expired"
        ? "expired"
        : "cancelled",
    phone_masked: maskPhone(row.phoneE164),
    purpose: row.purpose,
    client_ref: row.clientRef ?? null,
  };
  if (eventType === "verification.verified" && row.verifiedAt) {
    data.verified_at = row.verifiedAt.toISOString();
  } else if (eventType === "verification.expired") {
    // Use expires_at as the canonical "when did it expire" — the row
    // doesn't carry an explicit expired_at; the lazy-expire transition
    // happens after expires_at by definition.
    data.expired_at = row.expiresAt.toISOString();
  } else if (eventType === "verification.cancelled" && row.cancelledAt) {
    data.cancelled_at = row.cancelledAt.toISOString();
  }
  return data;
}

// ----- emission --------------------------------------------------------

/**
 * Drizzle's transaction handle is awkward to type when shared across
 * modules; this alias keeps callers honest without forcing them to
 * import drizzle internals.
 */
export type Tx = PgTransaction<
  PostgresJsQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * Insert a `webhook_events` row + one `webhook_deliveries` row per
 * enabled, subscribed endpoint. MUST run inside the caller's
 * transaction so a state change (cancel / verify / expire) without
 * its event — or vice versa — is impossible.
 *
 * No-op (other than the `webhook_events` row) when no endpoint
 * subscribes to this event_type for this app.
 */
export async function emitVerificationEventInTx(
  tx: Tx,
  eventType: VerificationEventType,
  appId: string,
  data: VerificationEventData,
): Promise<void> {
  const eventId = newId(WEBHOOK_EVENT_PREFIX);
  const createdAt = new Date();
  const envelope: VerificationEventEnvelope = {
    id: eventId,
    type: eventType,
    created_at: createdAt.toISOString(),
    data,
  };
  const payloadJson = JSON.stringify(envelope);

  await tx.insert(schema.webhookEvents).values({
    id: eventId,
    appId,
    eventType,
    verificationId: data.verification_id,
    payloadJson,
    createdAt,
  });

  // Find subscribed enabled endpoints. `event_types @> ARRAY[type]`
  // uses a Postgres array containment check — fast against the
  // (app_id, enabled) index since the `enabled = true` filter already
  // narrows the row set sharply.
  const endpoints = await tx
    .select({ id: schema.webhookEndpoints.id })
    .from(schema.webhookEndpoints)
    .where(
      and(
        eq(schema.webhookEndpoints.appId, appId),
        eq(schema.webhookEndpoints.enabled, true),
        sql`${schema.webhookEndpoints.eventTypes} @> ARRAY[${eventType}]::text[]`,
      ),
    );

  // Bump the metric exactly once per emission, regardless of how many
  // subscribers the event fans out to.
  metrics.webhookEventEmitted(eventType);

  if (endpoints.length === 0) return;

  const deliveries = endpoints.map((e) => ({
    id: newId(WEBHOOK_DELIVERY_PREFIX),
    endpointId: e.id,
    eventId,
    eventType,
    status: "pending" as const,
    attemptCount: 0,
    nextAttemptAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  }));
  await tx.insert(schema.webhookDeliveries).values(deliveries);
}

// ----- HMAC signing for outbound deliveries (PR #20B) ------------------

/**
 * Outbound delivery signature scheme. Receivers verify by computing
 * `HMAC-SHA256(secret, "<timestamp>.<body>")` and constant-time-comparing
 * the lowercase hex result to the `X-SYROTP-Webhook-Signature` header.
 *
 * Including the timestamp inside the signed material binds each
 * payload to a specific delivery time so a captured request can't
 * be replayed against the same endpoint by a passive on-path
 * attacker (the receiver also rejects timestamps too far from now).
 *
 * Signing the EXACT body bytes (no canonicalization, no minified
 * JSON re-render) means a single byte flip on the wire invalidates
 * the signature. Receivers MUST hash the bytes they actually
 * received, not a re-serialized JSON.
 */
export function signDeliveryBody(
  secret: string,
  timestampSeconds: number,
  bodyBytes: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestampSeconds}.${bodyBytes}`)
    .digest("hex");
}

// ----- retry policy ----------------------------------------------------

/**
 * Delay (seconds) BEFORE attempt N+1, given attempt N just failed
 * with a retriable error. Length 5 — covers the gap from 1st-fail
 * to 6th-attempt. Beyond that the delivery is abandoned.
 *
 * Numbers per the v0.5 PR 20B spec: `0s, 30s, 2m, 10m, 30m, 2h`.
 * The leading `0s` is the *initial* attempt delay (i.e. deliver
 * immediately on event creation), so the array here lists the
 * five retry waits.
 */
export const RETRY_DELAY_SECONDS = [
  /* after attempt 1 fails */ 30,
  /* after attempt 2 fails */ 120,
  /* after attempt 3 fails */ 600,
  /* after attempt 4 fails */ 1_800,
  /* after attempt 5 fails */ 7_200,
] as const;

export const MAX_DELIVERY_ATTEMPTS = 6;

export function nextRetryDelaySeconds(failedAttempts: number): number | null {
  if (failedAttempts >= MAX_DELIVERY_ATTEMPTS) return null;
  return RETRY_DELAY_SECONDS[failedAttempts - 1] ?? null;
}

export { ApiError };
