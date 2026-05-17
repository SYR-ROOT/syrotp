# SYROTP SDK Versioning Policy

**Status:** Normative for every official SYROTP SDK.

This document spells out the versioning rules each SDK follows, what
"compatible" means across the SDK / server boundary, and how
deprecations are introduced and removed.

For the API surface itself, see [`sdk-contract.md`](sdk-contract.md).
For codegen and CI, see [`sdk-generation.md`](sdk-generation.md).

## Table of contents

1. [The three versions](#1-the-three-versions)
2. [SDK SemVer rules](#2-sdk-semver-rules)
3. [Minimum supported server version](#3-minimum-supported-server-version)
4. [Version skew policy](#4-version-skew-policy)
5. [Feature detection](#5-feature-detection)
6. [Deprecation policy](#6-deprecation-policy)
7. [Pre-1.0 caveats](#7-pre-10-caveats)

---

## 1. The three versions

SYROTP has three independent version numbers and conflating them is
the most common source of "why doesn't this work" reports. They are:

| Version | Lives in | Bumps when |
| --- | --- | --- |
| **Protocol version** | `openapi.yaml` `info.version`. | The wire format changes (request/response schema, new endpoint, new required header, retired endpoint). |
| **Server version**   | `apps/server/package.json` and the GitHub release tag. | Any server-side change — even one that's invisible on the wire. |
| **SDK version**      | Each SDK package's manifest (`package.json`, `pyproject.toml`, etc.). | Anything in the SDK changes. |

The protocol version is the **slowest-moving** number. v0.1, v0.2, and
v0.3 of the project all run the same `0.1.0` protocol because no
wire-level change was needed — only ancillary endpoints (`/metrics`,
`/admin/*`) and out-of-band gateways were added.

The SDK version is the **fastest-moving** number — bug fixes and
ergonomics changes happen frequently and don't touch the protocol.

## 2. SDK SemVer rules

Every official SDK is published under SemVer (`MAJOR.MINOR.PATCH`).
The bumps mean exactly:

| Bump  | Allowed changes |
| ---   | --- |
| **PATCH** | Bug fixes only. No public API changes. No new options. No new methods. No retry-policy changes. Same compiled artifact contract. |
| **MINOR** | Backwards-compatible additions. New methods (e.g. a new helper). New optional constructor options with safe defaults. New error subclasses **as long as they extend an existing one**, so existing `catch` clauses still match. New verification statuses MUST be additive (the `unknown` variant from [`sdk-contract.md#4`](sdk-contract.md#4-standard-verification-statuses) catches forward-compat). |
| **MAJOR** | Anything else. Removing an option. Renaming a method. Tightening a default. Changing the error class hierarchy in a non-additive way. Bumping the minimum server version (see below). |

Public API for SemVer purposes is exactly what
[`sdk-contract.md`](sdk-contract.md) describes plus anything the SDK
README documents as user-facing. The generated client folder is **not**
part of the public API; it's a build artifact and may be regenerated
in any release.

### SDK MAJOR tracks Protocol MAJOR

When the protocol bumps to `1.0`, every official SDK bumps to `1.0`
the same week. Mismatched majors are not supported.

Concretely:

| Protocol | Minimum SDK MAJOR | Rationale |
| --- | --- | --- |
| `0.x` | `0.x` | Pre-1.0; SDKs and protocol move together. |
| `1.x` | `1.x` | Frozen wire; SDKs across `1.x` are interoperable as long as MINORs satisfy version skew rules below. |
| `2.x` | `2.x` | Breaking wire change; old SDK MUST NOT silently target it. |

## 3. Minimum supported server version

Every SDK README MUST state, prominently:

> **Minimum SYROTP server version:** `v0.X.Y`

That number bumps in two cases:

1. The SDK starts using a new endpoint or a new field that an older
   server doesn't return.
2. The SDK relies on a server bug fix that an older server lacks.

A bump to the minimum supported server version is a SDK **MAJOR**
release, even if everything else is backwards-compatible. Operators
can't audit every SDK call site, so we make them upgrade the server
deliberately rather than hit cryptic 404 / 400 in production.

If the change is opt-in (a new method that the user has to call), the
README MUST say so under a `Server requirements` heading; older
servers keep working as long as the new method isn't called.

## 4. Version skew policy

Real deployments don't upgrade the server and every SDK on the same
day. The SDK MUST behave reasonably across the realistic skew
combinations:

| Direction | Behavior the SDK MUST guarantee |
| ---       | --- |
| **SDK newer than server** (e.g. SDK uses a field added in `0.2`, server is still on `0.1`) | The SDK MUST detect missing fields gracefully — a missing optional field is `null`/`None`, not an exception. The SDK MUST NOT call a new endpoint without a feature check (see [§5](#5-feature-detection)). If the SDK is deliberately opting out of older servers, it raises `SyrotpConfigError("server_too_old")` at construction time, not on the first request. |
| **SDK older than server** (most common in practice — server upgraded weekly, SDK upgraded quarterly) | MUST keep working as long as the protocol MAJOR matches. New server fields MUST be ignored, not crash. New optional response fields MUST surface through an `extras` map / additional getter so application code can read them without an SDK upgrade. New status enum values MUST surface as `unknown` per [`sdk-contract.md#4`](sdk-contract.md#4-standard-verification-statuses). |
| **Same MINOR, different PATCH** | Always compatible. |
| **Different MAJOR** | Refuse to construct. Fail fast with `SyrotpConfigError`. |

The "ignore unknown fields" rule applies in both directions: the SDK
MUST NOT serialize fields the OpenAPI spec doesn't declare, and MUST
NOT deserialize stricter than the spec.

## 5. Feature detection

Until the server exposes a capability endpoint (planned, not in v0.4
PR 1), SDKs detect features by:

1. The advertised server version from `GET /v1/health` (`Health.version`
   field). The SDK MAY parse this and gate optional code paths on it.
2. Catching `404` / `400` from a probe call and falling back. Used
   sparingly — preferred only where (1) is unavailable.

The SDK MUST NOT page the operator on a feature-not-found:

- Calling a method that needs an endpoint the server doesn't expose
  raises `SyrotpServerError("endpoint_unavailable", httpStatus=404)`,
  same as any other 404 — no stack traces, no panic.
- Optional helpers degrade gracefully: e.g. if `formatInstruction`
  needs a field that's not present, it returns the best string it can
  build from what's available.

A future protocol minor (planned post-1.0) will introduce
`GET /v1/capabilities` as a structured feature flag map. Until then,
SDKs prefer ergonomic graceful degradation over sniffing.

## 6. Deprecation policy

Removing a public API surface is a multi-step process:

| Step | When | What happens |
| --- | --- | --- |
| **Soft-deprecate** | At least one MINOR before removal. | The SDK marks the method/option `@deprecated` (or the language equivalent), with a doc comment pointing at the replacement. Calling it logs a one-time warning per SDK process, prefixed `[syrotp-sdk] DEPRECATED:`. |
| **Sunset announce** | A release before removal. | The CHANGELOG carries a `### Removing in next major` heading with the list and migration guide. |
| **Remove** | At a MAJOR bump. | The deprecated surface is deleted. |

A surface MUST be soft-deprecated for at least one MINOR cycle (e.g.
introduced as deprecated in `0.5.0`, removed in `0.6.0`). Surfaces
introduced and removed in the same MAJOR are not allowed (don't ship
half-baked APIs and then hide behind "we deprecated it").

Server-side endpoint removal follows the same pattern but bumps the
**protocol** version. Currently no protocol-level deprecation has
occurred.

## 7. Pre-1.0 caveats

SYROTP is currently `0.x`. That means:

- **The protocol is not frozen.** A MINOR bump (`0.1` → `0.2`) MAY
  carry a wire-level change, with a documented migration. Frozen wire
  is what `1.0` commits to.
- **SDKs may break compatibility on MINOR bumps**, but the
  [SDK SemVer rules](#2-sdk-semver-rules) above still apply: every
  break is documented in the CHANGELOG, soft-deprecation is
  preferred where possible.
- **No long-term-support branches.** Operators upgrade or stay on
  the version they run.

When the project tags `1.0`, the protocol freezes and SDK MAJORs stop
moving in lockstep with the protocol — a MAJOR SDK bump after `1.0`
indicates a breaking change in the SDK surface itself, not in the
wire.

---

## Summary

- Three versions, slowest-to-fastest: protocol → server → SDK.
- SDK MAJOR follows protocol MAJOR; SDK MINOR can change independently.
- Minimum supported server is a documented contract; bumping it is a
  SDK MAJOR.
- Older SDK + newer server: MUST keep working (ignore unknown fields).
- Newer SDK + older server: feature-detect, fail gracefully.
- Deprecate before remove, at least one MINOR cycle apart.
