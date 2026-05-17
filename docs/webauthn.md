# WebAuthn fallback

Optional passkey-based fallback for users who can't receive SMS at
the moment. v0.5 PR 4 ships the **server endpoints** + storage; the
hosted page only links to a developer-supplied fallback URL. Inline
WebAuthn UI on the hosted page itself is out of scope and a
follow-up.

This document is the contract — the four endpoints, the storage
layout, and the security guarantees the server enforces. Implementers
of the host-app fallback page consume this contract.

## Status

**Disabled by default.** Set `WEBAUTHN_ENABLED=true` (and the rest of
the config below) to mount `/v1/webauthn/*`. With the flag off, every
probe under that prefix returns 404 — there's no auth surface to
attack.

## Configuration

```
WEBAUTHN_ENABLED=true
WEBAUTHN_RP_ID=otp.example.com           # required when enabled
WEBAUTHN_RP_NAME=Example                 # optional, falls back to RP_ID
WEBAUTHN_ORIGINS=https://otp.example.com,https://app.example.com
WEBAUTHN_CHALLENGE_TTL_SECONDS=300       # default
WEBAUTHN_FALLBACK_URL=https://…/passkey  # optional; shown on hosted page
```

The Relying-Party id MUST match (or be a parent of) the page origin
that initiates the ceremony. Multiple origins are allowed via the
comma list — useful when the registration flow runs on
`otp.example.com` and the app's main shell is on `app.example.com`.

## Endpoints

All four POST under `sk_live_*` (backend-only — a leaked `pk_live_*`
in a browser MUST NOT be able to register passkeys for arbitrary
users).

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/webauthn/register/options` | server returns `PublicKeyCredentialCreationOptionsJSON` + stores a single-use challenge |
| `POST` | `/v1/webauthn/register/verify`  | server verifies the attestation and stores the credential row |
| `POST` | `/v1/webauthn/login/options`    | server returns `PublicKeyCredentialRequestOptionsJSON` + stores a single-use challenge |
| `POST` | `/v1/webauthn/login/verify`     | server verifies the assertion + bumps `sign_count` |

Request bodies share a `client_ref` field (the developer-supplied
per-user identifier — the WebAuthn `userHandle`). Verify endpoints
also accept `response: <browser ceremony JSON>`.

```json
// POST /v1/webauthn/register/options
{ "client_ref": "user_42" }

// POST /v1/webauthn/register/verify
{
  "client_ref": "user_42",
  "response": { /* full RegistrationResponseJSON from @simplewebauthn/browser */ }
}
```

The server delegates the actual cryptographic verify to
[`@simplewebauthn/server`](https://simplewebauthn.dev/) — origin
matching, rpID matching, attestation parsing, and `sign_count`
enforcement happen there. The SYROTP server adds the storage,
challenge expiry, and single-use guarantees.

## Storage

```
webauthn_credentials
  id                    text   PK   wac_<ulid>
  app_id                text   FK   apps(id) cascade
  client_ref            text        the WebAuthn `userHandle`
  credential_id_hash    text        HMAC-keyed lookup id (raw id never stored)
  public_key            bytea       COSE-encoded public key
  sign_count            integer     anti-cloning counter
  transports            text[]      browser hint (internal/hybrid/…)
  backup_state          boolean     L2 flag from attestation
  backup_eligible       boolean     L2 flag from attestation
  created_at, last_used_at

webauthn_challenges
  id            text   PK   wch_<ulid>
  app_id        text   FK   apps(id) cascade
  client_ref    text
  challenge     text        base64url; needed for verify-side compare
  purpose       text        "register" | "login"
  expires_at    timestamptz single-use TTL
  used_at       timestamptz
```

Two storage choices worth flagging:

- **`credential_id_hash`, not the raw id.** The library's verify
  step accepts the raw id from the response; we only need to look
  the row up afterward, so an HMAC-keyed hash is enough — a DB-only
  leak doesn't hand attackers indices into authenticator
  identifiers. Trade-off: we can't populate `allowCredentials` /
  `excludeCredentials` from this side. v0.5 PR 4 leaves
  `allowCredentials` empty; browsers handle the credential-picker
  UI well in that case. Storing the raw id is a follow-up if the
  empty-list trade-off becomes painful.
- **Challenge stored in plain text.** Verify needs to compare it
  byte-for-byte against `clientDataJSON.challenge`. Single-use +
  TTL'd minimizes the window. Logs MUST NOT print the challenge —
  the test suite has a canary (WA10) asserting this.

## Security guarantees pinned by tests

| Test | Property |
| --- | --- |
| WA1 | `WEBAUTHN_ENABLED=false` ⇒ every `/v1/webauthn/*` probe returns 404 |
| WA2 | `pk_live_*` rejected on every endpoint |
| WA3 | `register/options` stamps a challenge row with TTL |
| WA4 | `register/verify` with no active challenge ⇒ 400 `challenge_invalid` |
| WA5 | Happy register stores the credential row |
| WA6 | Challenge is single-use — replay ⇒ 400 |
| WA7 | Expired challenge ⇒ 400 |
| WA8 | Login bumps `sign_count` + `last_used_at` |
| WA9 | Login for an unregistered credential id ⇒ 404 |
| WA10 | Raw challenge bytes never appear in any log line |
| WA11 | Library `verified=false` ⇒ 400 `attestation_failed` |

Origin / rpID validation is delegated to
`@simplewebauthn/server` — we pass `expectedOrigin` and
`expectedRPID` from the env config; a mismatch raises inside the
library and surfaces here as a 400.

## Hosted-page integration

If `WEBAUTHN_FALLBACK_URL` is set, the hosted verification page
adds a small footer link on the *pending* state:

```
Can't receive SMS? Use a passkey instead.
```

The link goes to whatever URL the operator configured. The SYROTP
hosted page does NOT inline a WebAuthn flow itself in v0.5 — the
host app owns the passkey UX, calls the four endpoints from its own
front-end, and decides what "verified" means for its product.

## Out of scope (not in v0.5)

- WebAuthn as a default replacement for SMS verification (no
  automatic completion of `/v1/verifications/:id` from a successful
  passkey login). When an app wants this, it can add a
  server-to-server step on top of the four endpoints below.
- Per-app WebAuthn config (rpID / origins / fallback URL) — server-
  level only for now.
- Account recovery, OAuth/IdP flows, native mobile passkey UX,
  custom attestation policies.
- Storing the raw `credential_id` (so `allowCredentials` /
  `excludeCredentials` can be populated). Browsers handle the
  empty-list case fine; tighten this if the credential-picker UX
  becomes a real problem.

## Operating

There's no background worker for WebAuthn — every flow is
request-driven. Challenge cleanup happens implicitly via
`expires_at`; if the table grows unboundedly in your deployment,
add a periodic `DELETE FROM webauthn_challenges WHERE expires_at <
now() - interval '1 day'` on a cron and forget about it. The active
index includes `expires_at` so the operational query plan stays
sane regardless.
