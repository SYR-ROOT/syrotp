# SYROTP Security Checklist & Invariants

**Status:** Normative for v1.0. Pins the security invariants the
server enforces today and the operator / developer / webhook-receiver
checklists every deployment is expected to satisfy. Sits alongside
[`api-contract.md`](api-contract.md), [`errors.md`](errors.md), and
[`compatibility.md`](compatibility.md) in the v1.0 protocol-freeze
track.

This document does **not** introduce any new security feature, new
auth model, new endpoint, or behavioural change. It documents what
already ships and what every deployment must keep true.

For the multi-instance audit (which paths share state safely under
N concurrent processes), see
[`multi-instance-safety.md`](multi-instance-safety.md). For the
phone-binding ceremony itself, see [`phone-bindings.md`](phone-bindings.md).
For Android gateway key handling, see
[`android-gateway-keystore.md`](android-gateway-keystore.md).

## Threat model — what we defend against, what we don't

### In scope

| Adversary | Capability | SYROTP defence |
| --- | --- | --- |
| Hostile browser / mobile app holding a leaked `pk_live_*` | Can call any `pk_live`-permitted endpoint | `pk_live_*` cannot cancel, cannot read full verification detail (masked view only), cannot touch webhooks / bindings / WebAuthn (refused with `403 forbidden`). |
| Hostile party at the SMS layer | Can spoof SMS sender id; can send arbitrary `VERIFY <code>` | Code is server-generated per verification; matching requires the SMS to land at the correct receiver AND the inbound `from_e164` to match a `verified` phone-binding for the calling app. Without the binding, `startVerification` is rejected `403 phone_not_bound` before any SMS is even possible. |
| Dishonest gateway operator | Can fabricate `from_e164` on inbound calls | Gateway must HMAC-sign every inbound + heartbeat with a per-receiver secret. The receiver row carries `app_id`, so HMAC verification implicitly authorises the right tenant. The phone-binding ceremony separately proves a specific phone can receive at a specific receiver — a dishonest gateway cannot fake an inbound for a phone it has never seen sign in. |
| On-path attacker between server and gateway | Can replay or modify inbound requests | HMAC signature input includes the timestamp, a nonce, and the SHA-256 of the raw body bytes. Server rejects timestamps older than `INBOUND_TIMESTAMP_SKEW_SECONDS` and replayed nonces (cached for at least the skew window). Modified bodies fail signature comparison. |
| On-path attacker between server and webhook receiver | Can replay / modify webhook deliveries | Webhook body is signed `HMAC-SHA256(secret, "<ts>.<body>")` over the exact body bytes. The receiver MUST verify before acting. |
| Attacker holding a Postgres dump (DB-only leak) | Reads `apps`, `api_keys`, `receivers`, `webhook_endpoints`, `webauthn_credentials`, etc. | API keys stored as scrypt hashes (the raw value is shown once at issue and never reconstructible from the row). Webhook secrets stored as AES-GCM-wrapped ciphertexts with `webhook:<id>` AAD so a row swap doesn't validate. WebAuthn credential ids stored as HMAC-keyed lookup hashes — the raw id never lives in the DB. Gateway signing keys: same scrypt-hash discipline as API keys. |
| Attacker holding the Android gateway phone | Lift the gateway signing key off-device | The signing key is bound to AndroidKeyStore (alias `syrotp_gateway_signing_v1`, StrongBox best-effort on API 28+, TEE fallback). The plaintext key never returns to userland after migration; workers `Result.retry()` rather than fall back to a heap-resident HMAC. |
| Operator dashboard attacker | Probe for `/admin/*` endpoints | `/admin/*` is **disabled by default** — no `ADMIN_USER` + `ADMIN_PASSWORD_HASH` means no routes are mounted, so every probe returns 404 with no hint that the dashboard exists. When enabled, scrypt + `timingSafeEqual` for both username and password to prevent existence oracles. |
| Cross-tenant attacker holding one app's `sk_live_*` | Tries to bind a phone to another app's receiver, or read another app's data | Every read / write is scoped by `app_id` resolved from the auth header. Phone binding ceremony additionally validates `(receiver_id, app_id)` matches before accepting. |

### Out of scope (explicitly)

| Threat | Why not in v1.0 |
| --- | --- |
| Mobile-OS-level integrity attestation (Play Integrity, App Attest) | Deliberately deferred. The v1.0 trust model is "a verified phone binding proves SMS reachability." Adding device-attestation would be a new feature, not a hardening of the existing contract. |
| Auto-ban / behavioural enforcement | v0.8 PR #39 ships abuse signals as **read-only observability**; no auto-ban path exists. Operators decide what to do with the signals. |
| Defence against a fully-compromised operator | SYROTP is self-hosted. An operator who controls the server can do anything — the threat model assumes the operator is honest. |
| Defence against a fully-compromised receiver gateway | A gateway is a trusted component (it holds the HMAC signing key). The phone-binding ceremony narrows the blast radius (a dishonest gateway can't fabricate inbounds for phones it has never seen) but does not eliminate it. |
| Network-level DoS | Out of SYROTP's layer. Operators are expected to terminate at a CDN / WAF / reverse proxy. Per-IP / per-receiver / per-app rate limits exist as defence-in-depth, not as a primary DoS shield. |

## Hard invariants — must never regress

These are pinned. Every PR — security or otherwise — that touches a
listed code path MUST keep the invariant true. The integration test
suite already covers each of them; the test names are listed for
quick lookup.

| # | Invariant | Enforced in | Test |
| --- | --- | --- | --- |
| 1 | A `startVerification` for a phone without a `verified` row in `phone_bindings` (for the calling `app_id`) returns `403 phone_not_bound`. **No flag, no soft / metrics-only mode, no bypass.** | [`services/verifications.ts:172-186`](../apps/server/src/services/verifications.ts#L172-L186) | `phoneBindingEnforcement.ts` |
| 2 | A `pending` or `revoked` phone binding does NOT satisfy invariant #1 — only `verified` does. | Same as #1 (the WHERE clause filters `status = 'verified'`). | `phoneBindingEnforcement.ts` |
| 3 | Inbound SMS without a valid HMAC signature is rejected `401 unauthorized`. The rejection reason is logged server-side; the response is uniform (no per-row distinction surfaced). | [`routes/inbound.ts:65-77`](../apps/server/src/routes/inbound.ts#L65-L77), [`services/hmac.ts`](../apps/server/src/services/hmac.ts) | `inbound.ts` (HMAC-canary subtests) |
| 4 | Inbound SMS to a receiver whose row has `enabled = false` is rejected `401 unauthorized` with the same uniform shape — the response cannot distinguish "wrong key" from "disabled receiver". | [`services/hmac.ts`](../apps/server/src/services/hmac.ts) (verifier returns `ok: false` on disabled receiver) | `receiverFleet.ts` (RF1) |
| 5 | Inbound HMAC verification requires all four headers (`X-SYROTP-Receiver`, `X-SYROTP-Timestamp`, `X-SYROTP-Nonce`, `X-SYROTP-Signature`). Missing any → `401`. | [`routes/inbound.ts:48-50`](../apps/server/src/routes/inbound.ts#L48-L50) | `inbound.ts` |
| 6 | Replayed inbound nonces (cached for at least `INBOUND_TIMESTAMP_SKEW_SECONDS`) are rejected. Skewed timestamps outside that window are rejected. | [`services/hmac.ts`](../apps/server/src/services/hmac.ts) | `inbound.ts` (replay subtest) |
| 7 | Inbound idempotency is preserved: a second inbound with the same `(receiver_id, idempotency_key)` returns the original outcome (matched / no_match), never double-resolves a verification. | DB unique constraint `inbound_sms_idem_uq` + [`services/matching.ts:74-105`](../apps/server/src/services/matching.ts#L74-L105) | `inbound.ts` (idempotency subtest); see also [`multi-instance-safety.md#5`](multi-instance-safety.md) |
| 8 | A pending verification count for a single `(app_id, phone_e164)` cannot exceed `MAX_PENDING_PER_PHONE` even under concurrent `startVerification` calls. | `db.transaction` + `pg_advisory_xact_lock(hashtextextended(app_id||':'||phone, 0))` in [`services/verifications.ts:185-258`](../apps/server/src/services/verifications.ts#L185-L258) | `concurrency.ts` (T12) |
| 9 | Webhook delivery signature scheme is frozen: `HMAC-SHA256(secret, "<ts>.<body>")` over the exact body bytes. Receivers MUST be able to verify forever using the snippet in [`webhooks.md`](webhooks.md). | [`services/webhookWorker.ts`](../apps/server/src/services/webhookWorker.ts) | `webhookWorker.ts` |
| 10 | Webhook secrets are returned **once** at endpoint creation and never re-emitted. `GET /v1/webhooks/{id}` MUST NOT include `secret`. | [`routes/webhooks.ts:43-73`](../apps/server/src/routes/webhooks.ts#L43-L73), [`services/webhooks.ts:128-150`](../apps/server/src/services/webhooks.ts#L128-L150) | `webhooks.ts` |
| 11 | Webhook secrets at rest are AES-GCM-wrapped with AAD `webhook:<id>` so a row-swap attack against the DB doesn't validate. | [`services/webhooks.ts:99-104`](../apps/server/src/services/webhooks.ts#L99-L104), [`lib/aead.ts`](../apps/server/src/lib/aead.ts) | `atRest.ts` |
| 12 | Per-IP, per-receiver, and per-app rate limits all run on the request path. Per-IP runs first (cheap); HMAC must verify before per-app on inbound (the receiver row carries `app_id`). | [`services/rateLimit.ts`](../apps/server/src/services/rateLimit.ts), [`routes/verifications.ts:48-72`](../apps/server/src/routes/verifications.ts#L48-L72), [`routes/inbound.ts:54-95`](../apps/server/src/routes/inbound.ts#L54-L95), [`routes/phoneBindings.ts:53-61`](../apps/server/src/routes/phoneBindings.ts#L53-L61) | `rateLimit.ts`, `rateLimitPerApp.ts` |
| 13 | When Redis is unavailable, rate limits **fail open** by deliberate design — the system stays available rather than locking everyone out. | [`services/rateLimit.ts`](../apps/server/src/services/rateLimit.ts) | documented in [`multi-instance-deployment.md`](multi-instance-deployment.md) |
| 14 | The webhook worker process refuses to start when it inherits `WEBHOOK_WORKER_ENABLED=false` (exits `2`). The split topology cannot silently degrade to "no worker is running anywhere." | [`workers/webhook.ts`](../apps/server/src/workers/webhook.ts) | `webhookWorkerStandalone.ts` (WS2) |
| 15 | Webhook worker split does NOT change delivery semantics: same backoff schedule (`0/30s/2m/10m/30m/2h`, max 6 attempts), same `FOR UPDATE SKIP LOCKED` claim, same per-attempt timeout. | [`services/webhookWorker.ts`](../apps/server/src/services/webhookWorker.ts) is shared by both entry points | `webhookWorker.ts`, `webhookWorkerStandalone.ts` |
| 16 | Migrations run **once**, before any API or worker process starts handling traffic. Tier ownership: a single tier (typically the API tier's deploy step) owns `pnpm migrate`; workers MUST NOT migrate. | Operator runbook in [`multi-instance-deployment.md`](multi-instance-deployment.md) | n/a (operational invariant) |
| 17 | API key hash + verify uses scrypt + `timingSafeEqual`. The raw key is shown once at issue and never reconstructible from the DB. | [`services/apiKeys.ts`](../apps/server/src/services/apiKeys.ts), [`lib/crypto.ts`](../apps/server/src/lib/crypto.ts) | `auth.ts`, `atRest.ts` |
| 18 | `pk_live_*` cannot call `cancelVerification` (`POST /v1/verifications/{id}/cancel`) — secret-key only. | [`routes/verifications.ts:140-141`](../apps/server/src/routes/verifications.ts#L140-L141) | `auth.ts` (T19) |
| 19 | Gateway keys cannot call developer APIs (`POST /v1/verifications` etc.) — refused `403 forbidden`. | [`plugins/auth.ts`](../apps/server/src/plugins/auth.ts) | `auth.ts` (T21) |
| 20 | Phone-binding nonces are single-use and TTL-bounded. The atomic `UPDATE ... WHERE nonce=? AND status='pending' AND expires_at>now()` is the only way a binding flips to `verified`. | [`services/phoneBindings.ts:230-281`](../apps/server/src/services/phoneBindings.ts#L230-L281) | `phoneBindings.ts` |
| 21 | The Android gateway signing key is bound to AndroidKeyStore. Workers `Result.retry()` if keystore import fails; **no heap-resident HMAC fall-back**. The legacy `Crypto.hmacSha256Hex(key, payload)` overload exists only inside the migration shim. | [`apps/android-gateway/`](../apps/android-gateway/) — see [`android-gateway-keystore.md`](android-gateway-keystore.md) | manual smoke (no JVM test source set yet) |
| 22 | `/admin/*` is disabled-by-default: missing `ADMIN_USER` or `ADMIN_PASSWORD_HASH` (or malformed hash) → no routes mounted, every probe `404`. | [`admin/web/plugin.ts:60-72`](../apps/server/src/admin/web/plugin.ts#L60-L72) | `admin.ts` |
| 23 | `/v1/webauthn/*` is disabled-by-default: `WEBAUTHN_ENABLED != true` or `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGINS` unset → no routes mounted. | [`routes/webauthn.ts:47-54`](../apps/server/src/routes/webauthn.ts#L47-L54), [`services/webauthn.ts:86-92`](../apps/server/src/services/webauthn.ts#L86-L92) | `webauthn.ts` (WA1 disabled-state subtest) |
| 24 | WebAuthn challenges are single-use and TTL-bounded; the consume path uses `SELECT ... FOR UPDATE SKIP LOCKED` + `UPDATE ... usedAt = now()` inside one tx. | [`services/webauthn.ts:144-182`](../apps/server/src/services/webauthn.ts#L144-L182) | `webauthn.ts` |
| 25 | WebAuthn credential ids are stored as HMAC-keyed lookup hashes — the raw id never lives in the DB. | [`services/webauthn.ts:96-104`](../apps/server/src/services/webauthn.ts#L96-L104) | `atRest.ts`, `webauthn.ts` |
| 26 | The hosted page (`/v/{id}`) ships with a strict CSP: `default-src 'none'`, scripts gated by per-request nonce, no external resources allowed, `frame-ancestors 'none'`. | [`hosted/web/plugin.ts:74-86`](../apps/server/src/hosted/web/plugin.ts#L74-L86) | `hosted.ts` |
| 27 | Cardinality discipline in Prometheus: no `app_id` / `phone_id` / `IP` labels. Per-app / per-receiver detail goes through `/admin/abuse-signals` JSON, NOT through high-cardinality labels. | [`services/metrics.ts`](../apps/server/src/services/metrics.ts), [`services/abuseSignals.ts`](../apps/server/src/services/abuseSignals.ts) | `metrics.ts` |

## Operator security checklist

Run through this before promoting a deployment past staging. Items
marked **MUST** are non-negotiable for v1.0; **SHOULD** items are
strongly recommended but operationally adjustable.

### Credentials & key material

- [ ] **MUST** Generate `MASTER_ENCRYPTION_KEY` from a real CSPRNG (32 bytes hex). Never commit. Rotation requires re-wrapping every webhook secret — plan for downtime.
- [ ] **MUST** Generate `COOKIE_SECRET` from a real CSPRNG. Never commit.
- [ ] **MUST** Set `POSTGRES_PASSWORD` to a non-default value. The `.env.example` value is a sentinel, not a credential.
- [ ] **MUST NOT** ship a `sk_live_*` key in any public artifact (npm bundle, mobile app, browser code). SDK static analysis warns when a secret-shaped key is constructed in a browser context — keep that warning enabled.
- [ ] **SHOULD** Issue separate `pk_live_*` / `sk_live_*` per environment (dev / staging / prod). Revoke unused keys.
- [ ] **SHOULD** Limit who can mint API keys via `/admin/*`. The dashboard is read-only today, but the bootstrap CLI is not — guard the host shell.

### Network & TLS

- [ ] **MUST** Terminate TLS in front of SYROTP. The server itself does not. A reverse proxy (nginx / Caddy / cloud LB) is the supported topology.
- [ ] **MUST** Set `TRUSTED_PROXIES` to the CIDR allowlist of upstream proxies whose `X-Forwarded-For` is trusted (e.g. `TRUSTED_PROXIES=10.0.0.0/8,127.0.0.1`). Leave empty when the server is directly Internet-facing. Production refuses to boot when `TRUST_PROXY=true` is set without a non-empty allowlist. The server ALWAYS generates `req.id` itself via `randomUUID()` — client-supplied `X-Request-Id` is stored only as `clientRequestId` for echo/audit and never poisons the log correlation.
- [ ] **SHOULD** Restrict `/metrics` to the Prometheus scraper's IP at the proxy layer. The server intentionally does NOT enforce auth on `/metrics` — that's a deployment concern.
- [ ] **SHOULD** Restrict `/admin/*` to operator IPs at the proxy layer in addition to Basic Auth.

### Admin dashboard

- [ ] **MUST** Either set both `ADMIN_USER` and `ADMIN_PASSWORD_HASH`, or set neither (the disabled-by-default invariant). Never set just one.
- [ ] **MUST** Generate `ADMIN_PASSWORD_HASH` via the helper script (`pnpm --filter @syrotp/server admin-password-hash`) — manual scrypt is error-prone. Format is `scrypt$<salt-hex>$<hash-hex>`.
- [ ] **SHOULD** Use a long, randomly-generated password, not a memorable one. The dashboard is read-only, but the username/password pair is also a foothold for brute-force attempts in logs.

### Phone-binding lifecycle

- [ ] **MUST** Run the phone-binding ceremony for every phone before the developer's first `startVerification` call. Backfilling existing phones is the upgrade path from pre-v0.8 deployments.
- [ ] **MUST** Treat the `bind_message` (`"BIND <nonce>"`) returned by `POST /v1/phone-bindings/start` as a single-use bearer token. Do NOT log it; do NOT cache it; deliver it directly to the user.
- [ ] **SHOULD** Revoke a binding when the user reports lost device / changed SIM. Revocation is `POST /v1/phone-bindings/{id}/revoke`.

### Receiver gateway

- [ ] **MUST** Use the v0.8+ Android gateway with AndroidKeyStore signing (alias `syrotp_gateway_signing_v1`). Pre-v0.8 gateways with plaintext-prefs keys are no longer supported.
- [ ] **MUST** Heartbeat every receiver at least every `RECEIVER_HEARTBEAT_TIMEOUT_SECONDS` / 2 (default 60s). A receiver past the timeout is treated as unhealthy by the router.
- [ ] **SHOULD** Disable a receiver via `disableReceiver` (CLI: `syrotp receiver disable <id>`) when rotating SIMs. Re-enable with `enableReceiver` after the new SIM is paired. Mint-new + disable-old is the supported rotation today (in-place rotation is a deferred item).

### Migrations & multi-instance

- [ ] **MUST** Run `pnpm --filter @syrotp/server migrate` exactly once before any new server / worker process starts handling traffic. Tier ownership: assign migration to ONE tier (typically the API tier's deploy step). Workers MUST NOT migrate.
- [ ] **MUST** Read [`multi-instance-deployment.md`](multi-instance-deployment.md) before promoting from single-instance to multi-instance. Pool sizing math: `(api + worker) × 30` Postgres connections.
- [ ] **MUST** When splitting the webhook worker out, set `WEBHOOK_WORKER_ENABLED=false` on the API tier and run a dedicated `pnpm --filter @syrotp/server start:webhook` process. The worker fails fast if it inherits the false flag — that's deliberate, not a bug.

### Observability

- [ ] **SHOULD** Scrape `/metrics` into Prometheus. Watch the abuse-signals gauges (`syrotp_health_score`, the per-bucket failure-rate gauges) and alert on `health_score < 70`.
- [ ] **SHOULD** Forward server logs to a system that respects the redaction config in [`apps/server/src/app.ts`](../apps/server/src/app.ts). The server already redacts `Authorization`, `X-SYROTP-Signature`, and cookies — log infra MUST NOT re-attach the raw values.
- [ ] **SHOULD** Run the soak loadtest before a release to a multi-instance topology: see [`operational-baseline.md`](operational-baseline.md).

## Developer integration checklist

For the application team integrating an SYROTP SDK.

- [ ] **MUST** Use a `sk_live_*` key for the binding ceremony, webhook CRUD, WebAuthn endpoints, and `cancelVerification`. A `pk_live_*` is fine for `startVerification` and `getVerification`.
- [ ] **MUST** Keep `sk_live_*` server-side only. Never embed in a mobile / browser bundle.
- [ ] **MUST** Verify webhook signatures using the snippet in [`webhooks.md`](webhooks.md) before acting on the body. The server's signature is `HMAC-SHA256(secret, "<ts>.<body>")` over the exact body bytes (not a re-serialised JSON).
- [ ] **MUST** Treat the SYROTP `verification_id` (and the `client_ref` you pass) as the only authoritative id correlator. Don't try to reconstruct identity from the masked phone alone.
- [ ] **SHOULD** Catch `SyrotpRateLimitError` (per [`sdk-contract.md`](sdk-contract.md)) and respect `retry_after`. The server's per-app bucket is generous (default `500/min`) but a runaway script will hit it.
- [ ] **SHOULD** Implement `SyrotpAuthError` (`401`) and `SyrotpValidationError` (`403 phone_not_bound`, `400 phone_type_not_allowed`) as user-visible errors in your UI. They indicate misconfiguration, not transient failure — retrying won't help.
- [ ] **SHOULD** Run the binding ceremony at the same lifecycle moment as account creation / phone update, not lazily on first verification call. The user expects a one-time setup, not an interruption mid-flow.

## Webhook receiver checklist

For whoever owns the URL receiving the SYROTP webhook deliveries.

- [ ] **MUST** Verify `X-SYROTP-Signature` against the request body bytes BEFORE parsing the body. Reject with `4xx` on signature mismatch — do NOT echo the failure reason.
- [ ] **MUST** Return a `2xx` to acknowledge. Any `3xx` is treated as a rejection (the worker uses `redirect: manual`).
- [ ] **MUST** Respond within the worker's per-attempt timeout (5 seconds). Slower responses are recorded as a timeout failure and retried per the bounded backoff schedule.
- [ ] **MUST** Be idempotent on the `event_id`. The worker may deliver a single event more than once during operator failover.
- [ ] **MUST NOT** trust any field that isn't in the documented payload whitelist (`verification_id`, `status`, `phone_masked`, `purpose`, `client_ref`, event timestamp). The server intentionally never sends raw E.164, OTP code, API keys, or receiver id over the webhook.
- [ ] **SHOULD** Log the `request_id` from the webhook delivery's response if you generate one, so server-side correlation is possible.
- [ ] **SHOULD** Enforce a tight per-source rate limit on your endpoint independent of SYROTP's worker — if your endpoint becomes a re-delivery hot spot, the worker WILL hammer it within the backoff schedule.

## When to update this document

- A new hard invariant is being added to the codebase (security gate, key-rotation step, replay protection). Add the row to the [Hard invariants](#hard-invariants--must-never-regress) table in the same PR, with a test reference. **No new invariant ships unless it's listed here.**
- A new operator-facing security knob is being added. Update the appropriate operator checklist section.
- An invariant is being deliberately retired (rare; requires a protocol MAJOR per [`api-contract.md`](api-contract.md#compatibility-commitment-for-v10)). Mark the row removed in the same PR, link the migration guide.

The threat model section is the slowest-moving — it changes only when the project's security boundary itself moves (e.g. taking on a new adversary class, accepting a new mitigation as in-scope). Routine PRs do not edit it.
