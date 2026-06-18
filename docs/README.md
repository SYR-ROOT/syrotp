# SYROTP Documentation Index

Navigation by audience. The wire contract itself lives in
[`../openapi.yaml`](../openapi.yaml) — that is the single source of
truth. Everything in this folder explains how to use, operate, or
reason about that contract.

## للمطورين العرب — العربية

دليل تكامل شامل بالعربية الفصحى يأخذك من الصفر إلى الإنتاج:
**[`ar/integration-guide.md`](ar/integration-guide.md)** — يغطّي البنية،
إعداد الخادم، ربط هاتفَي استقبال، أمثلة كود بأربع لغات (JS / Python /
PHP / Kotlin)، اختبار شامل، تشغيل في الإنتاج، واستكشاف الأعطال.

## I'm integrating against SYROTP (developer)

Read in this order:

1. [`api-contract.md`](api-contract.md) — what's stable in v1.0,
   stability tiers, endpoint groups by auth surface, and the v1.0
   compatibility commitment.
2. [`sdk-contract.md`](sdk-contract.md) — the cross-language SDK
   surface every official SDK exposes (option names, error class
   hierarchy, retry policy, conformance checklist).
3. [`errors.md`](errors.md) — error envelope, status codes, the 21
   server-emitted error codes, and the retryable-vs-not matrix.
4. [`compatibility.md`](compatibility.md) — server ↔ SDK matrix,
   per-release operator actions you must run before integrating.
5. [`webhooks.md`](webhooks.md) — webhook delivery contract,
   signature verification snippets, retry schedule.
6. [`phone-bindings.md`](phone-bindings.md) — the binding ceremony
   you MUST run before any `startVerification` call (v0.8+ hard
   invariant).
7. [`webauthn.md`](webauthn.md) — passkey fallback (operator opt-in).

## I'm operating an SYROTP deployment (operator)

Read in this order:

1. [`operations.md`](operations.md) — day-2 runbook for the
   single-process default mode.
2. [`security-checklist.md`](security-checklist.md) — threat model,
   the 27 hard invariants the server enforces, and the
   credentials/network/admin/binding/gateway/migrations/observability
   operator checklists.
3. [`monitoring.md`](monitoring.md) — Prometheus metrics catalogue
   and alert recommendations.
4. [`upgrade-policy.md`](upgrade-policy.md) — how to upgrade safely:
   forward-only migrations, upgrade order, rollback, backups,
   pre/post-upgrade checklists.
5. [`multi-instance-deployment.md`](multi-instance-deployment.md) —
   when and how to run N API + M worker against one Postgres + Redis.
6. [`multi-instance-safety.md`](multi-instance-safety.md) — audit
   artifact: which shared-state paths are safe under N processes and
   why.
7. [`webhook-worker.md`](webhook-worker.md) — the standalone worker
   process: lifecycle, fail-fast on misconfig, SIGTERM semantics.
8. [`receiver-fleet.md`](receiver-fleet.md) — receiver lifecycle
   (5 states), enable / disable, rotation.
9. [`operational-baseline.md`](operational-baseline.md) — what
   "ready-to-scale" means; soak suite; latency budget guidance.
10. [`android-gateway-keystore.md`](android-gateway-keystore.md) —
    AndroidKeyStore-bound signing key and the v0.8 migration shim.
11. [`gsm-gateway.md`](gsm-gateway.md) — Python USB GSM gateway
    operator guide (alternative to the Android gateway).

## I'm publishing an SDK or working on the protocol itself

Read in this order:

1. [`../openapi.yaml`](../openapi.yaml) — the wire contract.
2. [`api-contract.md`](api-contract.md) — the v1.0 stability
   commitment.
3. [`protocol.md`](protocol.md) — human-readable wire-format
   walkthrough.
4. [`sdk-contract.md`](sdk-contract.md) — SDK conformance contract.
5. [`sdk-versioning.md`](sdk-versioning.md) — SemVer, version skew,
   deprecation policy.
6. [`sdk-generation.md`](sdk-generation.md) — codegen policy,
   security rules, retry policy.
7. [`architecture.md`](architecture.md) — diagrams, trust
   boundaries, component-by-component overview.
8. [`performance.md`](performance.md) — latency / throughput
   reference numbers + how loadtests are structured.
9. [`publishing.md`](publishing.md) — per-registry publishing
   runbook (npm, PyPI, Packagist, Maven, Swift, pub.dev). Real
   publishing is a separate track from the protocol-freeze release.
10. [`release-checklist.md`](release-checklist.md) — the pre-tag
    gate the project runs before each release.

## Discovery aids

- Looking for an endpoint shape? Read [`../openapi.yaml`](../openapi.yaml).
- Looking for an error code's meaning? Read [`errors.md`](errors.md).
- Looking for what's frozen vs free to change? Read
  [`api-contract.md#stability-tiers`](api-contract.md#stability-tiers).
- Looking for the security guarantees? Read
  [`security-checklist.md#hard-invariants--must-never-regress`](security-checklist.md#hard-invariants--must-never-regress).
- Looking for what an upgrade looks like? Read
  [`upgrade-policy.md#upgrade-order`](upgrade-policy.md#upgrade-order).
- Looking for what to do after a release tag? Read
  [`release-checklist.md`](release-checklist.md).
