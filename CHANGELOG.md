# Changelog

All notable changes to SYROTP will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] — 2026-05-04

v1.0.0 is the **protocol-freeze** release. The wire contract — paths,
request/response schemas, status codes, headers, and the set of error
codes — is committed. Every change inside `1.x` will be additive (new
optional fields, new optional endpoints, new error codes that SDKs
already tolerate). Removing or renaming a documented surface requires
a protocol MAJOR bump.

Five docs-first PRs (#46–#50) — **no new features, no behaviour
changes, no schema changes** — landed across the v1.0 track. The
server image is wire-identical to `v0.9.0`; what's new is the
operator-facing commitment.

### Added

- `openapi.yaml` realignment (PR #46): brought back in sync with the
  19 wire-contract endpoints actually shipped through v0.9 — webhooks,
  WebAuthn, phone-bindings, hosted-page polling, `BIND` discriminator,
  and the full error-code catalogue. `info.version` → `1.0.0`.
- `apps/server/test/suites/openapiContract.ts` (PR #46): path-coverage
  drift test wired via a new optional `onRoute` callback on `buildApp`.
  Fails any future PR that registers a route without documenting it.
- `docs/api-contract.md` (PR #47): v1.0 stability commitment wrapper
  around `openapi.yaml`. Stability tiers (Stable / Stable
  additive-feature / Out of contract), endpoint-group catalogue keyed
  by auth surface, and the formal v1.0 compatibility commitment.
- `docs/errors.md` (PR #47): canonical error envelope, status-code
  table, all 21 error codes the server emits, and the retryable-vs-not
  matrix every official SDK already implements.
- `docs/compatibility.md` (PR #47): three-numbers mental model
  (protocol / server / SDK), per-server-release wire-change table,
  per-SDK manifest version snapshot, skew matrix, per-release operator
  upgrade actions, and the "v1.0 ready" deployment checklist.
- `docs/security-checklist.md` (PR #48): threat model summary
  (8 in-scope adversaries, 5 explicitly out-of-scope), **27 hard
  invariants** the server already enforces — each with a code pointer
  and a test reference — plus operator / developer / webhook-receiver
  checklists. New invariants in future PRs MUST land with a row here.
- `docs/upgrade-policy.md` (PR #49): forward-only migration discipline,
  authoring rules, upgrade order (migrate → roll API → roll worker),
  honest position on rolling deploys (possible by design, not
  CI-tested), rollback path (deploy previous image, no SQL DOWN),
  backup expectations, API ↔ worker skew (one MINOR cycle), and the
  pre/post-upgrade operator checklists.
- `docs/release-checklist.md` (PR #50): the pre-tag gate the project
  runs before each release — local sanity, release-baseline,
  contract-drift test, CI on main, CHANGELOG awk-extraction.
- `docs/README.md` (PR #50): single navigation index keyed by audience
  (integrators / operators / protocol authors).

### Fixed

- `openapi.yaml` error-code catalogue (PR #47): the phone normaliser
  emits `invalid_phone` (not `phone_invalid`), and `phone_type_not_allowed`
  was missing entirely. Both fixed inside the description block — no
  schema or path changes.

### Notes

- **No wire behaviour changes.** Every endpoint documented in
  `openapi.yaml` was already shipped through `v0.9.0`; the v1.0 track
  is the audit-and-commit layer on top of that.
- **No schema changes.** `apps/server/migrations/` is unchanged from
  `v0.9.0`. The five existing migrations remain the v1.0 baseline.
- **No SDK behaviour changes.** Existing SDK versions speak the v1.0
  protocol unchanged. SDKs are versioned independently from the server
  per [`docs/sdk-versioning.md`](docs/sdk-versioning.md).
- **No publishing.** Publishing remains a separate track (per release
  registry's ownership checklist in `docs/publishing.md`); v1.0 is the
  protocol-freeze release, not a publish event.
## [0.9.0] — 2026-05-03

v0.9.0 completes the **Scale / HA / Operations** phase.

### Added

- Standalone webhook worker process with split deployment support.
- Multi-instance deployment guide for API and worker processes.
- Receiver fleet operations guide and `enable` command.
- Long soak suite and operational baseline documentation.
- p99 latency reporting in loadtest reports.

### Changed

- Webhook worker can now run in-process by default or as a standalone worker.
- Receiver operations now support disable → enable round-trips.
- Operational docs now define ready-to-scale checks for v0.9 deployments.

### Fixed

- Hardened verification creation against concurrent `MAX_PENDING_PER_PHONE` races using a Postgres advisory transaction lock.
- Added regression coverage proving pending verification count cannot exceed the configured maximum under concurrent starts.
- Pinned disabled-receiver inbound rejection behavior with tests.

### Notes

- No API wire contract changes.
- No schema changes for v0.9.
- p99 is reported but not yet acceptance-gated.
- Release-baseline remains the fast pre-tag gate; soak is an opt-in operational gate.

### Detail

- **Long soak loadtest scenario + operational baseline (v0.9
  PR #45).** The closing PR for v0.9. Adds the operational gate
  that sits next to the existing release-baseline (burst-shape,
  pre-tag) — soak is the steady-state-over-minutes gate operators
  run **before promoting a deployment from single-process to
  split or multi-instance**.
  - New `soak` loadtest scenario in
    `tools/loadtest/src/runner.ts`. Reuses the existing
    `fullFlow` runner; `defaultTotal=50_000` /
    `defaultWorkers=100` push wall-clock duration into the 3-5
    minute range so steady-state behaviour (lease churn,
    abuse-signal drift, log growth, webhook-worker tick
    stability) actually has time to surface.
  - New `soak` suite combining `soak` + `replay-storm` +
    `wrong-code-storm` + `receiver-disabled`. **NOT part of
    `release-baseline`** (which stays the fast pre-tag gate);
    soak is opt-in via `pnpm loadtest suite soak`.
  - Acceptance policy for `soak` mirrors `scenario-b` shape
    (success ≥ 99.9%, no 5xx, no double-verifications) but
    relaxes p95 from 400 ms → 500 ms because steady-state under
    sustained load legitimately runs warmer than a 1k burst.
  - **p99 latency captured + surfaced** in suite step output
    alongside p95. **NOT acceptance-gated in v0.9** — by
    deliberate choice. The histogram has computed p99 since
    v0.1.1 and the per-scenario report has rendered it; this
    PR exposes it at the suite-summary level too. A future PR
    can pick a real p99 threshold from data, after operators
    have soaked their own production-shape hardware. v0.9
    keeps p99 advisory.
  - New `docs/operational-baseline.md` defining "v0.9
    ready-to-scale": integration green + release-baseline green
    + soak green + manual RSS observation stable. Includes:
    - Comparison table (integration suite vs. release-baseline
      vs. soak vs. manual observation — which gate applies when).
    - Latency budget table with the acceptance shape
      (thresholds operators tune to their hardware).
    - Manual RSS / log-growth observation procedures for Linux,
      macOS, Windows.
    - 8-row soak failure-mode triage table (5xx → pool
      exhaustion, double_verifications → advisory-lock fix
      missing, p95 climb → receiver staleness or webhook pool
      contention, etc.) with cross-references to
      `multi-instance-deployment.md`,
      `multi-instance-safety.md`, `webhook-worker.md`,
      `receiver-fleet.md`, `monitoring.md`.
    - Explicit "p99 is reported but not gated in v0.9" callout
      so a later contributor doesn't turn the advisory number
      into a gate without baseline data.
  - Out of scope (per the v0.9 plan): no API/wire/feature
    changes, no auto-scaling, no publishing, no automated
    memory or log-growth measurement, no webhook-delivery soak
    scenario, no mandatory p99 gates, no CI auto-run of the
    soak suite on tag push.

- **Receiver fleet operations: `enableReceiver` + `syrotp receiver
  enable` (v0.9 PR #44).** Symmetric to the existing
  `disableReceiver` / `syrotp receiver disable` (which has shipped
  since v0.3). An operator who flips a receiver out of rotation
  for maintenance now has a CLI path back without raw SQL.
  - New `enableReceiver(id)` admin function in
    `apps/server/src/admin/receivers.ts`. Idempotent — a second
    enable on the same receiver returns `wasDisabled: false`. Same
    `AdminError` codes as `disableReceiver` (`invalid_receiver_id`,
    `receiver_not_found`).
  - New `syrotp receiver enable <rcv_*>` CLI subcommand
    (`packages/cli/src/commands/receiver.ts`). Accepts the
    receiver id either positionally or via `--id`. Same DB writes
    the production server uses — no parallel implementation.
  - Help text on `syrotp receiver` lists `enable` alongside `add`,
    `list`, `disable`, `test`. Subcommand-specific `--help`
    documents that only the `enabled` flag flips — a stale-
    heartbeat receiver still won't be picked until the gateway
    sends a fresh heartbeat. There is no "force healthy" mode by
    design.
  - Two new integration tests in
    `apps/server/test/suites/receiverFleet.ts`:
    - **RF1** — pin the existing behaviour: a signed inbound from
      a disabled receiver is rejected at HMAC verify with `401
      unauthorized` (the route deliberately surfaces the uniform
      code regardless of WHY HMAC verify failed).
    - **RF2** — disable → enable round-trip: a disabled receiver
      leaves the selection pool, and re-enabling it puts it back.
      Asserts the idempotency of both `disable` and `enable`.
  - Four new CLI argv tests in `packages/cli/test/receiver.test.ts`
    covering `--help`, missing-id USAGE, positional id, and
    `--id` flag form. CLI test count is now 97/97 (was 93).
    Integration test count is now 141/141 (was 139).
  - New `docs/receiver-fleet.md` operator guide. Covers the five
    lifecycle states (healthy, stale, disabled, disabled+stale,
    removed), the inbound-vs-selection enforcement split,
    troubleshooting `503 no_receiver` vs `401 unauthorized` vs
    `unmatched_inbound_rate`, and the manual rotate procedure
    (mint-new + disable-old + re-pair + optional SQL delete).
  - Out of scope (explicitly): no schema changes, no audit columns
    (`disabled_at` / `enabled_at`), no auto-balancing, no in-place
    rotation endpoint, no auto-delete, no dual-SIM detection.

- **`docs/multi-instance-deployment.md` — canonical multi-instance
  deployment guide (v0.9 PR #43).** Docs-only; no code changes.
  The single doc to read when deciding whether to run beyond
  single-process. Covers:
  - Three deployment modes (single-process, API + dedicated
    worker, multi-API + multi-worker) with end-to-end commands.
  - The guarantees each operation relies on under N processes:
    advisory lock for `startVerification` (PR #42), `FOR UPDATE
    SKIP LOCKED` + 60s lease for webhook delivery (PR #21),
    Redis-backed rate-limit counters (shared across API
    replicas), DB unique constraints + `ON CONFLICT` for
    idempotency, atomic conditional UPDATE for phone-binding
    consume.
  - Migration ownership rule (run once before either tier
    starts; neither tier auto-migrates).
  - Required + shared env vars (`DATABASE_URL`, `REDIS_URL`,
    `MASTER_ENCRYPTION_KEY`, `COOKIE_SECRET` — drift produces
    silent decrypt failures or broken sessions) vs. per-tier
    env vars (`WEBHOOK_WORKER_ENABLED`, ports).
  - Postgres pool sizing math: each Node process opens
    `max=30`; `(api + worker) × 30` total. The default Postgres
    `max_connections=100` is exceeded at 4+ processes; recipes
    for raising it or shrinking the per-process pool. PgBouncer
    flagged as the long-term path past ~10 replicas, out of
    v0.9 scope.
  - Webhook worker tick-interval guidance (default 5000 ms,
    range 100–60000 ms; don't go below 500 ms).
  - Failure modes — Redis-down → rate limits **fail open**
    (deliberate trade-off, documented), Postgres-down → hard
    fail on next query, worker crash mid-tick → 60s lease
    expiry recovery, env-drift symptoms (`MASTER_ENCRYPTION_KEY`
    drift causes silent unwrap errors per delivery), and the
    `WEBHOOK_WORKER_ENABLED=false on a worker tier` fail-fast
    case (exits 2 with explicit message).
  - 7-step operator checklist for promoting an existing
    single-process deployment into split mode without
    surprises.
  - Cross-references to `docs/webhook-worker.md`,
    `docs/multi-instance-safety.md`, `docs/operations.md`,
    `docs/monitoring.md`, `docs/protocol.md`. No content is
    duplicated; this doc is the entrypoint, the others are
    the depths.

### Fixed

- **Multi-instance safety: `MAX_PENDING_PER_PHONE` race in
  `startVerification` (v0.9 PR #42).** The pre-PR #42 path did
  `SELECT count(*) WHERE phone=$1 AND status='pending'` then
  `INSERT`, with the await between yielding the event loop. Two
  concurrent calls for the same phone could both read the count
  as `MAX − 1`, both pass the gate, and both insert — leaving the
  table holding more than `MAX_PENDING_PER_PHONE` pending rows for
  one phone. The race already existed in single-process
  deployments (Node yields between awaits) and was amplified by
  v0.9 PR #41 multi-instance topology.

  Fix: wrap the count + receiver-pick + insert in a single
  `db.transaction` and take a per-`(app_id, phone_e164)` Postgres
  advisory lock at the start (`pg_advisory_xact_lock(hashtextextended(...))`).
  Different phones don't contend; the same phone serializes; the
  lock releases when the transaction commits. No schema change,
  no Redis dependency, no leader election.

  New T12 in the concurrency suite asserts the actual invariant —
  not "no 500", but "the DB never holds more than
  `MAX_PENDING_PER_PHONE` pending rows for one phone, no matter
  how many concurrent callers race the gate." 139/139 integration
  tests on `main` post-#42 (was 138).

### Added

- **`docs/multi-instance-safety.md` — audit artifact (v0.9 PR #42).**
  Records the concurrency model and verdict for every operation
  that mutates shared state, with file:line refs:
  - **Verification creation** — was GAP, now SAFE (PR #42 fix).
  - **Inbound matching** — SAFE (DB unique constraint + atomic
    `UPDATE ... WHERE status='pending'`).
  - **Phone-binding consume** — SAFE (atomic conditional UPDATE +
    partial unique index `WHERE status='verified'`).
  - **Webhook delivery leasing** — SAFE (`FOR UPDATE SKIP LOCKED`
    + 60s lease, from v0.5 PR #21).
  - **Idempotency keys (inbound)** — SAFE (unique constraint +
    catch-and-SELECT path).
  - **Rate-limit buckets** — SAFE (Redis `INCR` + `EXPIRE NX`,
    atomic).

  Two known limitations recorded for follow-up (NOT in #42):
  `MAX_PENDING_PER_IP` is defined but never enforced (missing-
  feature bug, not a race), and `startBinding` allows two
  concurrent `pending` rows for the same `(app, phone)` — caught
  by the partial unique index but surfaces as a 500 instead of a
  graceful `409 already_bound` (UX edge, not a race).

- **Webhook delivery worker — split-mode support (v0.9 PR #41).**
  The same `WebhookWorker` class now runs in two deployment shapes
  with no behavioral or wire change:
  - **Single-process (default)** — API server starts the worker
    in-process, exactly as it did from v0.5 onwards.
    `WEBHOOK_WORKER_ENABLED=true` (the default) keeps every existing
    deployment working unchanged.
  - **Split** — a new standalone entrypoint at
    `apps/server/src/workers/webhook.ts` runs the delivery loop as
    its own OS process. API tier sets `WEBHOOK_WORKER_ENABLED=false`
    to make the in-process timer a no-op; one or more standalone
    worker processes drain the queue. Multi-instance safety is
    already at the DB layer (`FOR UPDATE SKIP LOCKED` + soft 60s
    lease), so N workers can race the queue without double-delivery.
  - New `pnpm` scripts: `dev:webhook` (`tsx watch`) and
    `start:webhook` (runs the built `dist/workers/webhook.js`).
  - The `WebhookWorker` class no longer imports
    `FastifyBaseLogger` — replaced with a tiny structural
    `WebhookWorkerLogger` interface (`info` / `warn` / `error`)
    that both Fastify's logger and a plain `pino` logger satisfy.
    No Fastify dependency leaks into the worker process.
  - Standalone process is intentionally minimal: pino logger +
    Postgres pool + the existing `WebhookWorker` class + signal
    handlers. **No HTTP listener, no `/healthz`, no `/metrics`** in
    this PR — those follow in their own PR. Migration ownership
    stays single (operators run `pnpm migrate` once before starting
    the API and worker tiers).
  - Fails fast (`exit 2`) when launched with
    `WEBHOOK_WORKER_ENABLED=false` — the flag is meant for the API
    tier; a worker process inheriting it would silently spin a
    no-op loop forever, which is worse than a clear startup error.
  - Two new integration tests (`webhookWorkerStandalone.ts`) spawn
    the standalone entrypoint as a child process via
    `node --import tsx`, prove it picks up a queued delivery
    end-to-end (`WS1`), and prove the env-flag misuse path exits
    `2` (`WS2`). 138/138 integration tests on `main` post-#41
    (was 136 before; `WS1` + `WS2` are the two new).
  - New `docs/webhook-worker.md` documents both deployment modes,
    multi-instance safety, the migration-ownership rule, and the
    expected SIGTERM shutdown sequence.
  - PR 1 of N for v0.9 — Scale / HA / Operations.

## [0.8.0] — 2026-05-03

The **BYOG Hardening** release. Closes the phone-identity trust
gap surfaced during v0.7 — a dishonest gateway can no longer
forge an inbound `from_e164` because verifications now require a
verified phone-binding row (`phone_not_bound` 403 otherwise),
per-app rate limits stack on top of the existing per-IP /
per-receiver guards, and the Android gateway's signing key lives
in AndroidKeyStore so a rooted device or a `/data/data` snapshot
no longer hands an attacker the HMAC secret.

### Added

- Phone binding ceremony for Bring-Your-Own-Gateway deployments.
- Mandatory verified phone binding enforcement for verification creation.
- Per-app rate limits for verification creation, inbound SMS, and phone binding starts.
- Abuse score and health observability for apps and receivers.
- Android Keystore-bound signing key support for the Android Gateway.

### Security

- Verification creation now rejects unbound phone numbers with HTTP 403.
- Revoked and pending phone bindings are not accepted for verification creation.
- Gateway signing secrets are no longer stored as ordinary plaintext app data on Android.

### Notes

- This release hardens the BYOG trust model.
- No real package publishing is performed by this release.
- Existing publishing dry-runs from v0.7 remain the distribution readiness baseline.

### Detail

- **Android gateway: signing key bound to AndroidKeyStore (v0.8
  PR #40).** Final PR for v0.8 — BYOG Hardening. The Android
  gateway's HMAC signing key now lives in AndroidKeyStore under
  alias `syrotp_gateway_signing_v1`, requested with StrongBox
  backing where the device exposes one (API 28+ hardware-
  dependent), TEE-backed otherwise. Raw key bytes never
  materialize in the JVM heap during signing —
  `Mac.init(keystoreSecretKey)` cooperates with the keystore
  daemon to produce signatures, so a rooted device, runtime
  debugger, or `/data/data` snapshot cannot read the key.
  - New `KeystoreSigner` owns the alias, exposes `importKey` /
    `sign` / `hasKey` / `delete`, and is the only signing entry
    point on the production hot path.
  - `SyrotpClient` constructor takes a `KeystoreSigner` instead
    of a raw `signingKey: String`. The legacy
    `Crypto.hmacSha256Hex(key, payload)` overload is now
    `@Deprecated` and used exclusively from the migration shim.
  - One-shot legacy migration (`SignerMigration.run`): on first
    run after upgrade, reads the previously-stored
    EncryptedSharedPreferences `signing_key`, imports it into
    the keystore, and erases the prefs slot. Idempotent and
    safe to call from every entry point (`MainActivity`,
    `UploadWorker`, `HeartbeatWorker`).
  - `MainActivity.Save` now calls `KeystoreSigner.importKey`
    directly — the EditText is cleared and `clearLegacySigningKey`
    runs defensively so a re-pair never leaves a stale plaintext
    copy. **Unpair** wipes both the keystore alias and the prefs.
  - If keystore import fails on a wedged device, the gateway
    does NOT fall back to heap-resident HMAC — workers return
    `Result.retry()` and the legacy plaintext key is left in
    prefs for the next migration retry. There is no "soft
    fall-back" feature flag.
  - New `docs/android-gateway-keystore.md`: threat model,
    pairing flow, post-upgrade migration, rotation, compromise
    recovery, and a manual smoke verification procedure.
  - `docs/operations.md` updated to point at the new doc and to
    state precisely what storage now means.
  - **No new tests** in this PR. `apps/android-gateway/` has no
    JVM test source set yet; adding it is its own scope. The
    keystore docs include a step-by-step manual smoke procedure
    on a real device instead.

- **Abuse signals + health-score observability (v0.8 PR #39).**
  Read-only control plane for spotting tenant-level trouble
  before it becomes an incident. **No auto-ban, no enforcement
  changes, no webhook events** — the data infrastructure lands
  first; future PRs decide what to do with it.
  - New `services/abuseSignals.ts` runs a 60s refresh loop
    (unrefed timer, never blocks shutdown) that computes per-app
    + per-receiver aggregates over a 1-hour sliding window:
    `failed_rate` (verifications ending in `failed`),
    `unmatched_rate` (inbound SMS without a matched verification,
    rolled up from per-receiver detail), `binding_failure_rate`
    (`pending` phone-bindings whose `expires_at` passed without
    completion).
  - Per-app `health_score` ∈ `[0, 100]` is a clamped linear
    function:
    `100 − failed_rate*30 − unmatched_rate*40 − binding_failure_rate*10`.
    Pure function (`calcHealthScore`) so unit tests pin the
    formula independently of the DB-fed compute path.
  - Project-wide rollups exposed as Prometheus gauges with NO
    high-cardinality labels (matches the project's metric
    discipline): `syrotp_abuse_failed_verification_rate`,
    `syrotp_abuse_unmatched_inbound_rate`,
    `syrotp_abuse_binding_failure_rate`,
    `syrotp_abuse_min_app_health_score`.
  - Per-app + per-receiver detail surfaced via a new
    basic-auth-gated JSON endpoint `GET /admin/abuse-signals`.
    Returns the cached snapshot from the refresh loop; if the
    boot race leaves the cache empty on first hit, the endpoint
    computes on demand. `Cache-Control: no-store` so a stale
    value never leaks via CDN / reverse-proxy caches.
  - 7 new unit tests on `calcHealthScore` (clamp behavior,
    zero/perfect health, per-signal weights, integer rounding,
    defensive negative-input clamp).
  - Docs: `docs/monitoring.md` gets an "Abuse signals" gauges
    section + recommended alerts (`unmatched_inbound_rate > 0.20`
    for 10m, `min_app_health_score < 70` for 30m,
    `binding_failure_rate > 0.30` for 30m) + the
    `/admin/abuse-signals` JSON shape.
  - PR 4 of 5 for v0.8 — BYOG Hardening.

- **Per-app rate limits (v0.8 PR #38).** Three new buckets stack
  on top of the existing per-IP / per-receiver guards:
  - `RATE_LIMIT_VERIFICATIONS_PER_APP_PER_MIN` (default 500) on
    `POST /v1/verifications` — checked AFTER the per-IP guard, so
    a runaway app fanning out across many IPs hits a ceiling
    before drowning the tenant's neighbors.
  - `RATE_LIMIT_INBOUND_PER_APP_PER_MIN` (default 1000) on
    `POST /v1/inbound/sms` — checked AFTER the per-receiver guard
    AND HMAC verification (the receiver row is what carries the
    app id, so we can only key on app_id once HMAC has resolved).
  - `RATE_LIMIT_BINDINGS_PER_APP_PER_MIN` (default 60) on
    `POST /v1/phone-bindings/start` — bindings have no per-IP
    guard (always developer-backend traffic), so the per-app
    bucket is the only ceiling here.

  All three respect the existing fixed-window Redis-backed
  pattern (`services/rateLimit.ts`) and surface as
  `syrotp_rate_limited_total{bucket=...}` Prometheus counters with
  the new labels `verification_start_per_app`,
  `inbound_sms_per_app`, `phone_binding_start_per_app`.

  The 429 response body stays uniform (`{ error: { code:
  "rate_limited", ... } }`) — operators disambiguate which bucket
  fired via the metrics counter, not via the API. SDK consumers
  see the same `rate_limited` code regardless of which guard
  rejected, which keeps SDK error hierarchies stable.

  Smoke (`.github/workflows/ci.yml`) + release-baseline
  (`.github/workflows/release-baseline.yml`) inherit matching
  `50000` per-app overrides alongside the existing per-IP /
  per-receiver overrides — synthetic loadtest traffic drives one
  app from a single IP at high rates, so production defaults
  would falsely cap throughput.

  6 new RA-canary tests pin every property: per-app start fires
  independently of per-IP, per-app inbound fires after
  per-receiver, per-app binding fires (no per-IP for that path),
  buckets keyed on app_id (different apps don't share),
  per-IP / per-receiver guards still work in parallel, and the
  429 response carries the uniform error code.

  PR 3 of 5 for v0.8 — BYOG Hardening.

### Changed (BREAKING)

- **`POST /v1/verifications` enforces phone binding (v0.8 PR #37).**
  `startVerification` now returns `403 phone_not_bound` whenever
  no `verified` row exists in `phone_bindings` for the calling
  app's `(app_id, phone_e164)` after server-side normalization.
  There is **no bypass, no feature flag, no metrics-only mode,
  no soft warning** — this is the hard invariant the v0.8 BYOG
  hardening track was opened for. Callers must complete the
  phone-binding ceremony (PR #36) for every phone before they
  can create verifications against it. Phone normalization runs
  BEFORE the binding lookup — local formats like `"0991234567"`
  correctly match E.164 bindings like `"+963991234567"`.
  Enforcement is `(app_id, phone)`-scoped (not
  `(app_id, phone, receiver_id)`) by design — a binding tied to
  receiver A still satisfies a verification the router sends to
  receiver B in the same app. Test fixtures (`createTestApp`)
  auto-seed a verified binding for the dominant test phone
  `"+963991234567"` so existing suites Just Work; the
  phone-binding ceremony tests opt out via
  `seedBoundPhone: null`. New `seedVerifiedBinding(...)` helper
  inserts a verified row directly for tests using non-default
  phones. Smoke (`scripts/smoke.mjs`) now exercises the full
  ceremony before starting a verification — re-runs against the
  same dev DB skip the ceremony when an existing verified
  binding is found (`409 already_bound`). Loadtest fixtures
  (`tools/loadtest/src/env.ts`) gain a `seedBindings(phones)`
  hook; the runner pre-seeds verified bindings for every phone
  its scenarios will touch (covering both `phoneFromIndex(i)`
  and the replay-storm `i + 1_000_000` offset). 7 new PE-canary
  tests pin the contract. PR 2 of 5 for v0.8 — BYOG Hardening.

### Added

- **Phone-binding ceremony** (`POST /v1/phone-bindings/start`,
  `GET /v1/phone-bindings/:id`,
  `POST /v1/phone-bindings/:id/revoke`). New `phone_bindings`
  table with three statuses: `pending` → `verified` (via inbound
  `BIND <nonce>` SMS round-trip) or `revoked` (soft delete). The
  partial unique index `(app_id, phone_e164) WHERE status =
  'verified'` keeps only one active binding per `(app, phone)`;
  multiple `pending` rows are allowed (developer retries),
  multiple `revoked` rows preserve history. The inbound matcher
  tries `BIND <nonce>` first, then falls back to `VERIFY <code>`
  — but a BIND-shaped body with a malformed nonce does NOT
  reinterpret as VERIFY (no parsing-ambiguity attack surface).
  Single-use, TTL'd nonce (`PHONE_BINDING_TTL_SECONDS`, default
  300s); logs must never print the nonce or `bind_message`. All
  three endpoints are `sk_live_*` gated; `pk_live_*` is rejected.
  11 PB-canary tests pin every property. Contract documented at
  [`docs/phone-bindings.md`](docs/phone-bindings.md). **No
  enforcement on `startVerification` yet** — that's v0.8 PR #37,
  which will return 403 `phone_not_bound` whenever a verified
  binding doesn't exist for the (app, phone). PR 1 of 5 for
  v0.8 — BYOG Hardening.

## [0.7.0] — 2026-05-03

The **Publishing & Distribution readiness** release. v0.7 doesn't
add features — it makes everything SYROTP already ships installable
from the official package registry of each ecosystem. Every
official package now has a CI dry-run gate that validates publish
metadata + the produced artifact (tarball / wheel / AAR / archive)
on every PR and push to `main`. **No package is actually published
yet** — that flips on per-registry once each registry's
ownership checklist (in [`docs/publishing.md`](docs/publishing.md))
closes. v0.7 is the publishability infrastructure that makes the
eventual flip a config-level change, not a code change.

### Added

- **Open Core licensing model.** Cleanly split between
  source-available core and MIT SDKs/UI/CLI/examples:
  - `apps/server` and `apps/gsm-gateway` are now released under
    the new **SYROTP Core License v1.0**
    ([`LICENSE-SYROTP-CORE`](LICENSE-SYROTP-CORE)) — source-available,
    free for personal / educational / charitable / non-profit /
    single-org internal use, but reserves commercial resale, paid
    SaaS operation, rebranding, and offering the core as a paid
    OTP/verification service to **prior written permission from
    Muhammed Shekho (SYR-ROOT)**.
  - SDKs (`packages/sdk-{js,python,kotlin,swift,php,php-laravel}`),
    UI components (`packages/{react,web-component,android-ui,
    flutter,swift-ui}`), the operator CLI (`packages/cli`), and
    `examples/*` stay MIT-licensed
    ([`LICENSE-MIT`](LICENSE-MIT)) and are unaffected by the
    Core License — app developers can use them commercially
    without permission.
  - Root [`LICENSE`](LICENSE) is now an open-core meta document
    listing the per-package license. New
    [`AUTHORS.md`](AUTHORS.md) (founder + GitHub contact, no
    email) and bilingual [`ETHICS.md`](ETHICS.md) (Arabic +
    English; mission + community expectations, **not** a legal
    restriction).
  - README adds a bilingual **Dedication** section and a
    "License at a glance" summary.
- **Publishing runbook** at
  [`docs/publishing.md`](docs/publishing.md) — package map (which
  package goes to which registry under which name),
  registry-ownership checklist, per-package pre-publish
  checklist, CI token / secret naming conventions, dry-run
  commands per ecosystem, release flow, and operator runbook for
  token compromise / bad publishes.
- **Per-package metadata** completed across every publishable:
  `description`, `keywords`, `repository` (with `directory` for
  monorepo subpaths), `homepage`, `bugs` / `support`, `author` /
  `authors` (`Muhammed Shekho (SYR-ROOT)` — no email exposed in
  any published metadata; license-permission requests route via
  the GitHub profile + a tagged issue), `prepublishOnly` build
  hooks, license files inside each package's
  tarball / wheel / AAR / archive.
- **Per-package LICENSE files**: every publishable package ships
  its own `LICENSE` (copy of `LICENSE-MIT`) inside the
  registry artifact — no more relying on the consumer to find
  the root LICENSE.
- **`pubspec.yaml` topics** for pub.dev discoverability on
  `syrotp_flutter`: `otp`, `sms`, `verification`, `syrotp`,
  `reverse-otp` (max 5 per pub.dev rules).
- **POM metadata** for the Maven artifacts
  (`dev.syrotp:sdk-kotlin`, `dev.syrotp:android-ui`) expanded with
  `developers`, `scm` (git / ssh / web URLs pointing at the
  in-tree subpath), `issueManagement`, and
  `licenses[].distribution = "repo"`.
- **Per-package `CHANGELOG.md`** for `syrotp_flutter` (pub.dev
  rejects packages without one); the per-package changelog
  tracks just `syrotp_flutter`'s versions and links upward to the
  repo-wide changelog for the full project history.

### Changed

- **`sdk-kotlin` Maven coordinates**: `io.syrotp:syrotp-sdk` →
  `dev.syrotp:sdk-kotlin`. The Java package in sources stays
  `io.syrotp.sdk` — Maven group ≠ Java package is normal, and
  renaming would break every downstream `import io.syrotp.sdk.*`.
- **`sdk-python` license metadata** migrated to PEP 639:
  `license = "MIT"` (SPDX expression) + `license-files = ["LICENSE"]`,
  `setuptools >= 77`. The `License :: OSI Approved :: MIT License`
  classifier was dropped — setuptools 77+ rejects the combination
  of an SPDX `license` field and an OSI license classifier
  (mutually exclusive in PEP 639). The license stays discoverable
  via the SPDX field; PyPI's metadata UI surfaces it the same way.
- **`syrotp/sdk` and `syrotp/laravel`**: removed the hardcoded
  `version` field from both `composer.json` files — `composer
  validate --strict` treats it as an error in
  Packagist-published libraries because Packagist always infers
  the version from git tags. `syrotp/laravel`'s
  `repositories[].path.options` gains a `versions` override
  pinning `syrotp/sdk` to `0.1.0` for the in-tree local path repo
  so local development still resolves; this override has zero
  effect on real Packagist consumers (the `repositories` block
  in a library is NOT propagated to consumers).
- **`apps/gsm-gateway/pyproject.toml`**: license flipped from
  `text = "MIT"` to `file = "LICENSE"` and the
  `License :: OSI Approved :: MIT License` classifier was
  dropped — the Core License is source-available, not
  OSI-approved.
- **`author` standardized** to `Muhammed Shekho (SYR-ROOT)`
  across every publishable package's manifest (no email in any
  published metadata).

### Infrastructure

Six new CI dry-run jobs in `.github/workflows/ci.yml`, all
running on every PR + push to `main`:

- **`npm dry-run`** — `pnpm publish --dry-run` for `@syrotp/sdk`,
  `@syrotp/react`, `@syrotp/web-component`.
- **`pypi dry-run`** — `python -m build` + `twine check` for
  `syrotp-sdk` (Python 3.12 + `build` + `twine`).
- **`packagist dry-run`** —
  `composer validate --strict --no-check-lock --no-check-publish`
  + `composer install --no-dev --prefer-dist` for `syrotp/sdk` +
  `syrotp/laravel` (PHP 8.3).
- **`maven dry-run`** — `gradle publishToMavenLocal` for
  `dev.syrotp:sdk-kotlin` + `dev.syrotp:android-ui` (Java 17 +
  `android-actions/setup-android@v3` + Gradle).
- **`flutter publish dry-run`** — `flutter pub publish --dry-run`
  for `syrotp_flutter` (Linux, `subosito/flutter-action@v2`).
- **`swift publish dry-run`** — `swift package describe` for
  `SyrotpSDK` + `SyrotpSwiftUI` (macos-14, since `SyrotpSwiftUI`
  imports SwiftUI which doesn't compile on Linux).

### Notes

- **No package is actually published.** Real publishing flips on
  per-registry once the ownership checklist in
  [`docs/publishing.md`](docs/publishing.md) closes — at minimum:
  namespace claimed, two maintainers with publish rights, MFA
  enforced where supported, CI publishing token issued + scoped
  to publish-only.
- **No version bumps in published metadata.** Per-package
  versions stay where they were
  (`0.1.0` for the npm / Python / PHP / Flutter packages;
  `0.0.0-dev` placeholder for the Kotlin / Android-UI Maven
  artifacts; Swift packages are tag-driven). Real version
  assignment happens at first publish.
- **No SYOTP rebrand.** Per the agreed plan, the SYROTP → SYOTP
  public-brand rename is a separate concern, staged across later
  versions, and explicitly NOT in v0.7.
- **Production hardening (v0.8 — BYOG) is next.** The one real
  security gap surfaced during v0.7 — phone-number-to-app
  binding (a dishonest gateway can fake the inbound's
  `from_e164`) — is documented internally as a v0.8 priority
  and must land as a HARD invariant (not a soft warning) before
  scaled BYOG deployment.

## [0.6.0] — 2026-05-03

The **Mobile & UI Layer** release. v0.5 turned SYROTP into a
product-integration toolkit (hosted page, webhooks, multi-receiver
routing, WebAuthn fallback). v0.6 ships first-party UI components
across every major mobile and web stack so developers can drop the
verification flow into their existing apps without writing the
polling loop themselves. **No server changes** — every component
talks to the public `/v/:id/status` endpoint shipped in v0.5.0.

### Added

- React verification component `@syrotp/react`
  (`packages/react/`). `<SyrotpVerification />` + headless
  `useSyrotpVerification` hook. `peerDependencies: react ^18 || ^19`.
- Framework-agnostic Web Component `<syrotp-verification>`
  (`packages/web-component/`). Native Custom Elements + Shadow DOM,
  zero runtime dependencies. Auto-registers on import. Exports
  `defineSyrotpVerification` for custom tag names and
  `VerificationController` for headless consumers.
- Android Compose verification UI (`packages/android-ui/`).
  Two-module Gradle project: `:library` ships the `dev.syrotp:ui`
  AAR with `SyrotpVerificationScreen` (Material 3) +
  `VerificationController` (pure-Kotlin StateFlow + coroutines);
  `:demo` ships a runnable APK. Min SDK 24, Compose BOM 2024.10,
  Kotlin 2.0.21, AGP 8.7.
- Flutter verification widget package `syrotp_flutter`
  (`packages/flutter/`). Multi-platform (Android, iOS, web, macOS,
  Linux, Windows). `SyrotpVerificationWidget` (Material 3) +
  `VerificationController` (a `ValueNotifier<VerificationState>`).
  SMS handoff via `url_launcher`. Dart `>=3.0.0`,
  Flutter `>=3.10.0`.
- SwiftUI verification component `SyrotpSwiftUI`
  (`packages/swift-ui/`). iOS 15+ and macOS 12+. `VerificationView`
  (SwiftUI) + `VerificationController` (`@MainActor
  ObservableObject` with Task-driven async polling).
- Optional **`webauthnFallbackUrl`** prop on `SyrotpSwiftUI`'s
  `VerificationView`. When set, surfaces a "Use a passkey instead"
  link that opens the operator-supplied URL via
  `@Environment(\.openURL)`. Mirrors the SYROTP server's
  `WEBAUTHN_FALLBACK_URL` semantics from v0.5.0 PR #23. The view
  itself does NOT implement WebAuthn — it just hands the user off.
  Backporting to React / Web Component / Android-UI / Flutter is a
  follow-up.

### Notes

- All UI components consume the **public, IP-rate-limited
  `/v/:id/status`** endpoint shipped in v0.5.0. No new server
  endpoints, no new env vars, no migrations.
- **UI packages do not read SMS messages.** None of the components
  request SMS-read permissions; the user opens their own SMS app
  via a `sms:` deep link and sends the verification message
  themselves. That's the reverse-OTP threat model.
- The polling/state-machine logic is duplicated across the five UI
  packages. Cross-stack consolidation was considered and deferred:
  Kotlin / Swift / Dart can't import a JS class, and the *real*
  shared layer (the wire contract + state transitions) is already
  pinned by `docs/sdk-contract.md` and the integration test suite.
- **Cross-stack SMS body encoding** is byte-identical: `%20` for
  spaces, percent-encoded `?`/`&`/`#`. React + Web Component use
  the browser's `encodeURIComponent`; Flutter uses
  `Uri.encodeComponent` (matches by default); Android patches
  Java's `URLEncoder` output (`+ → %20`); Swift restricts
  Foundation's percent-encoding to the RFC 3986 unreserved set.
- **Android Gateway remains separate.** `apps/gsm-gateway/`
  (Python) is the SMS receiver; `packages/android-ui/` is a
  client-side UI library. They share a wire contract, nothing else.

## [0.5.0] — 2026-05-03

The **product integration layer** release. v0.4 made SYROTP useful as
a server + SDK toolkit; v0.5 turns it into something that can host
the full verification flow end-to-end — a hosted page the user
visits, server-to-server callbacks the host app subscribes to,
multi-receiver routing for carrier-aware deployments, and a passkey
fallback for users who can't receive SMS at the moment. **No
breaking wire-format changes** — every existing v0.4 client keeps
working.

### Added

- **Hosted verification page** at `GET /v/:id` (HTML) +
  `GET /v/:id/status` (JSON polling). Server-rendered from the same
  Fastify server, strict CSP with per-request script nonce, no
  external resources. Disabled with `HOSTED_PAGE_ENABLED=false`.
  Apps can hand the user a ready-to-go URL instead of building their
  own front-end.
- **Webhook callbacks** with HMAC-signed delivery + at-least-once
  retry worker:
  - Endpoint CRUD at `/v1/webhooks` (sk_live_* gated). Secret
    returned ONCE on creation; stored as AES-GCM ciphertext with an
    AAD-bound `webhook:<id>` so a row swap won't validate.
  - Event types `verification.{verified,expired,cancelled}` emit
    inside the lifecycle transaction — a state change without its
    event (or vice versa) is impossible.
  - Same-process delivery worker (`WEBHOOK_WORKER_ENABLED`,
    `WEBHOOK_WORKER_INTERVAL_MS`) with `FOR UPDATE SKIP LOCKED`
    claim, soft 60s in-flight lease, and the spec retry table
    `(0s, 30s, 2m, 10m, 30m, 2h)` capped at 6 attempts and a 5s
    per-attempt timeout.
  - 5 outbound headers on every delivery (`X-SYROTP-Webhook-{Id,
    Timestamp,Signature,Event,Attempt}`) plus a Node verifier
    example in [`docs/webhooks.md`](docs/webhooks.md).
- **Multi-receiver routing** with operator-aware fallback. New
  optional `operator` field on `POST /v1/verifications`:
  - When set, the router prefers a healthy receiver whose
    `operator` matches; if none is healthy, falls back to any
    healthy receiver (no `503 no_receiver` just because the
    preferred carrier is offline).
  - New metric
    `syrotp_receiver_selected_total{match=preferred|fallback|none}`.
  - Cardinality-disciplined: no labels with receiver_id or
    operator name.
- **Stable receiver snapshots on verification rows.** Migration
  0003 adds `receiver_msisdn_snapshot` + `receiver_operator_snapshot`
  to `verifications`. The hosted page reads from the snapshot
  first, falling back to the receivers join only for pre-existing
  rows. A later in-place `UPDATE receivers SET msisdn = …` does
  NOT shift the displayed number after the user has already read
  the SMS instructions.
- **WebAuthn fallback** at `/v1/webauthn/{register,login}/{options,verify}`,
  disabled by default. Set `WEBAUTHN_ENABLED=true` plus `RP_ID` /
  `ORIGINS` to mount; with the flag off every probe under that
  prefix returns 404 (no auth surface to attack).
  - Crypto + spec compliance delegated to
    [`@simplewebauthn/server`](https://simplewebauthn.dev/) v13.
  - Single-use, TTL'd challenges (`webauthn_challenges`); raw
    challenge bytes never appear in logs (canary test).
  - Credential ids stored as HMAC-keyed hashes
    (`webauthn_credentials`); raw id never persisted at rest.
- **Hosted page passkey fallback link.** When
  `WEBAUTHN_FALLBACK_URL` is set, the pending verify panel renders
  a footer link "Can't receive SMS? Use a passkey instead." that
  points to the operator-configured URL. The hosted page does NOT
  inline the WebAuthn ceremony itself — the host app's fallback
  page owns the UX.

### Security

- Webhook payloads exclude full phone numbers, SMS bodies, OTP
  codes, API keys, the gateway signing key, and the receiver id.
  The `data` block is a strict whitelist (`verification_id`,
  `status`, `phone_masked`, `purpose`, `client_ref`, one event-
  specific timestamp). Substring-sweep canaries pin every leak
  category in the integration suite.
- Webhook deliveries are HMAC-signed over the **exact body bytes**
  plus the timestamp (`HMAC-SHA256(secret, "<ts>.<body>")`). A
  single byte flip on the wire invalidates the signature; receivers
  that re-serialize JSON before hashing will fail verify (by design).
  Outbound `redirect: "manual"` so a misconfigured endpoint pointing
  at a 30x to a third party doesn't silently leak the signed body.
- WebAuthn challenges are single-use (`used_at` stamped inside a
  `FOR UPDATE SKIP LOCKED` tx) and expire by server time
  (`expires_at`); origin/rpID matching is the library's job, fed
  from `WEBAUTHN_ORIGINS` / `WEBAUTHN_RP_ID`.
- WebAuthn credential ids are stored as HMAC-keyed hashes — a
  DB-only leak doesn't index back to authenticator identifiers.
- Hosted page CSP: `default-src 'none'` plus a per-request script
  nonce. The polling JSON drops everything except `status` +
  timestamps; not even the verification id is echoed back.

### Changed

- `apps/server/src/services/verifications.ts`:
  - `cancelVerification`, `processInbound` (matching), and the
    three lazy-expire paths (`getVerification`,
    `getHostedVerification`, `getHostedVerificationStatus`) now
    run the state transition + the matching webhook event in one
    transaction. The lazy-expire path is consolidated into a
    single `lazyExpireAndEmit(id)` helper.
  - `pickReceiver(appId, preferredOperator?)` returns
    `{ id, msisdn, operator, match }`; `startVerification`
    populates the new `receiver_msisdn_snapshot` /
    `receiver_operator_snapshot` columns at INSERT time.
- `apps/server/src/routes/verifications.ts`: `POST
  /v1/verifications` accepts an optional `operator` field
  (`[a-zA-Z0-9_-]{1..32}`). `openapi.yaml` reflects the field.

### Migration notes

- Migrations `0002_webhooks.sql`, `0003_receiver_snapshots.sql`,
  `0004_webauthn.sql` apply forward-only. Pre-existing pending
  verifications are unaffected — the snapshot columns are nullable
  with a COALESCE fallback to the receivers join.
- New env vars (all default-safe; see `.env.example`):
  - `HOSTED_PAGE_ENABLED` (default `true`)
  - `WEBHOOK_WORKER_ENABLED`, `WEBHOOK_WORKER_INTERVAL_MS`
  - `WEBAUTHN_ENABLED` (default `false`), `WEBAUTHN_RP_ID`,
    `WEBAUTHN_RP_NAME`, `WEBAUTHN_ORIGINS`,
    `WEBAUTHN_CHALLENGE_TTL_SECONDS`, `WEBAUTHN_FALLBACK_URL`
- New runtime dep on the server: `@simplewebauthn/server@^13`.
  Only loaded when `WEBAUTHN_ENABLED=true`; deployments that
  don't enable WebAuthn pay the install-size cost but no runtime
  cost.

## [0.4.2] — 2026-05-03

The **Python framework helpers** batch. Builds on v0.4.0's sync
Python SDK with an async sibling, then wires both into FastAPI and
Django so apps can drop SYROTP into existing request lifecycles
without managing the client by hand. **No protocol changes** —
wire-compatible with v0.4.1.

### Added

- **`AsyncSyrotpClient`** in `packages/sdk-python/`. Async sibling of
  the v0.4.0 `SyrotpClient`. Same four methods, same seven typed
  errors, same retry numbers, same security canaries; only the call
  surface differs. Backed by `httpx.AsyncClient` (already a runtime
  dep — no new dependencies for the core SDK). Sync and async share
  one `Verification` / `VerificationStatus` enum and one set of
  retry constants in `_http.py`, so a regression in either fails
  the matching test in the matching file.
- **FastAPI helper** at `syrotp.fastapi`, behind the optional
  `syrotp-sdk[fastapi]` extra. Three pieces:
  - `SyrotpSettings` — Pydantic v2 Settings reading the canonical
    env vars (`SYROTP_BASE_URL`, `SYROTP_SECRET_KEY` falling back to
    `SYROTP_PUBLIC_KEY`, `SYROTP_TIMEOUT_MS`, `SYROTP_RETRIES`,
    `SYROTP_USER_AGENT`).
  - `setup_syrotp(app, settings=None)` — installs a lifespan that
    builds one `AsyncSyrotpClient` at startup and closes it at
    shutdown. Composes with any existing lifespan via
    `app.router.lifespan_context` so user resources outlive ours.
  - `get_syrotp` — FastAPI `Depends` that returns the singleton
    from `app.state`. Raises `RuntimeError` when `setup_syrotp` was
    forgotten — caught at request time, not silently 500'd.
- **Django helper** at `syrotp.django`, behind the optional
  `syrotp-sdk[django]` extra (Django 4.2+):
  - `get_syrotp_client()` — process-wide sync `SyrotpClient`
    singleton. Thread-safe via a double-checked lock; pinned by a
    20-thread hammer test.
  - `get_syrotp_async_client()` — `AsyncSyrotpClient` singleton
    scoped to the running event loop. Backed by a
    `WeakKeyDictionary` so test loops and ASGI-worker loops don't
    share `httpx.AsyncClient` state.
  - `close_syrotp_clients()` (sync) and `aclose_syrotp_clients()`
    (async) for explicit teardown.
  - Settings resolution order: `django.conf.settings.SYROTP_<NAME>`
    → `os.environ["SYROTP_<NAME>"]` → SDK defaults. Empty strings
    in Django settings fall through to env so a placeholder
    doesn't shadow a real value.
- **README** in `packages/sdk-python/` gains "Async usage",
  "FastAPI integration", and "Django integration" sections with
  end-to-end snippets for each.

### Changed

- `packages/sdk-python/pyproject.toml` declares two new optional
  extras (`[fastapi]`, `[django]`) and pulls `pytest-asyncio>=0.23`
  + `pytest-django>=4.8` into `[dev]`. The runtime deps of the
  core SDK are unchanged.
- `packages/sdk-python/tests/conftest.py` runs `django.setup()`
  with a minimal in-memory settings stub so importing
  `syrotp.django` from a test doesn't `ImproperlyConfigure`. Also
  adds an autouse fixture that resets the module-global Django
  singletons between tests.

### Migration notes

- No breaking changes. Existing v0.4.0 sync `SyrotpClient` callers
  are unaffected.
- FastAPI / Django helpers are opt-in via their extras —
  `pip install syrotp-sdk` continues to install only the core
  sync + async clients.
- Apps already integrating against the env-var convention (`syrotp`
  CLI, `scripts/smoke.mjs`, the v0.4.1 Laravel config) reuse the
  same env vars in FastAPI and Django.

## [0.4.1] — 2026-05-02

The **framework helpers** track. The plain-language SDKs from v0.4 were
intentionally minimal; v0.4.1 starts adding the framework-level
integrations that make the SDKs disappear into existing apps. **No
protocol changes** — wire-compatible with v0.4.0.

### Added

- **`syrotp/laravel`** — new Composer package at
  `packages/sdk-php-laravel/`. Laravel integration on top of
  `syrotp/sdk`:
  - `Syrotp\Sdk\Laravel\SyrotpServiceProvider` — singleton-binds
    `SyrotpClient` from `config('syrotp.*')`, aliases the FQCN to the
    string `"syrotp"`, publishes `config/syrotp.php` under the
    `syrotp-config` tag. Auto-discovered via
    `extra.laravel.providers`.
  - `Syrotp\Sdk\Laravel\Facades\Syrotp` — static-style proxy
    (`Syrotp::startVerification(...)`). **Not** auto-aliased to the
    global namespace; explicit `use` import only.
  - Publishable `config/syrotp.php` reading `SYROTP_BASE_URL`,
    `SYROTP_SECRET_KEY` (falling back to `SYROTP_PUBLIC_KEY`),
    `SYROTP_TIMEOUT_MS`, `SYROTP_RETRIES`, `SYROTP_USER_AGENT` — same
    env names as the `syrotp` CLI and `scripts/smoke.mjs`.
- **Laravel 11 / 12 on PHP 8.2 / 8.3** — Orchestra Testbench-driven
  test suite (14 tests / 29 assertions), 4-cell CI matrix.

### Changed

- `packages/sdk-php/composer.json` gained an explicit
  `"version": "0.1.0"` so the Composer path repo from `syrotp/laravel`
  resolves to a stable version satisfying `^0.1`. Runtime behavior of
  the SDK is unchanged.

### Migration notes

- No breaking changes. Existing v0.4.0 PHP SDK consumers are
  unaffected.
- Laravel apps can adopt with `composer require syrotp/laravel` +
  `php artisan vendor:publish --tag=syrotp-config`. Provider
  auto-discovery handles the `config/app.php` registration.

## [0.4.0] — 2026-05-02

The **SDK expansion** release. Five PRs that take SYROTP from one
official SDK (JS) to five, plus a normative cross-language contract
every SDK conforms to. **No protocol changes** — wire-compatible
with v0.3.x.

### Added

- **Cross-language SDK contract** (PR #9, no SDK code) — three
  normative documents that every SDK ships against:
  - `docs/sdk-contract.md` — required core API
    (`startVerification` / `getVerification` / `cancelVerification` /
    optional `waitForVerification`), standard client options, the
    five canonical statuses + an `Unknown` forward-compat case, the
    seven typed error classes (`SyrotpConfigError` /
    `SyrotpAuthError` / `SyrotpValidationError` /
    `SyrotpRateLimitError` / `SyrotpNetworkError` /
    `SyrotpServerError` / `SyrotpTimeoutError`), naming conventions
    per language.
  - `docs/sdk-generation.md` — codegen / authoring policy. Pins the
    canonical retry policy (base seconds `(0.0, 0.25, 0.5, 1.0, 2.0,
    4.0)`, ±40% jitter, capped at 4.0s), `Retry-After` honored on
    429, never-retry on 4xx-other / auth / validation / config /
    timeout, `cancelVerification` capped at one retry.
  - `docs/sdk-versioning.md` — SemVer rules,
    minimum-supported-server, version-skew matrix.
- **Python sync SDK** (PR #10, `packages/sdk-python/`) —
  `syrotp-sdk`, Python 3.10+, `httpx`-based. Four core methods, seven
  typed exceptions, security canaries (api_key / phone never in
  `str(error)` or on the SDK logger), forward-compat (unknown
  fields preserved on `Verification.extras`; unknown statuses →
  `VerificationStatus.UNKNOWN`). Live cross-stack proof in the smoke
  job. Async client + Django/FastAPI helpers deliberately deferred.
- **Kotlin / JVM SDK** (PR #11, `packages/sdk-kotlin/`) —
  `io.syrotp:syrotp-sdk`, JVM 17+, OkHttp 4 + kotlinx.serialization.
  MockWebServer-driven unit tests; live cross-stack proof in the
  smoke job. Multiplatform / Android / Compose deferred.
- **Swift SDK** (PR #12, `packages/sdk-swift/`) — `SyrotpSDK`
  Swift Package. Async/await on Apple platforms (iOS 15+ / macOS
  12+ / tvOS 15+ / watchOS 8+) and on Linux server-side Swift via
  `FoundationNetworking`. URLProtocol-mocked unit tests on macOS;
  live cross-stack proof on Linux Swift in the smoke job. SwiftUI /
  Keychain integration deferred.
- **PHP sync SDK** (PR #13, `packages/sdk-php/`) — `syrotp/sdk`,
  PHP 8.2+, Guzzle 7, PSR-3 logger. Hand-rolled retry + timeout +
  Retry-After honoring; Guzzle `MockHandler`-driven tests; live
  cross-stack proof in the smoke job. Laravel ServiceProvider /
  Facade deferred to v0.4.1.

### Cross-stack guarantees pinned by CI

Every SDK PR's smoke step runs the SDK's
`startVerification → cancelVerification` against the
freshly-built TS server in CI's `smoke` job. The check is the
literal stdout substring `"final status after cancel: cancelled"`
— if the SDK and server ever drift on wire shape, the smoke job
fails before the PR can merge.

### Migration notes

- No breaking changes. The protocol wire format and HTTP surface are
  unchanged from v0.3.x.
- The existing JS SDK (`@syrotp/sdk`) is untouched; new SDKs are
  additive.

## [0.3.0] — 2026-05-02

The **observability & operability** release. Once v0.2 stabilized
the operator surface, the visual / hardware / metrics layers landed
on top: Prometheus metrics for SREs, a read-only admin dashboard for
support, a Python USB GSM modem gateway as a second receiver option,
and a day-2 operations runbook. **No protocol changes** —
wire-compatible with v0.2.x.

### Added

- **Prometheus `/metrics` endpoint** (PR #5) — verification
  lifecycle counters, inbound match counters, HMAC / auth /
  rate-limit reject counters, latency histograms, and
  receiver-health gauges. **Cardinality-disciplined** — zero
  user-controlled labels (no phone, no api_key, no IP), so the
  prom-client time-series count stays bounded under high traffic.
- **Read-only `/admin` dashboard** (PR #6) — server-rendered HTML
  behind HTTP Basic Auth (`scrypt` + `timingSafeEqual`),
  **disabled by default**. Lists apps, receivers, and recent
  verifications with phone numbers masked and SMS bodies displayed
  only as length. Strict CSP, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`. Nine security properties
  (no key leaks, no header leaks, CSP enforced on every response,
  etc.) pinned by integration tests.
- **Python USB GSM modem gateway** (PR #7,
  `apps/gsm-gateway/`) — Linux + systemd alternative to the Android
  receiver. AT-command stack with multipart SMS reassembly,
  HMAC signing matched to the server's verifier byte-for-byte
  (cross-stack CI proof: flipping one byte in the Python signer
  fails the server's check), SQLite-backed inbound queue with
  exponential backoff and an attempt cap, periodic heartbeat thread.
- **Operator runbook** (PR #8, `docs/operations.md`) — day-2
  runbook covering metrics dashboards, the `/admin` view, both
  gateway flavors, smoke / loadtest expectations, alert thresholds,
  and three on-call runbooks (stale receiver, high unmatched rate,
  HMAC reject spike). Linked from the README as the ops quickstart.

### Security

- `/admin` Basic Auth credentials are hashed with `scrypt` and
  compared via `timingSafeEqual`. Plaintext passwords never touch
  disk or logs.
- The dashboard never renders raw API keys, signing keys, request
  bodies, or HMAC headers — those fields are masked at the template
  layer, not just the controller.

### Migration notes

- No breaking changes. Existing v0.2.x deployments need no
  migration. Both new endpoints (`/metrics`, `/admin`) are
  additive and opt-in via env vars.

## [0.2.0] — 2026-05-02

The **operator CLI** release. Operators run `syrotp doctor`, `syrotp
bootstrap`, `syrotp receiver`, `syrotp smoke`, and `syrotp loadtest`
instead of stitching together docker compose, direct Postgres queries,
shell scripts, and copy-pasted env exports. **No protocol changes** —
the wire format is identical to v0.1.x.

### Added

- **`@syrotp/cli`** — new package at `packages/cli/`, exposing the
  `syrotp` bin. Built on a stable foundation:
  - **Stable exit codes** as a public contract: `0=OK`, `1=RUNTIME`,
    `2=USAGE`, `3=MISSING_CONFIG`, `4=MISSING_DEP`, `5=UNREACHABLE`.
    These will not change across minor versions.
  - Typed `CliError` rendering with hint + exit-code lines.
  - Zero-dep argv parser; no commander/yargs.
  - Honors `NO_COLOR` and non-TTY stdout (CI-safe by default).
  - `main(argv, opts?)` accepts a Writable for output, so unit tests
    capture without colliding with node:test's IPC-on-stdout.
- **Commands**:
  - `syrotp doctor` — 11 checks across Environment / Configuration /
    Reachability. Skips reachability probes when their env var is unset
    (clean exit 3 instead of 5). Cross-platform: handles the Windows
    `pnpm.cmd` / `npx.cmd` shim correctly.
  - `syrotp bootstrap` — wraps `apps/server/src/admin/bootstrapApp` +
    `addReceiver`. Same DB writes the legacy script does. Optional
    `--simulate-heartbeat` for test/CI flows where no real gateway is
    paired. **Secret + signing keys printed exactly once.**
  - `syrotp receiver add | list | disable | test` — CRUD plus an
    HMAC-signed probe (`receiver test`) that verifies the gateway
    pairing without involving a real phone or pending verification.
    `list` supports `--json` for scripting.
  - `syrotp smoke` — pre-flights env + `/v1/health`, then spawns
    `node scripts/smoke.mjs`.
  - `syrotp loadtest quick` — wraps `pnpm loadtest:quick`.
  - `syrotp loadtest release-baseline [--continue-on-fail] [--csv]` —
    wraps `pnpm --filter @syrotp/loadtest start suite release-baseline`.
    Flags are scoped: the quick path rejects them with USAGE.
  - `syrotp version`, `syrotp help [<topic>]`, plus `--help` / `-h` /
    `--version` / `-v` aliases.
- **`apps/server/src/admin/`** — extracted reusable helpers from the
  legacy `dist/scripts/bootstrap.js`. Exposed via package.json exports:
  - `@syrotp/server/admin` — `bootstrapApp`, `addReceiver`,
    `listReceivers`, `disableReceiver`, `closeDb`, `AdminError`.
  - `@syrotp/server/admin/probe` — `testReceiver` in isolation (no
    db/redis import) so callers can probe a gateway without a DB.
- **Root `pnpm syrotp`** convenience alias in package.json.
- **`packages/cli/README.md`** — full surface documentation, design
  principles, exit-code contract.
- **30 new CLI tests** (`93/93` total in the CLI package), covering
  every USAGE / MISSING_CONFIG / UNREACHABLE / RUNTIME branch with
  injectable `Spawner` + `HealthProbe` (no real subprocess forks).

### Changed

- **Root `README.md` Quickstart** rewritten to lead with the CLI:
  `pnpm syrotp doctor → bootstrap → receiver list → receiver test →
  smoke → loadtest quick`. Manual `docker compose exec server node
  dist/scripts/bootstrap.js` paths are kept as fallbacks under
  "Manual commands".
- `apps/server/src/scripts/bootstrap.ts` (legacy CLI) now calls the
  shared `bootstrapApp` + `addReceiver` helpers. No duplicated crypto
  or wrap logic. New `--simulate-heartbeat` flag for parity with
  `syrotp bootstrap`. Force-exits the process after closing the DB so
  the eager Redis connection in `lib/redis.ts` doesn't keep the event
  loop alive.

### Fixed (pre-existing v0.1.1 test bugs that surfaced in CI)

- `apps/server/package.json` and `packages/sdk-js/package.json` test
  scripts used a `'src/**/*.test.ts'` glob that node:test never
  expanded — the suites silently ran zero tests. Replaced with explicit
  file lists.
- `matching.test.ts` imported from `matching.ts` which transitively
  loads `config.ts` — config validates env at import and process.exits.
  Added a placeholder env block + dynamic import so the pure
  `extractCode()` test runs without a real DB.
- T9 (inbound suite): the body-byte tamper used a string the JSON body
  doesn't actually contain. Tamper now flips one digit of the sender
  phone, which is guaranteed to be present.
- T16 (logs suite): `const headers` was declared inside `try { }` and
  referenced after the try/finally → `ReferenceError`. Lifted the
  declaration out and added an exhaustive null guard.
- `scripts/smoke.mjs` now sends a heartbeat before starting the
  verification — bootstrap doesn't set `last_heartbeat_at`, so a
  freshly-bootstrapped receiver was rejected by `pickReceiver` with
  `no_receiver`. The smoke flow now simulates a gateway heartbeat
  explicitly.
- `.github/workflows/ci.yml` builds before typechecking — cross-package
  type imports (`@syrotp/cli` → `@syrotp/server/admin`) resolve through
  the exports map to `dist/`, which has to exist first.
- `.github/workflows/ci.yml` and `release-baseline.yml` set high
  `RATE_LIMIT_*_PER_MIN` for the CI loadtest jobs — the load tool
  drives traffic from a single IP and would otherwise be 429'd by the
  production-realistic defaults.

### Migration notes

- No breaking changes. Existing v0.1.x deployments do not need
  migrations. The new CLI is purely additive.
- Operators previously using
  `docker compose exec server node dist/scripts/bootstrap.js ...` can
  switch to `pnpm syrotp bootstrap ...` — same DB writes, friendlier
  output, secrets-shown-once footer.

## [0.1.1] — 2026-05-02

Load & reliability baseline. No protocol changes; this release is about
proving v0.1.0 stands up to realistic concurrent traffic and giving us
numbers we can quote publicly.

### Added

- **`@syrotp/loadtest`** — black-box load testing tool at `tools/loadtest/`.
  - 11 scenarios: full-flow A/B/C, start-only, inbound-only, status-polling,
    mixed workload, replay storm, wrong-code storm, receiver-disabled
    mid-flight.
  - Worker pool with configurable concurrency (default 50).
  - Per-operation latency histogram with p50 / p95 / p99 / mean / min / max.
  - Per-operation outcome classification:
    `ok / expected_4xx / unexpected_4xx / err_5xx / network_err / timeout`.
  - Protocol extras (matched, no_match, replay_rejected, status_verified,
    rate_limited, …) tracked alongside.
  - Two fixture modes:
    - **Auto-prep** — creates app + keys + N receivers via direct DB
      inserts, mirroring the production bootstrap exactly.
    - **BYO env** — for CI / pre-paired environments.
  - Per-run artifact directory: `report.json`, `summary.md`, optional
    `ops.csv`. Captures git commit, Node version, host, target, redacted
    env summary, memory snapshot.
  - **Acceptance gating** with sensible per-scenario defaults
    (p95 ≤ 400ms cross-platform local, success ≥ 99.9%, no 5xx, no
    double-verifications). Failed acceptance = non-zero exit code.
- **Suites** — `pnpm loadtest suite <name>` runs an ordered list of
  scenarios, writes per-step reports into nested folders, and emits ONE
  aggregate report (`aggregate.json` + top-level `summary.md`) at the
  suite root.
  - `release-baseline` — five-step gate: `scenario-a → scenario-b
    (workers=100) → replay-storm → wrong-code-storm → receiver-disabled`.
    The release gate before tagging any version.
  - `--continue-on-fail` — keep running remaining steps after a failure
    (useful for triage); without it the suite stops on first failure
    (faster CI feedback).
  - **Hard safety totals** aggregated across all steps:
    `double_verifications`, `unhandled_exceptions`, `err_5xx`,
    `network_err`, `timeout`. The suite is PASS **only** if every step
    passes **and** every hard-safety counter is zero.
- **Top-level scripts**:
  - `pnpm loadtest <scenario>` — single scenario.
  - `pnpm loadtest:quick` — `scenario-a --workers 50` + `replay-storm`,
    suitable for the regular CI gate.
  - `pnpm loadtest:all` — alias of `loadtest suite release-baseline`.
- **CI**:
  - The default `ci.yml` workflow now runs `loadtest:quick` after the
    smoke step on every push, with relaxed p95 targets (500 ms) for
    shared CI hardware. Reports uploaded as artifacts.
  - A new `release-baseline.yml` workflow runs the full suite on tag
    pushes and via `workflow_dispatch`, with 90-day artifact retention.
- **`docs/performance.md`** — published reference numbers, reproduction
  steps, what we monitor in production, and known scaling boundaries.

### Acceptance baselines (release-baseline suite, Windows + Docker Desktop)

Single-laptop reference numbers from the actual v0.1.1 baseline run.
Linux native typically shows 30–50% lower p95s. Generate your own before
quoting in production capacity plans — see `docs/performance.md`.

| Scenario | p95 start | p95 inbound | p95 status | Success |
|---|---:|---:|---:|---:|
| scenario-a (1 receiver / 1k @ 50 workers)  | ~194 ms | ~196 ms | ~86 ms  | 100% |
| scenario-b (1 receiver / 10k @ 100 workers) | ~328 ms | ~317 ms | ~144 ms | 100% |
| replay-storm (1k)                          | — | ~46 ms  | — | 1000/1000 rejected (401) |
| wrong-code-storm (1k)                      | — | ~131 ms | — | 1000/1000 `no_match` |
| receiver-disabled (1k, graceful failover)  | ~178 ms | ~152 ms | ~88 ms  | 100% |

Hard safety across all five steps: **0 double-verifications, 0 unhandled
exceptions, 0 err_5xx, 0 network_err, 0 timeout**.

### Process

- `pnpm loadtest <scenario>` is now the documented way to validate a
  release candidate before tagging.
- Acceptance gating in CI (planned to be wired into the release workflow
  once we have a stable runner — open issue).

## [0.1.0] — 2026-05-02

First public preview. Protocol is **not** stable yet — endpoints, headers,
and database shape may change before 1.0.

### Added

- **Protocol** — `openapi.yaml` v0.1 covering: start verification, get status,
  cancel, inbound SMS, receiver heartbeat. Stable error envelope with
  documented codes.
- **Server** (`@syrotp/server`) — Fastify + TypeScript + Drizzle on Postgres
  with Redis. Built-in:
  - API key auth (`pk_live`, `sk_live`, `gw_live`)
  - HMAC-signed inbound endpoint (`<ts>.<nonce>.<sha256(body)>`)
  - Per-IP rate limits, per-receiver rate limits, per-phone pending caps
  - Atomic match-and-claim via `UPDATE … WHERE status='pending'`
  - Audit log table
  - Pino logger with redaction of `Authorization`, `X-SYROTP-Signature`,
    `Cookie`
  - Forward-only SQL migration runner
  - Bootstrap CLI: creates app + keys + receiver in one command
- **Encryption at rest** — receiver signing keys are stored as AES-256-GCM
  ciphertext keyed by `MASTER_ENCRYPTION_KEY`, with AAD bound to the
  receiver id (cross-row swap fails to decrypt).
- **JS SDK** (`@syrotp/sdk`) — universal client (Node 18+, browsers, Bun,
  Deno, edge runtimes). Includes `startVerification`, `getVerification`,
  `cancelVerification`, `waitForVerification`. Typed errors via
  `SyrotpError`. Configurable timeout + abort signal.
- **Web demo** — vanilla HTML/JS, no build step. RTL Arabic UI.
- **Android Gateway** — Kotlin app with:
  - SMS receiver + concatenation of multipart messages
  - On-disk inbound queue (crash-safe)
  - WorkManager-driven upload worker with attempt cap
  - Periodic heartbeat (15 min)
  - `EncryptedSharedPreferences` for the signing key (AES-256-GCM via
    Android Keystore)
  - Network security config that forbids cleartext by default
  - Excluded from cloud backup and device-to-device transfer
- **Docker compose** — Postgres + Redis + server, with hardened defaults:
  `cap_drop: ALL`, `read_only: true`, `no-new-privileges`, non-root user
  in the runtime image, healthchecks on every service.
- **Integration test harness** — node:test based, covers all 22 protocol &
  security guarantees against a real Postgres + Redis. Runs via
  `pnpm test:integration`.
- **Unit tests** — code generation, HMAC, AES-GCM round-trip, phone
  normalization, SMS-body code extraction.
- **Smoke script** — `pnpm smoke` validates a running server end-to-end in
  under a second.
- **Documentation** — README with three paths (Quickstart, Android,
  Production checklist), `SECURITY.md` with a documented threat model,
  `docs/protocol.md`, `docs/architecture.md`, this changelog,
  `ROADMAP.md`, `KNOWN-LIMITATIONS.md`.

### Security

- All key/signature comparisons use `crypto.timingSafeEqual` via a
  length-equalized wrapper.
- Verification codes drawn from a 31-character unambiguous alphabet via
  `crypto.randomInt` (no modulo bias). Default length 6 → ~887M space.
- Replay protection: per-request nonce stored in Redis with `SET NX EX`.
- Signature payload includes a SHA-256 of the raw request body — flipping
  one byte invalidates the HMAC.
- Verification expiry compared against the server clock, not the
  gateway-supplied `received_at` (compromised gateway cannot backdate).
- Phone-bound matching: the inbound sender E.164 must equal the
  verification's target phone, enforced in the SQL `WHERE` clause —
  stranger SMS cannot bridge into another verification.
- Server refuses to boot with placeholder secrets when `NODE_ENV=production`.

### Known limitations

See [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md). Highlights:

- iOS cannot host a receiver gateway (Apple restriction).
- Hosted verification page (`/v/<id>`) not yet implemented (planned v0.4).
- Admin dashboard not yet implemented (planned v0.2).
- No CLI yet — operations are scripted via `bootstrap.js` and `psql`
  (planned v0.2).
- SDKs other than JS are planned for v0.3.

### Migration notes

N/A — first release.

[0.1.0]: https://github.com/SYR-ROOT/syrotp/releases/tag/v0.1.0
[0.1.1]: https://github.com/SYR-ROOT/syrotp/releases/tag/v0.1.1
[0.2.0]: https://github.com/SYR-ROOT/syrotp/releases/tag/v0.2.0
[0.3.0]: https://github.com/SYR-ROOT/syrotp/releases/tag/v0.3.0
[0.4.0]: https://github.com/SYR-ROOT/syrotp/releases/tag/v0.4.0
[0.4.1]: https://github.com/SYR-ROOT/syrotp/releases/tag/v0.4.1
[0.4.2]: https://github.com/SYR-ROOT/syrotp/releases/tag/v0.4.2
