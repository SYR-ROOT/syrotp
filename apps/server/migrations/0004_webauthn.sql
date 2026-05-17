-- v0.5 — WebAuthn fallback.
--
-- Two tables: stored credentials (one per registered authenticator,
-- per (app, client_ref)) and short-lived challenges (one per
-- in-flight register/login ceremony).
--
-- Privacy + replay properties pinned at the storage layer:
--   - credential_id_hash, not the raw credential id, so a DB-only
--     leak doesn't hand attackers indices into authenticator
--     identifiers
--   - challenge column stores the raw bytes in base64url because the
--     verify step needs them, but the row is single-use (used_at) and
--     TTL'd (expires_at) so the window is small. Logs MUST NOT print
--     the challenge.

CREATE TABLE "webauthn_credentials" (
  "id" text PRIMARY KEY,                          -- wac_<ulid>
  "app_id" text NOT NULL REFERENCES "apps"("id") ON DELETE CASCADE,
  -- Developer-supplied per-user identifier (the WebAuthn `userHandle`).
  -- Bounded by zod at the route layer.
  "client_ref" text NOT NULL,
  -- HMAC-keyed lookup id (hex). The raw credential id only exists in
  -- transit and on the authenticator.
  "credential_id_hash" text NOT NULL,
  -- COSE-encoded public key from the authenticator (stored as bytea).
  "public_key" bytea NOT NULL,
  -- Anti-cloning counter — must strictly increase across logins.
  "sign_count" integer NOT NULL DEFAULT 0,
  -- Authenticator transports the browser told us about
  -- (e.g. {'internal','hybrid'}). Hint only — used to populate
  -- allowCredentials.transports on later authentication options.
  "transports" text[] NOT NULL DEFAULT ARRAY[]::text[],
  -- WebAuthn L2 backup-eligibility / backup-state flags from the
  -- attestation. Useful for ops dashboards but never user-facing.
  "backup_state" boolean,
  "backup_eligible" boolean,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz
);
CREATE UNIQUE INDEX "webauthn_credentials_lookup_uq"
  ON "webauthn_credentials" ("app_id", "credential_id_hash");
CREATE INDEX "webauthn_credentials_user_idx"
  ON "webauthn_credentials" ("app_id", "client_ref");

CREATE TABLE "webauthn_challenges" (
  "id" text PRIMARY KEY,                          -- wch_<ulid>
  "app_id" text NOT NULL REFERENCES "apps"("id") ON DELETE CASCADE,
  "client_ref" text NOT NULL,
  -- base64url-encoded random bytes. Single-use + TTL'd; the verify
  -- step needs the raw value to match clientDataJSON.challenge.
  "challenge" text NOT NULL,
  -- 'register' | 'login'
  "purpose" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX "webauthn_challenges_active_idx"
  ON "webauthn_challenges" ("app_id", "client_ref", "purpose", "used_at", "expires_at");
