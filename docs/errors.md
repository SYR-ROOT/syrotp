# SYROTP Error Model

**Status:** Normative reference for the error envelope, status codes,
and the canonical list of error codes the v1.0 server emits.
[`openapi.yaml`](../openapi.yaml) is authoritative for per-endpoint
response codes; this document is the cross-endpoint reference.

For the SDK-side error class hierarchy and retry policy, see
[`sdk-contract.md#5`](sdk-contract.md#5-standard-error-taxonomy).

## Envelope

Every non-2xx response from the v1.0 JSON API uses the same envelope:

```json
{
  "error": {
    "code": "rate_limited",
    "message": "too many requests",
    "request_id": "01HZX...",
    "details": { "retry_after": 30 }
  }
}
```

Field rules:

- **`code`** — short stable identifier. SDKs MUST switch on `code`,
  never on `message`. Unknown codes MUST be surfaced as the catch-all
  `SyrotpServerError` rather than crashing — the project commits to
  additive code introductions inside `1.x` (see
  [`api-contract.md`](api-contract.md#compatibility-commitment-for-v10)).
- **`message`** — human-readable. SDKs MUST NOT include the API key,
  the request body, or any signing key in surfaced messages.
- **`request_id`** — server-issued correlator (the same id used in
  server logs). Always present on errors. SDKs MUST log it.
- **`details`** — optional, opaque to most consumers. Specific shapes:
  - `details.issues` on `validation_error` (a Zod-style issue list).
  - `details.retry_after` on `rate_limited` (seconds; mirrored by the
    `Retry-After` HTTP header).

## Status codes

| Status | When the server uses it |
| ---: | --- |
| **200** | Read or update succeeded. |
| **201** | Resource created (`POST /v1/verifications`, `POST /v1/webhooks`, `POST /v1/phone-bindings/start`). |
| **202** | Inbound SMS accepted (matched or not — the body discriminates). |
| **204** | Resource deleted (`DELETE /v1/webhooks/{id}`). |
| **400** | Validation / shape rejection at the API boundary. |
| **401** | Missing, malformed, or revoked credential. Also receiver-HMAC failures. |
| **403** | Credential is valid but cannot call this endpoint (kind mismatch, or `phone_not_bound` on `startVerification`). |
| **404** | Resource doesn't exist for this app. Also returned for routes that the operator has not enabled. |
| **409** | Conflict — request is well-formed but the resource is in the wrong state (e.g. cancelling a non-pending verification, duplicate inbound idempotency key). |
| **429** | Rate-limited. `Retry-After` header set. |
| **500** | Internal server error. The server logs full detail and returns a generic envelope. |
| **503** | Service unavailable — currently used for `no_receiver` and `webauthn_disabled` / `webauthn_misconfigured`. |

The server NEVER returns `307`/`308`. Clients SHOULD treat any
unexpected redirect as a misconfiguration and refuse to follow it.

## Canonical error codes

Authoritative list of the codes the v1.0 server emits, with the status
code each one uses and where in the codebase it originates. SDKs MAY
add codes for purely-local failures (`config_error`, `timeout`); those
SHOULD use the `SyrotpConfigError` / `SyrotpTimeoutError` classes per
[`sdk-contract.md#5`](sdk-contract.md#5-standard-error-taxonomy).

| Code | HTTP | Where it comes from |
| --- | ---: | --- |
| `validation_error` | 400 | Body / query / params failed Zod or Fastify-level shape validation. `details.issues` carries the issue list. |
| `bad_body` | 400 | Raw request body unavailable on a route that needed it (inbound / heartbeat). Indicates a proxy / framework bug, not a caller bug. |
| `invalid_purpose` | 400 | `purpose` failed the `^[a-zA-Z0-9_\-:.]{2,64}$` allow-list. |
| `invalid_phone` | 400 | The phone number could not be normalised to E.164. |
| `phone_type_not_allowed` | 400 | The phone number normalised but was rejected as premium / shared-cost / non-mobile. |
| `challenge_invalid` | 400 | WebAuthn challenge missing, expired, or already consumed. |
| `attestation_failed` | 400 | WebAuthn registration verification failed. |
| `assertion_failed` | 400 | WebAuthn login verification failed. |
| `unauthorized` | 401 | Missing or invalid credentials, or HMAC verification rejected. |
| `forbidden` | 403 | Credential is valid but lacks the kind required for this endpoint. |
| `phone_not_bound` | 403 | `startVerification` called for a phone without a `verified` row in `phone_bindings` for the calling app. Hard invariant — no soft / metrics-only mode. |
| `not_found` | 404 | Resource does not exist for the calling app, or the route is not mounted (operator hasn't enabled the feature). |
| `not_pending` | 409 | `cancelVerification` called on a verification that is not in `pending`. |
| `too_many_pending` | 409 | `startVerification` would push the phone past `MAX_PENDING_PER_PHONE`. |
| `already_bound` | 409 | `startBinding` called for `(app, phone)` that already has a `verified` binding. Revoke the existing binding first. |
| `receiver_disabled` | 409 | `startBinding` referenced a receiver that exists but is disabled. |
| `rate_limited` | 429 | Per-IP, per-receiver, or per-app bucket exceeded. `details.retry_after` and the `Retry-After` header carry the backoff. |
| `internal_error` | 500 | Unhandled server-side error. Server logs include the stack; the response intentionally does not. |
| `no_receiver` | 503 | No healthy receiver available to route this verification. |
| `webauthn_disabled` | 503 | A WebAuthn endpoint was hit while the feature is gated off. Should normally surface as 404 because the route doesn't mount; 503 covers a partial-misconfig edge case. |
| `webauthn_misconfigured` | 503 | `WEBAUTHN_RP_ID` or `WEBAUTHN_ORIGINS` is unset at request time. |

## Retryable vs non-retryable

The matrix below is what every official SYROTP SDK implements out of
the box (see [`sdk-contract.md#5`](sdk-contract.md#5-standard-error-taxonomy)
for the class taxonomy):

| Trigger | SDK retries? | Notes |
| --- | --- | --- |
| Network error (DNS, TLS, connection reset) | yes — bounded, jittered | Idempotent reads always; idempotent writes (DELETE) yes; non-idempotent writes (POST start) MUST NOT auto-retry past the first send unless the SDK can prove the original request never reached the server. |
| `429 rate_limited` | yes — bounded, respecting `Retry-After` | If `details.retry_after` is set, use it; otherwise fall back to exponential backoff with jitter. |
| `5xx` (other than 503 specific codes) | yes — bounded, jittered | Treat `internal_error` as a transient; alert if frequent. |
| `503 no_receiver` | yes — bounded, longer backoff | Operator condition; the SDK should not hammer. Consider failing the call after one or two attempts and surfacing to the user. |
| `503 webauthn_disabled` / `webauthn_misconfigured` | **no** | Operator misconfiguration; retrying won't help. |
| `400 validation_error` and friends | **no** | Caller bug. Surface to the user; do not retry. |
| `401 unauthorized` | **no** | Wrong / revoked key. Retrying with the same credential is pointless. |
| `403 forbidden` / `phone_not_bound` | **no** | Programmatic precondition failure. The caller MUST run the right ceremony first (e.g. complete a phone binding) before retrying. |
| `404 not_found` | **no** | Either the resource truly doesn't exist or the operator hasn't enabled the feature. Either way, retry won't help. |
| `409` (any code) | **no** | State conflict — re-read first, then decide. |

The general rule: **only retry on `5xx`, `429`, and network**. Every
other status surface MUST be returned to the caller without an
SDK-level retry.

## Logging requirements

When an SDK surfaces an error, it MUST include the `request_id` (when
present) in any log line. Operators correlating a user-side report
with server logs depend on this — the server log carries the
matching `requestId` field per
[`apps/server/src/plugins/errorHandler.ts`](../apps/server/src/plugins/errorHandler.ts).

SDK error logs MUST NOT include:

- The full API key (mask to `pk_live_...` / `sk_live_...` plus the
  last 4 chars at most).
- The raw request body (specifically: never log the OTP code, never
  log the binding nonce, never log the gateway HMAC headers).
- The bearer token's signature material from the response.

## Webhook delivery errors

Webhook delivery is a separate retry surface from the synchronous
HTTP API. The delivery worker (`services/webhookWorker.ts`) classifies
each attempt and either resolves it or schedules the next attempt
from the bounded backoff schedule:

```
attempt #1: 0s
attempt #2: 30s
attempt #3: 2m
attempt #4: 10m
attempt #5: 30m
attempt #6: 2h
```

Maximum 6 attempts total. After the last failure, the delivery is
marked `dead_letter` — operators can inspect `webhook_deliveries`
through the admin dashboard. See [`webhook-worker.md`](webhook-worker.md)
for the worker's full lifecycle.

Receiver expectations (the consumer endpoint):

- MUST return a `2xx` to acknowledge. Any `3xx` is treated as a
  rejection — `redirect: manual` on the worker side intentionally
  blocks redirect chains.
- MUST verify the `X-SYROTP-Signature` header against the body bytes
  before acting on the payload — see [`webhooks.md`](webhooks.md) for
  the canonical verification snippet.
- MUST return within the worker's per-attempt timeout (5 seconds).
  Slower responses are recorded as a timeout failure and retried per
  the schedule above.
- SHOULD be idempotent on the `event_id` field. The worker may
  deliver a single event more than once during operator failover.
