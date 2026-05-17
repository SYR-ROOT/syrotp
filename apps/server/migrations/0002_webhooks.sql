-- v0.5 PR 2A — Webhook core tables.
--
-- Three tables, no down-migration. Forward-only — if these need to
-- be reshaped later we add another migration on top.

CREATE TYPE "webhook_delivery_status" AS ENUM (
  'pending',
  'delivered',
  'failed',
  'abandoned'
);

CREATE TABLE "webhook_endpoints" (
  "id" text PRIMARY KEY,                  -- whk_<ulid>
  "app_id" text NOT NULL REFERENCES "apps"("id") ON DELETE CASCADE,
  "url" text NOT NULL,
  "secret_ciphertext" text NOT NULL,      -- AES-GCM-wrapped via lib/aead
  "enabled" boolean NOT NULL DEFAULT true,
  "event_types" text[] NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "webhook_endpoints_app_idx"
  ON "webhook_endpoints" ("app_id", "enabled");

CREATE TABLE "webhook_events" (
  "id" text PRIMARY KEY,                  -- evt_<ulid>
  "app_id" text NOT NULL REFERENCES "apps"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,             -- verification.verified | .expired | .cancelled
  "verification_id" text,
  "payload_json" text NOT NULL,           -- pre-rendered, redaction-safe
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "webhook_events_app_type_idx"
  ON "webhook_events" ("app_id", "event_type", "created_at");

CREATE TABLE "webhook_deliveries" (
  "id" text PRIMARY KEY,                  -- wd_<ulid>
  "endpoint_id" text NOT NULL REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE,
  "event_id" text NOT NULL REFERENCES "webhook_events"("id") ON DELETE CASCADE,
  "event_type" text NOT NULL,
  "status" webhook_delivery_status NOT NULL DEFAULT 'pending',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL,
  "last_status_code" integer,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
-- Worker scans this index repeatedly for due, pending rows.
CREATE INDEX "webhook_deliveries_due_idx"
  ON "webhook_deliveries" ("status", "next_attempt_at");
CREATE INDEX "webhook_deliveries_endpoint_idx"
  ON "webhook_deliveries" ("endpoint_id", "created_at");
CREATE INDEX "webhook_deliveries_event_idx"
  ON "webhook_deliveries" ("event_id");
