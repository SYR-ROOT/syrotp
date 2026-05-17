# SYROTP SDK Generation Policy

**Status:** Normative. Applies to every official SYROTP SDK and is the
expected baseline for third-party SDKs.

This document spells out **how** SDKs are produced and reviewed —
codegen sources, what's allowed in hand-written code, security rules
that every SDK ships with, and the CI gate each SDK must pass before
release.

For the cross-language API surface itself, see
[`sdk-contract.md`](sdk-contract.md). For SemVer rules, see
[`sdk-versioning.md`](sdk-versioning.md).

## Table of contents

1. [Single source of truth](#1-single-source-of-truth)
2. [Layered SDK architecture](#2-layered-sdk-architecture)
3. [What MUST NOT be hand-edited](#3-what-must-not-be-hand-edited)
4. [What MUST be hand-written](#4-what-must-be-hand-written)
5. [Mandatory security rules](#5-mandatory-security-rules)
6. [Default timeouts](#6-default-timeouts)
7. [Retry policy](#7-retry-policy)
8. [Per-SDK CI](#8-per-sdk-ci)
9. [Examples MUST be runnable](#9-examples-must-be-runnable)

---

## 1. Single source of truth

[`openapi.yaml`](../openapi.yaml) at the repository root is the
**only** authoritative description of SYROTP's wire format. Every SDK
derives its on-the-wire shapes (request/response models, status codes,
header names, query/path params) from this file via a code generator
or a small custom transformer.

Concretely:

- A change to the wire format MUST be made first in `openapi.yaml`,
  reviewed, and then propagated into every SDK.
- A change to an SDK's wire-level shape that is NOT preceded by a
  change to `openapi.yaml` is a bug, even if the SDK passes its own
  tests. CI MUST reject it.
- The OpenAPI spec is checked into git. Commits that change it MUST
  cite the rationale and the corresponding server-side code change.

`info.version` in `openapi.yaml` tracks the **protocol version**
(currently `0.1.0`), not the project release version. The protocol is
stable across v0.1, v0.2, and v0.3 because no wire-level changes were
made — only new ancillary endpoints (`/metrics`, `/admin/*`, none of
which are part of the developer SDK contract).

## 2. Layered SDK architecture

Every SYROTP SDK is built in two layers:

```
┌─────────────────────────────────────────────────────┐
│  Hand-written wrapper (the user-facing SDK)         │
│    - implements sdk-contract.md surface             │
│    - error taxonomy, retries, cancellation, UA      │
│    - idiomatic naming for the host language         │
└─────────────────────────────────────────────────────┘
                      ↓ uses
┌─────────────────────────────────────────────────────┐
│  Generated client (or a small hand-rolled equivalent)│
│    - request/response data classes                   │
│    - URL paths + HTTP methods                        │
│    - JSON (de)serialization                          │
└─────────────────────────────────────────────────────┘
                      ↓ derived from
                openapi.yaml (the spec)
```

The wrapper is what application developers import. The generated
client is an implementation detail — its names, package paths, and
signatures may differ between languages and are NOT part of the
public API.

### Generator choice per language

| SDK     | Generator |
| ---     | --- |
| JS / TS | hand-rolled (the surface is small enough that codegen adds noise) |
| Python  | OpenAPI-driven; preferred: `openapi-python-client` or hand-rolled if simpler |
| Kotlin  | OpenAPI-driven via `openapi-generator` (`kotlin` template); ktor-based runtime |
| Swift   | OpenAPI-driven via `apple/swift-openapi-generator` |
| PHP     | OpenAPI-driven; preferred: `jane-php/open-api` or hand-rolled |

Each SDK README MUST state which generator (or "hand-rolled") it
uses, the exact version, and the command that regenerates the client.

## 3. What MUST NOT be hand-edited

The generated client folder is build-output. Hand-editing it is
forbidden because the next regeneration will silently revert the
change, and that change will not be reflected in any other SDK.

Concretely:

- **No** local edits to files inside the generator's output directory
  (typically `generated/`, `gen/`, or similar).
- **No** patches via `sed` / `awk` in the build script. If the
  generator's output is wrong, the fix is upstream (the generator's
  template or `openapi.yaml`), not downstream.
- **No** hand-rewriting model field names, endpoint paths, or HTTP
  methods inside the SDK to "match the language better." That's the
  wrapper's job.

If a generator produces code that's actively wrong (e.g. swallows an
error response), wrap it in the hand-written layer rather than
patching the generated file.

## 4. What MUST be hand-written

Everything users see is hand-written, from the language-idiomatic
wrapper down to the documentation:

- The `SyrotpClient` class / module (constructor, options validation,
  the three core methods, and any opt-in helpers).
- The seven error classes from
  [`sdk-contract.md#5-standard-error-taxonomy`](sdk-contract.md#5-standard-error-taxonomy).
- HTTP transport setup: User-Agent, retry loop, timeout, cancel hooks.
  The generated client's HTTP plumbing is replaced or wrapped.
- Tests against a real SYROTP server (see [Per-SDK CI](#8-per-sdk-ci)).
- README with an `## Installation`, `## Quickstart`, and
  `## Conformance` section (the latter mirrors the checklist in
  `sdk-contract.md`).

## 5. Mandatory security rules

Every SDK MUST follow these rules. They are non-negotiable; CI for
each SDK MUST contain at least one assertion per rule.

| Rule | Enforcement |
| --- | --- |
| **Never log the API key.** Not in error messages, not in HTTP debug logs, not in stack traces, not in any built-in tracing/telemetry hook the SDK exposes. | A grep-style test that runs the SDK with `apiKey="canary-pk_live_TESTSENTINEL"` and asserts the captured log/error stream does not contain `TESTSENTINEL`. |
| **Never log request bodies.** Inputs to `startVerification` include user phone numbers; SDKs MUST NOT spill them into observability. | Same canary approach: pass `phone="+99999999999999"` (impossible value), assert it doesn't appear in any log line. |
| **Never log response bodies that contain `message` or `send_to`.** They include the verification code. If the SDK exposes a debug-log hook, document this rule and redact by default. | Code-review item; SDK README must call this out. |
| **Never store the API key on disk.** Not in temp files, not in cache files, not in tracing exports. | Code-review item. |
| **Never embed credentials in error stringification.** `str(error)` / `error.toString()` MUST NOT contain the API key. | Unit test per error class. |
| **Default timeout is finite.** Infinite timeouts let one stuck request leak a goroutine/task/connection forever. | See [§6](#6-default-timeouts). |
| **HTTPS in production.** SDKs MUST accept `http://` only when `baseUrl` is `localhost`, `127.0.0.1`, or an RFC 1918 / link-local address; **and** the SDK MUST log a warning when used over plain HTTP. Strict-HTTPS mode is opt-in via a constructor option (`requireHttps: true` / equivalent). Production defaults to warn-on-cleartext, not refuse, so dev / on-prem deployments still work. | Per-SDK unit test. |

The SDK MAY surface an opt-in debug log hook, but that hook MUST have
a redaction list in its default configuration covering at minimum:
`Authorization`, `apiKey`, `phone`, `message`, `send_to`, `body`,
`X-SYROTP-Signature`.

## 6. Default timeouts

| Operation | Default | Maximum recommended |
| --- | --- | --- |
| Per-request (HTTP socket + read) | `15000ms`  | `60000ms` |
| `waitForVerification` total deadline | `5 * 60000ms` (5 min) | `15 * 60000ms` |
| `waitForVerification` poll interval  | `2500ms`   | — (server enforces a min) |

The SDK MUST NOT default to "no timeout" / "infinite" / `None` /
`-1` / `0` for the per-request value. If the user wants to opt out
they pass an explicit very-large value; the SDK MAY then log a
warning.

## 7. Retry policy

The SDK retries automatically only on **transient** failures. The
retry budget is `retries` from the constructor (default `2`).

**Retry on:**

- `SyrotpNetworkError` (DNS, connection refused, reset, TLS handshake
  failure, abrupt close).
- `SyrotpServerError` (HTTP `5xx`).
- `SyrotpRateLimitError` (HTTP `429`), respecting `Retry-After` from
  the response header.

**Never retry on:**

- `SyrotpAuthError` (`401` / `403`) — keys don't fix themselves.
- `SyrotpValidationError` (`400` and local validation) — the input
  is wrong, retrying changes nothing.
- `SyrotpConfigError` — same.
- `SyrotpTimeoutError` — the **caller's** deadline already expired.

**Backoff schedule** (per retry, regardless of which retriable error):

```
attempt 0 → no wait
attempt 1 → 250ms ± 100ms jitter
attempt 2 → 500ms ± 200ms jitter
attempt 3 → 1000ms ± 400ms jitter
…
```

Capped at `4000ms` per attempt. If `Retry-After` is set on a `429`,
the SDK MUST sleep at least that long (and MAY sleep longer for
jitter), then count it as one retry from the budget.

The SDK MUST NOT retry `POST /v1/verifications/{id}/cancel` more
than once on a transient failure — cancellation is naturally
idempotent at the server, but a runaway retry loop is observable in
audit logs and confuses operators.

## 8. Per-SDK CI

Every official SYROTP SDK MUST run, as part of every PR:

1. **Unit tests** — at minimum, one assertion per security rule
   ([§5](#5-mandatory-security-rules)) plus the conformance checklist
   from `sdk-contract.md`.
2. **Live cross-stack test** — boots the SYROTP server (via the same
   path as the existing `smoke` job in `.github/workflows/ci.yml`),
   bootstraps a receiver, then drives `startVerification` →
   `cancelVerification` from the SDK against the live server. This
   proves the SDK and the server agree on the wire format.

The Python GSM gateway in `apps/gsm-gateway/` is the reference for
how this looks (its `tests/test_crypto.py` and the cross-stack step
in the smoke job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)).
A new SDK CI job follows the same pattern.

CI failure modes that MUST be wired:

- Spec drift: an SDK whose generated client is from an older
  `openapi.yaml` than `main` fails CI.
- Security rule violation: any of the canary tests in §5 fails CI.
- Conformance gap: any unchecked checkbox in `sdk-contract.md#8`
  fails CI.

## 9. Examples MUST be runnable

Every SDK ships at least one runnable example:

- `examples/quickstart.{py,kt,swift,php,…}` — performs
  `startVerification` against a local SYROTP server, prints the
  receiver number + message, and exits.
- The example MUST read `SYROTP_BASE_URL` and `SYROTP_PUBLIC_KEY` /
  `SYROTP_SECRET_KEY` from env (matching `scripts/smoke.mjs` and the
  `syrotp` CLI conventions).
- The example MUST NOT hardcode any key or phone number — that's a
  security smell when copy-pasted.

The example's output is checked in as a `README.md` fenced code block
so a developer can compare what they see locally to what the docs
promise.

---

## Summary of binding rules

If you skim only one section, this is the one:

1. `openapi.yaml` is the only source of truth for the wire format.
2. Generated code is build-output; never hand-edited.
3. Every SDK has a hand-written wrapper that implements the
   [`sdk-contract.md`](sdk-contract.md) surface — and only that.
4. The SDK never logs `apiKey`, `phone`, `message`, `send_to`, or
   gateway signing keys.
5. `timeoutMs` defaults to `15000`. Never infinite.
6. Retries on network / `5xx` / `429` only. Never on `4xx` other than
   `429`. Never on validation / auth / timeout.
7. Every SDK has a live cross-stack test in CI proving its wire
   format matches the server's.
