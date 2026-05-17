# SYROTP Compatibility Matrix

**Status:** Reference. The version-skew rules SDKs implement are
spelled out in [`sdk-versioning.md`](sdk-versioning.md); this document
is the operator-facing summary of which server release pairs with
which SDK versions and which features each release commits to.

For the v1.0 stability commitment itself, see
[`api-contract.md#compatibility-commitment-for-v10`](api-contract.md#compatibility-commitment-for-v10).

## Three numbers, one mental model

SYROTP has three independent versions (per
[`sdk-versioning.md#1`](sdk-versioning.md#1-the-three-versions)):

- **Protocol version** — `openapi.yaml` `info.version`. Currently
  `1.0.0-rc.1`. Frozen at `1.0.0` final.
- **Server version** — git tag on the repo (`v0.9.0`, `v1.0.0`, …).
- **SDK version** — each SDK package's manifest version.

The rest of this document is what those three numbers MUST satisfy
together.

## Protocol versions and server releases

| Server release | Protocol `info.version` | What landed |
| --- | --- | --- |
| `v0.1.0` | `0.1.0` | Initial wire contract — verifications, inbound, receivers, health. |
| `v0.2.0` – `v0.6.0` | `0.1.0` (unchanged) | All additions in this window were ancillary endpoints (admin, hosted page, webhooks, WebAuthn) or cross-stack SDKs / UI. **The OpenAPI spec was not updated** — see PR #46 for the realignment. |
| `v0.7.0` | `0.1.0` (unchanged) | Publishing readiness; no wire changes. |
| `v0.8.0` | `0.1.0` (unchanged) | BYOG hardening: phone-binding ceremony + `403 phone_not_bound` invariant on `startVerification`. **This is a hard prerequisite, not a soft one** — older SDKs that didn't run the binding ceremony will start receiving 403 from this server release. |
| `v0.9.0` | `0.1.0` (unchanged) | Multi-instance + ops; no wire changes. |
| `v1.0.0-rc.1` (this branch) | `1.0.0-rc.1` | OpenAPI realignment audit: documents everything shipped through `v0.9.0`. **No new wire behaviour** — this is the audit, not new endpoints. |
| `v1.0.0` (planned) | `1.0.0` | Frozen wire. The four v1.0-track PRs (api-contract docs, errors, compatibility, security) all merged. |

## SDK versions

All official SYROTP SDKs are still at their pre-v0.7 manifest versions
(see the v0.7 release notes — version assignment was deferred to first
real publish). The current state, all on `main` as of `v0.9.0`:

| SDK | Package | Version on `main` | Speaks |
| --- | --- | --- | --- |
| JavaScript / TypeScript | `@syrotp/sdk` | `0.1.0` | v1.0 wire (forward-compatible from `0.1.0` protocol — no breaking changes between then and `1.0.0`). |
| React | `@syrotp/react` | `0.1.0` | n/a (UI helper; consumes `@syrotp/sdk`). |
| Web Component | `@syrotp/web-component` | `0.1.0` | n/a (UI helper). |
| Python | `syrotp-sdk` | `0.1.0` | v1.0 wire. Async / FastAPI / Django helpers ship under extras (`syrotp-sdk[fastapi]`, `syrotp-sdk[django]`). |
| Kotlin / JVM | `dev.syrotp:sdk-kotlin` | `0.0.0-dev` | v1.0 wire. Maven group standardised to `dev.syrotp` in v0.7; Java package stays `io.syrotp.sdk`. |
| Swift | `SyrotpSDK` (SwiftPM) | git tag | v1.0 wire. |
| Swift UI | `SyrotpSwiftUI` (SwiftPM) | git tag | n/a (UI helper). |
| Flutter | `syrotp_flutter` | `0.1.0` | n/a (UI helper). |
| PHP | `syrotp/sdk` | `0.1.0` | v1.0 wire. |
| Laravel | `syrotp/laravel` | `0.1.0` | n/a (DI wrapper; consumes `syrotp/sdk`). |
| Android UI | `dev.syrotp:android-ui` | `0.0.0-dev` | n/a (UI helper). |

When `1.0.0` ships, every SDK MAJOR bumps in lockstep per
[`sdk-versioning.md#sdk-major-tracks-protocol-major`](sdk-versioning.md#sdk-major-tracks-protocol-major).

## Server ↔ SDK skew

The skew matrix below is what every SDK MUST tolerate. Pre-`1.0.0`,
the protocol stayed at `0.1.0` across every server release — so the
"different protocol MAJOR" row is hypothetical until `2.0.0` ever
happens.

| Skew direction | Protocol comparison | What happens |
| --- | --- | --- |
| Same MINOR, different PATCH | always compatible | No-op. SDKs treat patch deltas as noise. |
| SDK newer than server | same protocol MAJOR | SDK MUST detect missing fields gracefully (a v1.0 SDK calling a `0.x` server gracefully ignores fields the server doesn't return). |
| SDK older than server | same protocol MAJOR | MUST keep working. New server fields are ignored; new endpoints are simply not called. |
| Different protocol MAJOR | e.g. SDK on `1.x`, server on `2.x` | SDK MUST refuse to construct, with `SyrotpConfigError("server_too_old")` (or `server_too_new`). |

## Per-release operator requirements

| Server release | Action operators MUST take to upgrade from the previous release |
| --- | --- |
| `v0.7.0` | Nothing wire-side. Re-run `pnpm migrate` (none new in v0.7). |
| `v0.8.0` | **Run the phone-binding ceremony for every existing phone** before upgrading — `startVerification` returns 403 for any unbound `(app, phone)` after this release. The ceremony is a `sk_live_*` call from the developer backend; see [`phone-bindings.md`](phone-bindings.md). The Android gateway also migrates its signing key into AndroidKeyStore on first launch — operator action: install v0.8.0 of the gateway APK and observe the migration log line. |
| `v0.9.0` | Nothing required for single-instance. To opt into multi-instance: read [`multi-instance-deployment.md`](multi-instance-deployment.md). To split the webhook worker out of the API process: set `WEBHOOK_WORKER_ENABLED=false` on the API tier and run a dedicated `start:webhook` process. |
| `v1.0.0-rc.1` (this branch) | None. Audit-only. |
| `v1.0.0` (planned) | None. Freeze. |

## What "v1.0 ready" means

For a deployment to claim v1.0 readiness:

1. The server is on `v1.0.0` or later.
2. Every published phone has a `verified` row in `phone_bindings`
   (carry-over from v0.8 — pre-binding deployments needed to backfill).
3. Webhook receivers verify the HMAC signature on every delivery (no
   exceptions; the v1.0 signature scheme is frozen).
4. Operator dashboards understand the rate-limit + abuse-signal
   surfaces shipped in v0.8 / v0.9 (see [`monitoring.md`](monitoring.md)
   and [`operational-baseline.md`](operational-baseline.md)).
5. SDKs in production are on a release that speaks the `1.x` protocol
   MAJOR. Pre-`1.0.0` SDK versions remain wire-compatible — the gate
   is the protocol MAJOR, not the SDK MAJOR.

The v1.0 release will not require an SDK upgrade for working
integrations to keep working — the wire contract this freeze captures
is the same one v0.8 / v0.9 already shipped.
