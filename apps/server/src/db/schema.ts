import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  customType,
  index,
  uniqueIndex,
  pgEnum,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Postgres `bytea` is the right native type for a binary public key;
// Drizzle ships PG types but not bytea built-in, so we declare it
// once here and reuse below.
const bytea = customType<{ data: Buffer; driverData: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const verificationStatus = pgEnum("verification_status", [
  "pending",
  "verified",
  "expired",
  "cancelled",
  "failed",
]);

export const apiKeyKind = pgEnum("api_key_kind", ["public", "secret", "gateway"]);

export const apps = pgTable("apps", {
  id: text("id").primaryKey(), // app_<ulid>
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  disabled: boolean("disabled").default(false).notNull(),
});

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(), // key_<ulid>
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    kind: apiKeyKind("kind").notNull(),
    // We store HMAC(master_key, "api_key:" + raw) — see lib/crypto.ts.
    // Plus a short prefix for human-friendly identification in logs.
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(), // first 12 chars of raw, for display
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => ({
    keyHashUq: uniqueIndex("api_keys_key_hash_uq").on(t.keyHash),
    appIdx: index("api_keys_app_idx").on(t.appId),
  }),
);

export const receivers = pgTable(
  "receivers",
  {
    id: text("id").primaryKey(), // rcv_<ulid>
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    operator: text("operator"), // e.g. "syriatel", "mtn"
    msisdn: text("msisdn").notNull(), // E.164
    secretHash: text("secret_hash").notNull(), // HMAC(master, "gateway_secret:" + raw)
    enabled: boolean("enabled").default(true).notNull(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    msisdnIdx: index("receivers_msisdn_idx").on(t.msisdn),
    appIdx: index("receivers_app_idx").on(t.appId),
  }),
);

export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(), // vrf_<ulid>
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    phoneE164: text("phone_e164").notNull(),
    purpose: text("purpose").notNull(),
    clientRef: text("client_ref"),
    locale: text("locale"),
    receiverId: text("receiver_id")
      .notNull()
      .references(() => receivers.id, { onDelete: "restrict" }),
    // Snapshot of the chosen receiver's wire details at start time.
    // The hosted page reads from these first, falling back to the
    // receivers join only for pre-existing rows. See migration 0003.
    receiverMsisdnSnapshot: text("receiver_msisdn_snapshot"),
    receiverOperatorSnapshot: text("receiver_operator_snapshot"),
    code: text("code").notNull(), // the random portion, NOT the full message
    messagePrefix: text("message_prefix").default("VERIFY").notNull(),
    status: verificationStatus("status").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    matchedInboundId: text("matched_inbound_id"),
    createdIp: text("created_ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    statusIdx: index("verifications_status_idx").on(t.status),
    phoneIdx: index("verifications_phone_idx").on(t.phoneE164, t.status),
    receiverIdx: index("verifications_receiver_idx").on(t.receiverId, t.status),
    expiresIdx: index("verifications_expires_idx").on(t.expiresAt),
    // v1.x FIX 6 — Partial unique index on (receiver_id, phone_e164, code)
    // restricted to `pending` rows. Eliminates the (already astronomically
    // unlikely) chance that two concurrent pending verifications share the
    // same code triple, which would let one inbound SMS claim BOTH in the
    // matcher's UPDATE ... RETURNING and silently drop one. With the
    // partial uniqueness in place, `startVerification` would 23505 at
    // insert time instead — see services/verifications.ts for the
    // collision-retry handler.
    //
    // The migration in `migrations/0006_pending_uniq.sql` is the
    // authoritative declaration; this entry exists so drizzle-kit
    // introspection stays in sync with the DB.
    pendingUq: uniqueIndex("verifications_pending_uniq")
      .on(t.receiverId, t.phoneE164, t.code)
      .where(sql`${t.status} = 'pending'`),
  }),
);

export const inboundSms = pgTable(
  "inbound_sms",
  {
    id: text("id").primaryKey(), // in_<ulid>
    receiverId: text("receiver_id")
      .notNull()
      .references(() => receivers.id, { onDelete: "cascade" }),
    fromE164: text("from_e164").notNull(),
    toMsisdn: text("to_msisdn").notNull(),
    body: text("body").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    matchedVerificationId: text("matched_verification_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    idemUq: uniqueIndex("inbound_sms_idem_uq").on(t.receiverId, t.idempotencyKey),
    fromIdx: index("inbound_sms_from_idx").on(t.fromE164, t.receivedAt),
  }),
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
    appId: text("app_id"),
    actor: text("actor"), // e.g. "key:key_xxx", "receiver:rcv_xxx", "system"
    action: text("action").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    requestId: text("request_id"),
    metaJson: text("meta_json"),
  },
  (t) => ({
    atIdx: index("audit_log_at_idx").on(t.at),
    resourceIdx: index("audit_log_resource_idx").on(t.resourceType, t.resourceId),
  }),
);

// ----- Webhooks (v0.5 PR 2A) ----------------------------------------------

export const webhookDeliveryStatus = pgEnum("webhook_delivery_status", [
  "pending",
  "delivered",
  "failed",
  "abandoned",
]);

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: text("id").primaryKey(), // whk_<ulid>
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    // AES-GCM-wrapped via lib/aead.ts with AAD = "webhook:<id>" so a
    // row swap won't validate. The raw secret is shown ONCE on
    // creation and never re-emitted by GET endpoints.
    secretCiphertext: text("secret_ciphertext").notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    // Subscribed event types — Postgres text[] so a partial filter
    // can use `event_types @> ARRAY[...]`. Validated against the
    // closed set in the service before insert.
    eventTypes: text("event_types").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    appIdx: index("webhook_endpoints_app_idx").on(t.appId, t.enabled),
  }),
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: text("id").primaryKey(), // evt_<ulid>
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(), // verification.verified | .expired | .cancelled
    verificationId: text("verification_id"),
    // Pre-rendered, redaction-safe JSON payload — stored once at
    // emission so reflecting today's verification state into a
    // future delivery doesn't surprise. Worker reads this verbatim.
    payloadJson: text("payload_json").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    appTypeIdx: index("webhook_events_app_type_idx").on(t.appId, t.eventType, t.createdAt),
  }),
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(), // wd_<ulid>
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => webhookEvents.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    status: webhookDeliveryStatus("status").default("pending").notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull(),
    lastStatusCode: integer("last_status_code"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Worker scans pending+ready deliveries — partial-friendly index.
    dueIdx: index("webhook_deliveries_due_idx").on(t.status, t.nextAttemptAt),
    endpointIdx: index("webhook_deliveries_endpoint_idx").on(t.endpointId, t.createdAt),
    eventIdx: index("webhook_deliveries_event_idx").on(t.eventId),
  }),
);

// ----- WebAuthn fallback (v0.5 PR 4) ---------------------------------------

export const webauthnCredentials = pgTable(
  "webauthn_credentials",
  {
    id: text("id").primaryKey(), // wac_<ulid>
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    /** Developer-supplied per-user identifier (the WebAuthn `userHandle`). */
    clientRef: text("client_ref").notNull(),
    /** HMAC-keyed lookup hash of the raw credential id (hex). */
    credentialIdHash: text("credential_id_hash").notNull(),
    /** COSE-encoded public key returned by the authenticator. */
    publicKey: bytea("public_key").notNull(),
    /** Anti-cloning counter — must strictly increase across logins. */
    signCount: integer("sign_count").default(0).notNull(),
    transports: text("transports").array().notNull().default([]),
    backupState: boolean("backup_state"),
    backupEligible: boolean("backup_eligible"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => ({
    lookupUq: uniqueIndex("webauthn_credentials_lookup_uq").on(t.appId, t.credentialIdHash),
    userIdx: index("webauthn_credentials_user_idx").on(t.appId, t.clientRef),
  }),
);

export const webauthnChallenges = pgTable(
  "webauthn_challenges",
  {
    id: text("id").primaryKey(), // wch_<ulid>
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    clientRef: text("client_ref").notNull(),
    /** base64url-encoded random bytes. Single-use + TTL'd. */
    challenge: text("challenge").notNull(),
    /** "register" | "login" — open string here, narrowed in the service. */
    purpose: text("purpose").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    activeIdx: index("webauthn_challenges_active_idx").on(
      t.appId,
      t.clientRef,
      t.purpose,
      t.usedAt,
      t.expiresAt,
    ),
  }),
);

// ----- Phone binding ceremony (v0.8 PR #36) --------------------------------
//
// Records that a phone number has proven (via an SMS round-trip from
// the gateway) that it controls the SIM. v0.8 PR #37 will make the
// existence of a `verified` row a hard prerequisite for
// `startVerification`. PR #36 only ships the ceremony machinery —
// existing verification flows are untouched.

export const phoneBindings = pgTable(
  "phone_bindings",
  {
    id: text("id").primaryKey(), // pbn_<ulid>
    appId: text("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    receiverId: text("receiver_id")
      .notNull()
      .references(() => receivers.id, { onDelete: "cascade" }),
    phoneE164: text("phone_e164").notNull(),
    /** "pending" | "verified" | "revoked" — narrowed in the service. */
    status: text("status").notNull(),
    /**
     * Single-use random token. Plain text because the inbound match
     * compares it byte-for-byte against the SMS body. Single-use +
     * TTL keep the window small; logs MUST NOT print it.
     */
    nonce: text("nonce").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    boundAt: timestamp("bound_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    nonceIdx: index("phone_bindings_nonce_idx").on(t.nonce, t.status),
    lookupIdx: index("phone_bindings_lookup_idx").on(t.appId, t.phoneE164, t.status),
    // Note: the partial unique index `phone_bindings_active_uq`
    // (only one `verified` row per (app_id, phone_e164)) is created
    // in `migrations/0005_phone_bindings.sql`; Drizzle's index
    // builder doesn't expose partial WHERE clauses cleanly, so we
    // rely on the migration for that constraint.
  }),
);
