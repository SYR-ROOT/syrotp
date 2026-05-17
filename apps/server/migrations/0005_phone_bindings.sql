-- v0.8 PR #36 — Phone-binding ceremony.
--
-- A `phone_binding` row records that a specific phone number has
-- proven (via an SMS round-trip from the gateway) that it controls
-- the SIM at the time of binding. v0.8 PR #37 turns this into a
-- HARD invariant on `startVerification` — any phone that doesn't
-- have a `verified` binding for the calling app is rejected with
-- 403. PR #36 ships only the ceremony machinery; existing
-- verification flows are untouched.
--
-- Row lifecycle:
--   pending  → created by POST /v1/phone-bindings/start.
--              Carries a single-use nonce + TTL'd expires_at.
--   verified → flipped when an inbound SMS arrives carrying
--              "BIND <nonce>" from a phone matching phone_e164,
--              within expires_at, on the same receiver.
--   revoked  → developer revoked. Soft delete; row stays for
--              history. PR #37 treats `revoked` the same as no
--              row (verification rejected).
--
-- Multiple `pending` rows for the same (app_id, phone_e164) are
-- allowed (developer retries). Multiple `revoked` rows are
-- allowed (history). The partial unique index below ensures only
-- ONE `verified` row per (app_id, phone_e164) at a time.

CREATE TABLE "phone_bindings" (
  "id" text PRIMARY KEY,                              -- pbn_<ulid>
  "app_id" text NOT NULL REFERENCES "apps"("id") ON DELETE CASCADE,
  "receiver_id" text NOT NULL REFERENCES "receivers"("id") ON DELETE CASCADE,
  "phone_e164" text NOT NULL,
  -- 'pending' | 'verified' | 'revoked'. Open enum at the SQL layer
  -- so future statuses (e.g. 'expired_lazy') can land without a
  -- migration; the service narrows it.
  "status" text NOT NULL,
  -- Single-use random token. Persisted in plain text because the
  -- inbound match has to compare it byte-for-byte against the SMS
  -- body. Single-use + TTL keep the window small. Logs MUST NOT
  -- print the nonce.
  "nonce" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "bound_at" timestamptz,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Active-binding uniqueness: only ONE verified binding per
-- (app_id, phone_e164) at a time. Multiple pending and multiple
-- revoked rows are allowed.
CREATE UNIQUE INDEX "phone_bindings_active_uq"
  ON "phone_bindings" ("app_id", "phone_e164")
  WHERE "status" = 'verified';

-- The inbound matcher looks rows up by nonce alone (the gateway
-- only sees the message body, not the binding row). Nonce is
-- random + single-use so the index is selective.
CREATE INDEX "phone_bindings_nonce_idx"
  ON "phone_bindings" ("nonce", "status");

-- The future PR #37 enforcement query reads by (app_id,
-- phone_e164, status). Cover that path now so it stays cheap.
CREATE INDEX "phone_bindings_lookup_idx"
  ON "phone_bindings" ("app_id", "phone_e164", "status");
