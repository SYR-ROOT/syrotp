# Phone-binding ceremony

> v0.8 PR #36 introduced the ceremony.
> **v0.8 PR #37 makes verified phone binding mandatory** for verification creation — `startVerification` returns `403 phone_not_bound` whenever no `verified` row exists for `(app_id, phone_e164)`. No bypass, no feature flag, no soft warning.

## Why

SYROTP's `startVerification` accepts an arbitrary phone number. The
HMAC on inbound SMS proves the gateway is authentic, but it does
**not** prove the inbound's `from_e164` is honest. In a Bring-Your-
Own-Gateway deployment, a dishonest gateway operator could:

1. Call `startVerification("+963 any number")` with their `sk_live`.
2. Have their gateway forward a fake inbound `"VERIFY <code>"` claiming `from_e164 = "+963 any number"`.
3. Server matches; `verified` reported.

The HMAC says "this gateway is real." It does **not** say "this
phone is bound to this gateway." The phone-binding ceremony fixes
that gap by forcing the developer to prove control of every phone
they want verifications for, **before** they can start
verifications against it.

## Status

- ✅ v0.8 PR #36: the ceremony machinery — endpoints, storage,
  inbound matcher branch.
- ✅ v0.8 PR #37: **hard invariant active**. `startVerification`
  returns `403 phone_not_bound` when no `verified` binding exists
  for `(app_id, phone_e164)`. Enforcement is at the
  `(app_id, phone_e164)` granularity — receiver_id on the binding
  doesn't have to match the receiver the router eventually picks
  for that verification, by design.

## Enforcement (v0.8 PR #37)

```
POST /v1/verifications

if not exists (
  SELECT 1 FROM phone_bindings
   WHERE app_id     = $auth.app_id
     AND phone_e164 = normalize($body.phone)
     AND status     = 'verified'
):
  return 403 { "error": { "code": "phone_not_bound", ... } }
```

The check runs in `services/verifications.ts::startVerification`
BEFORE the receiver is picked. Phones go through
`normalizePhone(...)` first so a developer passing `"0991234567"`
matches a binding seeded for `"+963991234567"`.

**No bypass exists.** There is no environment flag, no
metrics-only mode, no soft warning. A revoked binding rejects.
A pending binding rejects. Only `status = 'verified'` rows count.

## Lifecycle

```
   startBinding()                 BIND <nonce> inbound
   ─────────────▶  pending  ──────────────────────────▶  verified
                     │                                      │
                     │  revokeBinding()        revokeBinding()
                     ▼                                      ▼
                   revoked                              revoked
```

- **`pending`** — created by `POST /v1/phone-bindings/start`.
  Carries a single-use, TTL'd nonce. Multiple `pending` rows for
  the same `(app, phone)` are allowed (developer retries).
- **`verified`** — flipped when the gateway forwards an inbound SMS
  carrying `BIND <nonce>` from the claimed phone, on the same
  receiver, within the TTL. **Only ONE `verified` row per
  `(app_id, phone_e164)` at a time** (partial unique index).
- **`revoked`** — soft delete. Row stays for history. PR #37 will
  treat `revoked` the same as no row.

## Endpoints

All gated by `sk_live_*`. A leaked `pk_live_*` MUST NOT be able to
create or revoke bindings.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/phone-bindings/start`         | start the ceremony — returns `nonce`, `expires_at`, `send_to`, `bind_message` |
| `GET`  | `/v1/phone-bindings/:id`           | read current state (status / bound_at / revoked_at) |
| `POST` | `/v1/phone-bindings/:id/revoke`    | soft-revoke a row (works on pending and verified) |

### `POST /v1/phone-bindings/start`

```json
// request
{ "phone": "+963991234567", "receiver_id": "rcv_..." }

// response 201
{
  "binding_id": "pbn_01...",
  "phone_e164": "+963991234567",
  "receiver_id": "rcv_...",
  "status": "pending",
  "expires_at": "...",
  "send_to": "+963998887777",
  "bind_message": "BIND ABC23DEF45GHK67MN89PQR3"
}
```

The developer's gateway operator sends `bind_message` from the
claimed phone (`phone_e164`) to `send_to` within the TTL. The
inbound matcher promotes the row to `verified` automatically.

`409 already_bound` is returned if a `verified` binding already
exists for the same `(app_id, phone_e164)`. Revoke the existing
row first.

### `GET /v1/phone-bindings/:id`

```json
{
  "id": "pbn_...",
  "app_id": "app_...",
  "receiver_id": "rcv_...",
  "phone_e164": "+963991234567",
  "status": "verified",
  "expires_at": "...",
  "bound_at": "...",
  "revoked_at": null,
  "created_at": "..."
}
```

### `POST /v1/phone-bindings/:id/revoke`

Sets `status = revoked`, `revoked_at = now()`. Idempotent
(re-revoke is a no-op). Soft delete: the row stays for audit.

## Storage

```
phone_bindings
  id            text        PK   pbn_<ulid>
  app_id        text        FK   apps(id) cascade
  receiver_id   text        FK   receivers(id) cascade
  phone_e164    text        normalized E.164
  status        text        pending | verified | revoked
  nonce         text        single-use, TTL'd, plain
  expires_at    timestamptz
  bound_at      timestamptz nullable — set on verified
  revoked_at    timestamptz nullable — set on revoked
  created_at    timestamptz

  partial unique idx (app_id, phone_e164) WHERE status = 'verified'
  idx (nonce, status)             — inbound matcher path
  idx (app_id, phone_e164, status) — PR #37 enforcement path
```

The nonce is stored in plain text because the inbound match
compares it byte-for-byte against the SMS body — the same
trade-off WebAuthn challenges make in v0.5 PR #4. Single-use plus
TTL keep the window small. **Logs MUST NOT print the nonce or the
`bind_message` field.**

## Inbound matcher

`POST /v1/inbound/sms` (gateway-signed) tries `BIND` first, then
`VERIFY`:

```
parse(body):
  if body matches "BIND <nonce>":
    try consumeBindNonce(receiver, from_e164, nonce)
      → match: row → verified, return matched=true
      → no_match: return matched=false (BIND-shape, do NOT
        reinterpret as VERIFY)
  else if body matches "VERIFY <code>":
    existing verification path (unchanged)
```

A BIND-shaped body that fails to parse a valid nonce **does not**
fall through to the VERIFY path. Otherwise an attacker could blur
the security model by crafting messages that look like one thing
and get matched as another.

## Security guarantees pinned by tests

| Test | Property |
| --- | --- |
| PB1  | `pk_live_*` rejected on every ceremony endpoint |
| PB2  | `start` ⇒ pending row, single-use nonce, TTL'd; response includes `send_to` + `bind_message` |
| PB3  | Valid `BIND` inbound flips the row to `verified` + `bound_at` |
| PB4  | Wrong nonce ⇒ no match; row stays `pending` |
| PB5  | `from_e164` ≠ binding's claimed phone ⇒ no match |
| PB6  | Expired pending nonce ⇒ no match |
| PB7  | Replay (same nonce twice) ⇒ second attempt is a no-op |
| PB8  | `revoke` flips status + `revoked_at` for both `pending` and `verified` rows |
| PB9  | Multiple `pending` rows for the same `(app, phone)` are allowed |
| PB10 | Only ONE `verified` row per `(app, phone)` at a time — second `start` returns 409 `already_bound` |
| PB11 | BIND-shaped body with a malformed nonce does NOT fall through to VERIFY-parsing |
| PE1  | `startVerification` rejects an unbound phone with `403 phone_not_bound` |
| PE2  | `startVerification` accepts a verified-bound phone (existing happy path) |
| PE3  | A revoked binding rejects with `403` |
| PE4  | A pending binding rejects with `403` (only `verified` counts) |
| PE5  | A verified binding for app A does NOT satisfy a `startVerification` for app B |
| PE6  | Enforcement is `(app_id, phone)`-scoped — `receiver_id` doesn't have to match the receiver the router picks |
| PE7  | Phone normalization runs BEFORE the lookup — local format `"0991234567"` matches an E.164 binding `"+963991234567"` |

## Threat model boundaries (still open)

- **Gateway compromise**: a stolen `signingKey` + receiver_id pair
  lets an attacker impersonate the gateway. Mitigation in v0.8 PR
  4 (Android Keystore-backed gateway secret).
- **SIM swap**: if the SIM is transferred to a new device after
  binding, the binding still treats the new SIM operator as the
  bound entity. Out of scope here — that's a carrier-level
  problem.
- **Soft-revoke race**: between revoke and a verification creation
  arriving milliseconds apart. PR #37's enforcement check is a
  point-in-time SELECT; the small window is acceptable for the
  threat model.

## Operating

There's no background worker. Pending rows expire passively;
operationally, you can clean up old rows via:

```sql
DELETE FROM phone_bindings
 WHERE status = 'pending'
   AND expires_at < now() - interval '7 days';
```

The active-binding partial unique index keeps scans cheap
regardless of how many `pending` / `revoked` rows accumulate.
