# SYROTP v1.0 API Contract

**Status:** Normative wrapper around [`openapi.yaml`](../openapi.yaml). Tracks
the v1.0 protocol-freeze track (`info.version: 1.0.0-rc.1`).

## What this document is — and isn't

`openapi.yaml` is the **single source of truth** for the wire contract:
paths, methods, request/response schemas, status codes, headers, and the
exact set of error codes the server emits. SDKs and integrations MUST
treat any disagreement between prose and `openapi.yaml` as `openapi.yaml`
being right.

This document does three things `openapi.yaml` does not:

1. Maps the JSON-API surface to **stability tiers** so integrators can
   tell which surfaces v1.0 freezes and which ones it intentionally does
   not.
2. Catalogues the **auth surfaces** in one place — which credential
   format goes with which endpoint group.
3. Names the surfaces that are **explicitly out of the wire contract**
   (operational / end-user / admin) and points at where they're
   documented instead.

For the request/response shapes themselves, read `openapi.yaml`. For
the error model, read [`errors.md`](errors.md). For server ↔ SDK
version compatibility, read [`compatibility.md`](compatibility.md).
For the SDK-side conformance contract (option names, error class
hierarchy, retry policy), read [`sdk-contract.md`](sdk-contract.md).

## Stability tiers

Every endpoint in the JSON API falls into one of three tiers. The tier
determines what kind of change can land without a protocol MAJOR bump.

| Tier | Meaning | Allowed changes pre-`1.0.0` final | Allowed changes post-`1.0.0` |
| --- | --- | --- | --- |
| **Stable** | The wire contract is committed. Older SDKs MUST keep working. | Additive only — new optional fields, new optional endpoints, new error codes (SDKs already tolerate unknown). | Same. Removals or renames require a deprecation window per [`sdk-versioning.md`](sdk-versioning.md#6-deprecation-policy) and a protocol MAJOR. |
| **Stable, additive-feature** | Stable, but only mounts when an operator opts in via env. Calling code MUST tolerate `404` (feature off). | Same as Stable. The feature flag itself is not part of the contract — operators may flip it. | Same. |
| **Out of contract** | Not part of the SDK / integration surface. May change at any time. | Free to change. | Free to change. |

### Stable

Every `/v1/*` endpoint documented in `openapi.yaml` is **Stable** in
v1.0 unless explicitly tagged otherwise below. SDK conformance tests
([`sdk-contract.md#8`](sdk-contract.md#8-conformance-checklist)) lock
the wire shape; the path-coverage test
(`apps/server/test/suites/openapiContract.ts`) prevents drift between
server and spec.

### Stable, additive-feature

These endpoints are part of the v1.0 contract but only mount when the
operator opts in. Their JSON shapes are frozen the same as Stable
endpoints, but downstream code MUST handle a uniform `404` when the
feature is disabled.

| Endpoint group | Opt-in env | When the routes 404 |
| --- | --- | --- |
| `POST /v1/webauthn/{register,login}/{options,verify}` | `WEBAUTHN_ENABLED=true` AND `WEBAUTHN_RP_ID` AND `WEBAUTHN_ORIGINS` | Any of the three is missing/false. The plugin returns early; no route is registered. |
| `GET /v/{id}/status` | `HOSTED_PAGE_ENABLED=true` (default in dev; operator-opt-in in prod) | Plugin disabled. |

### Out of contract

The following surfaces ship from the same server process but are
**not** part of the v1.0 wire contract. They MAY change in any
release, including patch releases.

| Surface | Content type | Documented in |
| --- | --- | --- |
| `GET /metrics` | Prometheus exposition (`text/plain`) | [`monitoring.md`](monitoring.md) |
| `GET /v/{id}` | Hosted verification HTML page (end user) | [`operations.md`](operations.md) |
| `GET /admin*` | Operator dashboard (HTML + admin JSON, Basic-Auth gated) | [`operations.md`](operations.md) |

This split is also called out in `openapi.yaml`'s `info.description`.

## Endpoint groups

The catalogue below is keyed by endpoint group, with the auth surface
each one consumes. Field-level shapes live in `openapi.yaml` — this
table answers "what credential do I need?" at a glance.

| Group | Endpoints | Auth |
| --- | --- | --- |
| **Health** | `GET /v1/health` | none |
| **Verifications** | `POST /v1/verifications`, `GET /v1/verifications/{id}`, `POST /v1/verifications/{id}/cancel` | `pk_live_*` or `sk_live_*` (cancel is `sk_live_*` only) |
| **Inbound SMS** | `POST /v1/inbound/sms` | Receiver HMAC |
| **Receivers** | `POST /v1/receivers/{id}/heartbeat` | Receiver HMAC |
| **Webhooks** | `POST/GET /v1/webhooks`, `GET/DELETE /v1/webhooks/{id}` | `sk_live_*` |
| **Phone bindings** | `POST /v1/phone-bindings/start`, `GET /v1/phone-bindings/{id}`, `POST /v1/phone-bindings/{id}/revoke` | `sk_live_*` |
| **WebAuthn fallback** | `POST /v1/webauthn/{register,login}/{options,verify}` | `sk_live_*` |
| **Hosted page polling** | `GET /v/{id}/status` | none — verification id is the bearer |

## Auth surfaces

Three distinct credential formats hit the API. The server enforces a
clean separation: a credential of one kind cannot be used to call an
endpoint that wants another.

### `pk_live_*` — public key

Browser- and mobile-app-safe. Authorization header: `Authorization: Bearer pk_live_...`.
Permitted endpoints:

- `POST /v1/verifications` (start)
- `GET /v1/verifications/{id}` (poll status — masked view)

A leaked public key in a hostile browser cannot:

- Cancel verifications (cancel is `sk_live_*` only).
- Read full verification detail (the public-key view masks).
- Touch webhooks, bindings, or WebAuthn (those refuse with `403 forbidden`).

### `sk_live_*` — secret key

Backend-only. Authorization header: `Authorization: Bearer sk_live_...`.
Permitted endpoints: every endpoint a `pk_live_*` can call, plus:

- `POST /v1/verifications/{id}/cancel`
- All webhook CRUD
- All phone-binding ceremony endpoints
- All WebAuthn endpoints (when the feature is enabled)

A `sk_live_*` MUST NOT ship in any public artifact. SDKs that detect
a key starting with `sk_live_` in a browser-side construction warn
loudly per [`sdk-contract.md`](sdk-contract.md).

### Receiver HMAC — gateway authentication

Inbound SMS and heartbeat requests carry an HMAC-signed envelope
documented at `components.securitySchemes.GatewayHmacAuth` in
`openapi.yaml`. Headers (all required, all canonicalised lowercase by
the server):

```
X-SYROTP-Receiver:  rcv_<ulid>
X-SYROTP-Timestamp: <unix seconds>
X-SYROTP-Nonce:     <hex, ≥ 16 bytes>
X-SYROTP-Signature: hex(HMAC_SHA256(gateway_secret,
                       "<timestamp>.<nonce>.<sha256(raw_body_bytes)>"))
```

The signature input is constructed from the **raw** request body
bytes, not a re-serialised JSON string — gateways MUST sign before
any pretty-printer touches the payload. Servers MUST reject:

- timestamps older than `INBOUND_TIMESTAMP_SKEW_SECONDS` (default 300s)
- replayed nonces (cached for at least the skew window)
- signatures that don't match the canonical input

The receiver row stamped on the verification carries the `app_id`,
so HMAC verification implicitly authorises the right tenant — no
additional API key is needed on inbound.

### Operator Basic Auth — `/admin/*`

Out of the v1.0 wire contract. The dashboard is HTML behind
`@fastify/basic-auth`; credentials are `ADMIN_USER` + scrypt hash in
`ADMIN_PASSWORD_HASH`. See [`operations.md`](operations.md).

## Compatibility commitment for v1.0

When `1.0.0` ships, the project commits to:

1. **No breaking changes within `1.x`.** Every change to the v1.0
   wire contract is additive — new optional fields, new optional
   endpoints, new error codes. SDKs already speak forward-compat per
   [`sdk-versioning.md#4`](sdk-versioning.md#4-version-skew-policy).
2. **A deprecation window before any removal.** Removals require a
   protocol MAJOR bump (`2.0`) with a deprecation period of at least
   one MINOR cycle on every official SDK. Out-of-contract surfaces
   are exempt.
3. **`openapi.yaml` is authoritative.** Any disagreement between this
   document, [`errors.md`](errors.md), [`sdk-contract.md`](sdk-contract.md),
   or any prose doc and `openapi.yaml` is a bug in the prose. The
   path-coverage test prevents drift in the path dimension; future
   PRs will tighten schema-conformance for fields and error shapes.
4. **Out-of-contract surfaces stay out.** Adding new operator endpoints
   or hosted-page routes does not require a protocol bump. Promoting
   one to the v1.0 contract requires a documented decision and a MINOR
   bump.

## Reading the spec

A typical question and where to look:

| Question | Read |
| --- | --- |
| What's the request shape for endpoint X? | `openapi.yaml` |
| What error codes can endpoint X return? | `openapi.yaml` (per-response) and [`errors.md`](errors.md) |
| Is endpoint X stable in v1.0? | This document, [Stability tiers](#stability-tiers) |
| What credential do I send to endpoint X? | This document, [Endpoint groups](#endpoint-groups) |
| How does my SDK pin a server version? | [`compatibility.md`](compatibility.md) |
| What does my SDK have to do to be conformant? | [`sdk-contract.md`](sdk-contract.md) |
| What's the wire-level walkthrough of a verification? | [`protocol.md`](protocol.md) |
| How do I run multiple servers? | [`multi-instance-deployment.md`](multi-instance-deployment.md) |
