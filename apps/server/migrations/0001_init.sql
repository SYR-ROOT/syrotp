-- SYROTP initial schema
-- Generated to match drizzle schema in src/db/schema.ts

CREATE TYPE "verification_status" AS ENUM ('pending', 'verified', 'expired', 'cancelled', 'failed');
CREATE TYPE "api_key_kind" AS ENUM ('public', 'secret', 'gateway');

CREATE TABLE "apps" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "disabled" boolean NOT NULL DEFAULT false
);

CREATE TABLE "api_keys" (
  "id" text PRIMARY KEY,
  "app_id" text NOT NULL REFERENCES "apps"("id") ON DELETE CASCADE,
  "kind" api_key_kind NOT NULL,
  "key_hash" text NOT NULL,
  "key_prefix" text NOT NULL,
  "label" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz,
  "revoked_at" timestamptz
);
CREATE UNIQUE INDEX "api_keys_key_hash_uq" ON "api_keys" ("key_hash");
CREATE INDEX "api_keys_app_idx" ON "api_keys" ("app_id");

CREATE TABLE "receivers" (
  "id" text PRIMARY KEY,
  "app_id" text NOT NULL REFERENCES "apps"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "operator" text,
  "msisdn" text NOT NULL,
  "secret_hash" text NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "last_heartbeat_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "receivers_msisdn_idx" ON "receivers" ("msisdn");
CREATE INDEX "receivers_app_idx" ON "receivers" ("app_id");

CREATE TABLE "verifications" (
  "id" text PRIMARY KEY,
  "app_id" text NOT NULL REFERENCES "apps"("id") ON DELETE CASCADE,
  "phone_e164" text NOT NULL,
  "purpose" text NOT NULL,
  "client_ref" text,
  "locale" text,
  "receiver_id" text NOT NULL REFERENCES "receivers"("id") ON DELETE RESTRICT,
  "code" text NOT NULL,
  "message_prefix" text NOT NULL DEFAULT 'VERIFY',
  "status" verification_status NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "expires_at" timestamptz NOT NULL,
  "verified_at" timestamptz,
  "cancelled_at" timestamptz,
  "matched_inbound_id" text,
  "created_ip" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "verifications_status_idx" ON "verifications" ("status");
CREATE INDEX "verifications_phone_idx" ON "verifications" ("phone_e164", "status");
CREATE INDEX "verifications_receiver_idx" ON "verifications" ("receiver_id", "status");
CREATE INDEX "verifications_expires_idx" ON "verifications" ("expires_at");

CREATE TABLE "inbound_sms" (
  "id" text PRIMARY KEY,
  "receiver_id" text NOT NULL REFERENCES "receivers"("id") ON DELETE CASCADE,
  "from_e164" text NOT NULL,
  "to_msisdn" text NOT NULL,
  "body" text NOT NULL,
  "received_at" timestamptz NOT NULL,
  "idempotency_key" text NOT NULL,
  "matched_verification_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "inbound_sms_idem_uq" ON "inbound_sms" ("receiver_id", "idempotency_key");
CREATE INDEX "inbound_sms_from_idx" ON "inbound_sms" ("from_e164", "received_at");

CREATE TABLE "audit_log" (
  "id" text PRIMARY KEY,
  "at" timestamptz NOT NULL DEFAULT now(),
  "app_id" text,
  "actor" text,
  "action" text NOT NULL,
  "resource_type" text,
  "resource_id" text,
  "ip" text,
  "user_agent" text,
  "request_id" text,
  "meta_json" text
);
CREATE INDEX "audit_log_at_idx" ON "audit_log" ("at");
CREATE INDEX "audit_log_resource_idx" ON "audit_log" ("resource_type", "resource_id");
