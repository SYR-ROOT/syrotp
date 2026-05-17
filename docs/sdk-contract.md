# SYROTP SDK Contract

**Status:** Normative. Every official SYROTP SDK MUST conform to this
document. Third-party SDKs are encouraged to.

This is the cross-language contract every SYROTP SDK speaks. It exists
so a developer who already learned the JS SDK can pick up the Python
or Kotlin SDK and find the same shapes, the same errors, the same
defaults, and the same edge-case behavior.

If this contract and the [`openapi.yaml`](../openapi.yaml) ever
disagree, the OpenAPI spec wins for **wire shape** (request/response
JSON, status codes, headers). This document wins for **library
ergonomics** (option names, error class taxonomy, default values,
retry behavior).

For how SDKs are generated and reviewed, see
[`sdk-generation.md`](sdk-generation.md). For SemVer rules and version
skew, see [`sdk-versioning.md`](sdk-versioning.md).

## Table of contents

1. [Required core API](#1-required-core-api)
2. [Optional helper API](#2-optional-helper-api)
3. [Standard client options](#3-standard-client-options)
4. [Standard verification statuses](#4-standard-verification-statuses)
5. [Standard error taxonomy](#5-standard-error-taxonomy)
6. [Naming conventions](#6-naming-conventions)
7. [Cancellation and abort](#7-cancellation-and-abort)
8. [Conformance checklist](#8-conformance-checklist)

---

## 1. Required core API

Every SDK MUST expose these three operations on its client object:

| Operation | HTTP | Returns | Notes |
| --- | --- | --- | --- |
| `startVerification(input)`   | `POST /v1/verifications`             | `Verification` (`status="pending"`)  | Required for all key kinds. |
| `getVerification(id)`        | `GET  /v1/verifications/{id}`        | `Verification` (any status)          | Required for all key kinds. |
| `cancelVerification(id)`     | `POST /v1/verifications/{id}/cancel` | `Verification` (`status="cancelled"`) | Server returns `409` if the verification is not pending. |

**Input shape** for `startVerification` MUST be the
[`StartVerificationRequest`](../openapi.yaml) schema, with field names
mapped to each language's idiomatic case (see
[Naming conventions](#6-naming-conventions)):

| OpenAPI field | Required | Notes |
| --- | --- | --- |
| `phone`       | yes | E.164 or local; server normalizes against the configured default region. |
| `purpose`     | yes | Free-form short label (`^[a-zA-Z0-9_\-:.]+$`, 2–64 chars). |
| `client_ref`  | no  | Opaque correlator the developer can store. |
| `locale`      | no  | BCP-47 tag, only meaningful when the hosted page is in use. |

**`Verification` shape** mirrors `Verification` in the OpenAPI spec
1:1. SDKs MUST NOT silently drop fields — if the server adds a new
field in a minor protocol bump, an older SDK MUST still surface it
(typically as a string-keyed extras map or as an additional getter).

## 2. Optional helper API

The following helpers are RECOMMENDED but not required. SDKs that ship
them MUST use these exact names and semantics:

| Helper | Behavior |
| --- | --- |
| `waitForVerification(id, opts)`  | Polls `getVerification` until the status is non-pending or the deadline expires. Default poll interval `2500ms`, minimum `2000ms` (the server enforces per-IP read rate-limits). Default deadline `5 * 60s`. |
| `formatInstruction(verification)` | Renders the user-facing instruction string for a pending verification (`"Send 'VERIFY A7K9P2' to +96399****"`) using only locally-available fields. Pure function. |
| `maskPhone(e164, opts?)`         | Display redaction matching the server's masking (`+96399****567` style). Pure function. |

These helpers MUST NOT make HTTP requests (other than the obvious one
in `waitForVerification`) and MUST NOT mutate the verification.

## 3. Standard client options

Every SDK MUST accept at least these options at construction time:

| Option       | Type    | Default        | Required | Notes |
| ---          | ---     | ---            | ---      | --- |
| `baseUrl`    | URL     | —              | yes      | Trailing slash optional; SDK MUST strip it. MUST reject anything that isn't `http://` / `https://`. |
| `apiKey`     | string  | —              | yes      | Sent as `Authorization: Bearer <apiKey>`. Either `pk_live_*` or `sk_live_*`. |
| `timeoutMs`  | int     | `15000`        | no       | Per-request deadline. **MUST NOT default to infinite.** |
| `retries`    | int     | `2`            | no       | Maximum retries for retriable failures (see [retry policy](sdk-generation.md#retry-policy)). `0` = no retry. |
| `userAgent`  | string  | empty          | no       | Suffix appended to the SDK's identifier. The SDK ALWAYS sets `User-Agent: syrotp-sdk-<lang>/<version>` and appends this if provided. |
| cancel/abort | (lang)  | (lang default) | no       | See [Cancellation and abort](#7-cancellation-and-abort). |

Any additional options (custom HTTP transport, logger, fetch override)
are language-specific and MUST be additive. They MUST NOT change the
defaults above.

The SDK MUST NOT silently use a different default if the user passes
an out-of-range value — it MUST raise `SyrotpConfigError`.

## 4. Standard verification statuses

The server returns exactly five terminal-or-pending values for
`Verification.status`:

| Status      | Meaning |
| ---         | --- |
| `pending`   | Created, awaiting an inbound SMS or cancellation. |
| `verified`  | A matching inbound SMS was received from the asked-for sender. |
| `expired`   | TTL elapsed before any matching inbound arrived. |
| `cancelled` | Cancelled via `cancelVerification`. |
| `failed`    | Server-side failure path (rare; used for unrecoverable mismatches). |

SDKs MUST surface these as a typed enum / union / sealed class — never
as a free string. Unknown statuses (forward-compat) MUST be surfaced
as a single `unknown` variant, not silently mapped to `failed`.

## 5. Standard error taxonomy

Every SDK MUST raise one of the seven typed error classes below. They
exist so application code can catch only the categories it cares
about (e.g. retry on `SyrotpNetworkError`, surface
`SyrotpValidationError` to the user, page on `SyrotpServerError`).

| Class | Triggers | Retriable by SDK? | Should the app catch? |
| --- | --- | --- | --- |
| `SyrotpConfigError`     | Construction-time validation failure (bad `baseUrl`, missing `apiKey`, out-of-range `timeoutMs`/`retries`). | no  | yes — fix and retry call. |
| `SyrotpAuthError`       | HTTP `401` / `403`. Bad or missing API key, or key kind not allowed for endpoint. | **no** | yes — surface as configuration bug. |
| `SyrotpValidationError` | HTTP `400` (server-side validation), or local input validation (e.g. malformed verification id). | **no** | yes — surface to the user, do NOT auto-retry. |
| `SyrotpRateLimitError`  | HTTP `429`. Exposes `retryAfterSeconds` (parsed from `Retry-After`). | yes (bounded), respecting `Retry-After` | yes — back off and retry, or queue. |
| `SyrotpNetworkError`    | DNS, TLS, connection refused, connection reset, broken response. | yes (bounded, jittered) | yes — surface as transient. |
| `SyrotpServerError`     | HTTP `5xx`. | yes (bounded, jittered) | yes — surface as transient; alert if frequent. |
| `SyrotpTimeoutError`    | The per-request deadline (`timeoutMs`) elapsed. | no — caller's deadline already expired | yes. |

Every error MUST carry:

- `code` — short stable string (e.g. `"validation_error"`,
  `"rate_limited"`). Maps to the server's `error.code` when the error
  came from the server.
- `message` — human-readable. **MUST NOT contain the API key** or any
  request body the SDK sent.
- `requestId` — the server-issued `request_id` from the response body
  if present, else `null`. SDKs MUST log this on error.
- `httpStatus` — HTTP status code, or `0` for purely-local failures.

Existing JS SDK note: `@syrotp/sdk` ships a single `SyrotpError` with a
`code` discriminator. v0.4 will introduce the granular subclasses
above as a backward-compatible refinement (`SyrotpAuthError extends
SyrotpError`, etc.) so existing `catch (SyrotpError)` keeps working.

## 6. Naming conventions

Wire format uses `snake_case` (matches the OpenAPI schema). SDK
surfaces use the host language's idiom:

| Language | Methods    | Field names |
| ---      | ---        | --- |
| JS / TS  | `camelCase` | `camelCase` (input), `snake_case` preserved on output for parity with raw API |
| Python   | `snake_case` | `snake_case` |
| Kotlin   | `camelCase` | `camelCase` |
| Swift    | `camelCase` | `camelCase` |
| PHP      | `camelCase` | `camelCase` (with `snake_case` accessors when convenient) |

The mapping MUST be deterministic so a generated client and the
hand-rolled wrapper agree. SDKs MUST NOT invent field names that
don't appear in the OpenAPI spec.

## 7. Cancellation and abort

Every SDK MUST expose its language's idiomatic cancellation primitive
on every operation:

| Language | Mechanism |
| ---      | --- |
| JS / TS  | `AbortSignal` parameter on every method, propagated to `fetch`. |
| Python   | `asyncio.CancelledError` for async client; `Timeout` exception + `cancel_token` for sync. |
| Kotlin   | `CoroutineScope` cancellation; `CancellationException` propagates. |
| Swift    | `Task` cancellation; `CancellationError` propagates. |
| PHP      | Per-request `timeout` only (PHP has no idiomatic in-flight cancel). |

When a cancel is observed:

1. The in-flight HTTP request MUST be aborted (where the language
   allows), not silently let to finish.
2. The SDK MUST raise the language-idiomatic cancellation type, NOT
   `SyrotpTimeoutError`. They are distinct: cancellation came from the
   caller, timeout from the deadline.
3. `waitForVerification` MUST check for cancel before AND between
   polls. It MUST NOT swallow the cancel into a returned
   `Verification`.

## 8. Conformance checklist

A new SDK is "SYROTP-compliant" when it can answer **yes** to all of
the following. Keep this list in the SDK's README under a
`Conformance` heading.

- [ ] Constructor accepts `baseUrl`, `apiKey`, `timeoutMs`, `retries`,
      `userAgent`, and the language's cancel primitive.
- [ ] Constructor rejects bad inputs with `SyrotpConfigError`.
- [ ] `startVerification`, `getVerification`, `cancelVerification` are
      implemented and return the `Verification` shape.
- [ ] `waitForVerification` is implemented (or explicitly opted out
      with a doc note).
- [ ] All seven error classes exist and are raised in the right
      categories.
- [ ] Default `timeoutMs` is finite (recommended: `15000`).
- [ ] Default `retries >= 1` and the [retry policy](sdk-generation.md#retry-policy)
      is followed.
- [ ] Retries respect `Retry-After` on `429` responses.
- [ ] No retry happens on `4xx` other than `429`.
- [ ] Cancellation aborts in-flight HTTP requests.
- [ ] `User-Agent` includes `syrotp-sdk-<lang>/<version>`.
- [ ] No SDK code logs the API key, the request body, or any
      gateway signing key.
- [ ] An end-to-end example runs against the SYROTP smoke server in
      CI (see [`sdk-generation.md`](sdk-generation.md#per-sdk-ci)).
