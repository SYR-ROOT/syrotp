# SYROTP Protocol Reference

This is the human-readable companion to [`openapi.yaml`](../openapi.yaml). When the two disagree, **the OpenAPI spec wins** — it's the source of truth and what generated SDKs are built from.

## Glossary

| Term | Meaning |
|---|---|
| **App** | A developer integration; owns API keys and receivers. |
| **Public key** (`pk_live_*`) | Restricted key safe to embed in browsers / mobile apps. |
| **Secret key** (`sk_live_*`) | Backend-only key with full access. |
| **Gateway signing key** | HMAC key issued to a receiver gateway (one per receiver). |
| **Receiver** | A phone number controlled by a gateway that accepts inbound SMS for verification. |
| **Verification** | A single attempt to prove ownership of a phone number. Has a unique code, message body, and TTL. |

## Lifecycle

```
created (pending) ──► verified
                 ├──► expired      (TTL elapsed before SMS matched)
                 ├──► cancelled    (developer called /cancel)
                 └──► failed       (reserved; not used in v0.1)
```

## 1. Start a verification

```http
POST /v1/verifications
Authorization: Bearer pk_live_xxx
Content-Type: application/json

{
  "phone": "0991234567",
  "purpose": "login",
  "client_ref": "user_123"
}
```

Returns `201` with the verification, including:

- `id` — `vrf_<ulid>`
- `send_to` — receiver MSISDN, e.g. `+963998887777`
- `message` — exact body to send, e.g. `VERIFY A7K9P2`
- `expires_at` — RFC 3339 UTC

## 2. User sends SMS

The user must send the **exact message body** to the **exact receiver number**. Matching rules:

- Whitespace is collapsed.
- Comparison is case-insensitive.
- The prefix `VERIFY` must appear at the start (a single space between prefix and code is recommended but not required).

## 3. Gateway forwards inbound SMS (signed)

```http
POST /v1/inbound/sms
X-SYROTP-Receiver: rcv_xxx
X-SYROTP-Timestamp: 1714509600
X-SYROTP-Nonce: 9d1e3c4f...
X-SYROTP-Signature: <hex hmac-sha256>
Content-Type: application/json

{
  "from": "+963991234567",
  "to": "+963998887777",
  "body": "VERIFY A7K9P2",
  "received_at": "2026-04-30T20:10:00.000Z",
  "idempotency_key": "msg_a8b3c1..."
}
```

Signature input:

```
<X-SYROTP-Timestamp>.<X-SYROTP-Nonce>.<sha256(raw_body_bytes)>
```

## 4. Poll status

```http
GET /v1/verifications/vrf_xxx
Authorization: Bearer pk_live_xxx
```

Polling cadence: **at least 2 seconds between calls**. Servers MAY rate-limit aggressively.

## 5. Cancel

```http
POST /v1/verifications/vrf_xxx/cancel
Authorization: Bearer sk_live_xxx
```

Only `pending` verifications can be cancelled; everything else returns `409`.

## Error envelope

```json
{
  "error": {
    "code": "rate_limited",
    "message": "too many requests",
    "request_id": "01H..."
  }
}
```

Stable error codes:

| Code | When |
|---|---|
| `validation_error` | Input failed schema validation. |
| `invalid_phone` | Phone could not be normalized to a valid E.164. |
| `phone_type_not_allowed` | Premium / shared-cost / non-mobile rejected. |
| `invalid_purpose` | Purpose contains disallowed characters. |
| `unauthorized` | Missing/invalid/revoked credentials. |
| `forbidden` | Key kind not permitted for this endpoint. |
| `not_found` | Resource doesn't exist for this app. |
| `not_pending` | Verification is in a terminal state. |
| `too_many_pending` | Phone already has the configured cap of pending verifications. |
| `rate_limited` | Per-IP / per-receiver rate limit exceeded. |
| `no_receiver` | No healthy receiver available to route this verification. |
| `internal_error` | Generic 500. Always logged server-side. |
