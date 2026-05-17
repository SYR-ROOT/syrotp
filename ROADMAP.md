# Roadmap

SYROTP is **protocol-first**. We freeze the wire shape before adding new
client surfaces, so every SDK and gateway speaks the same dialect.

Versioning: from `1.0.0` onward the protocol is **locked** — every
change inside `1.x` is additive (new optional fields, new optional
endpoints, new error codes) and removals require a protocol MAJOR. See
[`docs/api-contract.md`](docs/api-contract.md#compatibility-commitment-for-v10)
for the full commitment.

## v1.0 — protocol freeze *(shipped 2026-05-04 as `v1.0.0`)*

The wire contract is frozen. Five docs-first PRs (#46–#50) — no new
features, no behaviour changes:

- ✅ #46 — OpenAPI realignment audit (`openapi.yaml` brought back in sync with everything shipped through v0.9; `info.version` → `1.0.0`).
- ✅ #47 — `docs/api-contract.md` + `docs/errors.md` + `docs/compatibility.md` wrappers around the spec.
- ✅ #48 — `docs/security-checklist.md`: threat model + 27 hard invariants + operator/developer/webhook checklists.
- ✅ #49 — `docs/upgrade-policy.md`: forward-only migrations, upgrade order, rollback by image-redeploy, backup expectations.
- ✅ #50 — release: `info.version` final bump, README + ROADMAP cleanup, `docs/release-checklist.md`, CHANGELOG `[1.0.0]` section, `v1.0.0` tag.

**Pre-1.0 caveats:** the `0.x` policy below — "minor versions may
change the protocol" — applied through `v0.9`. From `v1.0.0` onward
that no longer holds.

## v0.1 — first preview

Self-hosted core that real apps can integrate against.

- ✅ OpenAPI 3.1 contract
- ✅ Fastify server (Postgres + Redis)
- ✅ HMAC-signed inbound, replay protection, AAD-bound at-rest encryption
- ✅ JS SDK
- ✅ Web demo
- ✅ Android receiver gateway
- ✅ Docker compose
- ✅ 22-case integration test suite
- ✅ Smoke script

## v0.1.1 — load & reliability baseline

Numbers we can publish with confidence before adding new surface area.

- ✅ `@syrotp/loadtest` tool with 11 scenarios
- ✅ Latency histograms (p50/p95/p99) per operation
- ✅ Acceptance gating with per-scenario defaults
- ✅ JSON / Markdown / CSV report artifacts
- ✅ Auto-prep + BYO env fixture modes
- ✅ Receiver-disabled-mid-flight scenario (operability under churn)

## v0.2 — operator CLI

Operators run the CLI instead of stitching together docker compose +
direct SQL + shell scripts.

- ✅ `@syrotp/cli` package (`syrotp` bin)
- ✅ `syrotp doctor` — 11 checks across env / config / reachability
- ✅ `syrotp bootstrap` — app + keys + receiver in one shot
- ✅ `syrotp receiver` — add / list / disable / test (probe)
- ✅ `syrotp smoke` — wraps the end-to-end smoke flow
- ✅ `syrotp loadtest quick | release-baseline` — wraps the load suite
- ✅ Stable exit codes (0/1/2/3/4/5) as a public contract
- ✅ `apps/server/src/admin/` reusable helpers (no logic duplicated)

Deferred to later versions:

- [ ] **`syrotp keys rotate`** — re-wrap every receiver's signing key with
  a new `MASTER_ENCRYPTION_KEY`. Documented manual procedure exists; see
  SECURITY.md.
- [ ] **`syrotp init`** / **`syrotp migrate`** — for fresh deployments.
  Less critical now that `syrotp doctor` + `docker compose --profile
  migrate` cover the same ground.

## v0.3 — observability & operability *(shipped 2026-05-02)*

Once the CLI surface was stable, the visual / hardware / metrics
layers landed on top:

- ✅ **Prometheus `/metrics` endpoint** — verification counters, inbound
  match counters, HMAC/auth/rate-limit reject counters, latency
  histograms, receiver-health gauges. Cardinality-disciplined; zero
  user-controlled labels. (PR #5)
- ✅ **Read-only `/admin` dashboard** — server-rendered HTML behind
  HTTP Basic Auth (scrypt + timingSafeEqual), disabled-by-default,
  strict CSP, masked phones / length-only SMS bodies. 9 security
  properties pinned by tests. (PR #6)
- ✅ **Python USB GSM modem gateway** — Linux + systemd, AT commands,
  HMAC signing matched to the server byte-for-byte (cross-stack CI
  proof), SQLite queue with exponential backoff. (PR #7)
- ✅ **Operations runbook** — `docs/operations.md` covering metrics,
  admin, both gateways, smoke/loadtest, alerts, and three on-call
  runbooks (stale receiver / high unmatched / HMAC rejects spike).
  (PR #8)

Deferred:

- [ ] Receiver routing — pick by operator when the caller's phone has
  an inferable carrier.
- [ ] Manual test gateway inside the dashboard.
- [ ] React component + web component for drop-in UIs.

## v0.4 — SDK expansion *(shipped 2026-05-02)*

Stabilized the cross-language SDK contract, then built SDKs that
honor it. The order was deliberate: docs and policy landed first so
every SDK ships with the same shape.

- ✅ **PR 1 — SDK contract & codegen policy** — three normative
  documents: [`sdk-contract.md`](docs/sdk-contract.md),
  [`sdk-generation.md`](docs/sdk-generation.md),
  [`sdk-versioning.md`](docs/sdk-versioning.md). No SDK code; this is
  the spec every later PR builds against.
- ✅ **PR 2 — Python SDK** — `syrotp-sdk`,
  [`packages/sdk-python/`](packages/sdk-python/). Sync client only
  (start / get / cancel / wait_for, the seven typed errors, retry
  policy, security canaries, live cross-stack CI).
- ✅ **PR 3 — Kotlin/JVM SDK** — `io.syrotp:syrotp-sdk`,
  [`packages/sdk-kotlin/`](packages/sdk-kotlin/). JVM 17+, OkHttp 4 +
  kotlinx.serialization.
- ✅ **PR 4 — Swift SDK** — `SyrotpSDK` Swift Package at
  [`packages/sdk-swift/`](packages/sdk-swift/). Async/await on Apple
  platforms (iOS 15+/macOS 12+/tvOS 15+/watchOS 8+) and on Linux
  server-side Swift via `FoundationNetworking`.
- ✅ **PR 5 — PHP SDK** — `syrotp/sdk`,
  [`packages/sdk-php/`](packages/sdk-php/). PHP 8.2+, Guzzle 7,
  PSR-3 logger, sync client only.

## v0.4.1 — framework helpers *(in progress)*

The framework integrations deliberately split out of the SDK PRs so
the plain-language surfaces could settle first.

- [ ] **PR 1 — Laravel package** *(in progress)* — `syrotp/laravel`,
  [`packages/sdk-php-laravel/`](packages/sdk-php-laravel/).
  ServiceProvider + Facade + publishable config. Auto-discovered.
  Tested via Orchestra Testbench across Laravel 11/12 × PHP 8.2/8.3.
  Eloquent, Blade, queues, validation rules deliberately excluded.
- [ ] **PR 2 — Python async client** — `syrotp-sdk[async]`. The
  `httpx.AsyncClient` twin of the sync surface; same retries, same
  errors, same canaries.
- [ ] **PR 3 — FastAPI helper** — dependency-injection wrapper around
  the async client.
- [ ] **PR 4 — Django helper** — middleware + view helper around the
  sync client.

## v0.5 — hosted verification page & multi-receiver *(in progress)*

- [ ] **PR 1 — Hosted page** *(in progress)* — `GET /v/:id` (HTML) +
  `GET /v/:id/status` (JSON polling), server-rendered from the same
  Fastify server. Strict CSP with per-request script nonce, no
  external resources. Disabled by setting `HOSTED_PAGE_ENABLED=false`.
  Pre-built endpoints, webhook callbacks, multi-receiver routing,
  WebAuthn, and tenant theming are deliberately deferred to later
  PRs in this milestone.
- [ ] **PR 2 — Webhook gateway** — translates third-party inbound webhook formats
- [ ] **PR 3 — Multiple receivers per app** with health-aware routing
- [ ] **PR 4 — Optional WebAuthn fallback** for high-assurance flows

## v1.0 — stability commitment

- [ ] Wire format and DB schema frozen with documented migration story
- [ ] Production hardening (sustained load tests, soak tests, key rotation
  procedure with re-wrap migration)
- [ ] Grafana dashboard pack
- [ ] Signed gateway releases (APK + GSM gateway binaries)
- [ ] Complete docs site

## Beyond 1.0 (ideas, not commitments)

- Federated receivers across operators in different countries
- Built-in fraud signals (velocity per IP, per device, per ASN)
- E2E-encrypted inbound for regulated deployments
- Receiver-side operator-aware MNP lookup

---

If you'd like to own one of these, open a discussion before sending a PR
so we can align on the design — see [CONTRIBUTING.md](CONTRIBUTING.md).
