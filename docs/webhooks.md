# Webhooks

Outbound, signed, server-to-server events for verification lifecycle
changes. Apps register an endpoint, SYROTP fires HTTP POSTs whenever
a verification is verified / expired / cancelled, and the receiver
verifies the signature before acting on the body.

This document is the contract — receivers MUST follow it
byte-for-byte, especially the signature scheme.

## Event types

The closed set of v0.5 event types:

| `type` | Fires when |
| --- | --- |
| `verification.verified` | An inbound SMS matched a pending verification. |
| `verification.expired`  | A verification past its TTL was lazy-expired (on first read after expiry). |
| `verification.cancelled` | The app called `cancelVerification` on a pending verification. |

Unknown types are rejected at registration time with `400 validation_error`.

## Registering an endpoint

Backend-only — requires an `sk_live_*` key. A leaked `pk_live_*` in
a browser MUST NOT be able to point a webhook at a third party.

```bash
curl -X POST https://otp.example.com/v1/webhooks \
  -H 'Authorization: Bearer sk_live_…' \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://app.example.com/syrotp/webhook",
    "event_types": ["verification.verified"]
  }'
```

Response (`201`):

```json
{
  "id": "whk_…",
  "app_id": "app_…",
  "url": "https://app.example.com/syrotp/webhook",
  "enabled": true,
  "event_types": ["verification.verified"],
  "created_at": "2026-…",
  "updated_at": "2026-…",
  "secret": "whsec_…"
}
```

**The `secret` is shown ONCE.** It's the only place the raw value
ever leaves the server — list / read endpoints never echo it back.
Store it in your secrets manager before responding.

Other endpoints:

| Method | Path | Notes |
| --- | --- | --- |
| `GET`    | `/v1/webhooks`     | List endpoints (no secrets). |
| `GET`    | `/v1/webhooks/:id` | Read one (no secret). |
| `DELETE` | `/v1/webhooks/:id` | Cascades pending deliveries. |

PATCH and a `:id/test` "send a ping" endpoint are deliberately out
of scope for v0.5; if you need either, open an issue.

## Delivery payload

```json
{
  "id": "evt_…",
  "type": "verification.verified",
  "created_at": "2026-…",
  "data": {
    "verification_id": "vrf_…",
    "status": "verified",
    "phone_masked": "+96399****567",
    "purpose": "login",
    "client_ref": "user_123",
    "verified_at": "2026-…"
  }
}
```

The `data` block is a strict whitelist:

- `verification_id`, `status`, `phone_masked`, `purpose`, `client_ref`
- one of `verified_at` / `expired_at` / `cancelled_at`, depending on `type`

NOT included (deliberately):
- the user's full E.164 phone
- the `VERIFY <code>` SMS body or the OTP code itself
- the API key or the gateway signing key
- the receiver's id

If a payload from your endpoint ever shows one of those, file a
security issue immediately — that's a contract violation we want to
fix without delay.

## Signature

Receivers MUST verify the signature before reading the body.

```
signed_payload = "<X-SYROTP-Webhook-Timestamp>.<raw-body-bytes>"
signature      = HMAC-SHA256(your_secret, signed_payload).hex()
```

Compare lowercase hex with constant-time equality
(e.g. `crypto.timingSafeEqual` in Node, `hmac.compare_digest` in
Python).

Hash the **raw body bytes**, NOT a re-serialized JSON. A single byte
flip on the wire MUST invalidate the signature; if your framework
re-formats JSON before exposing it (some web stacks do), reach for
the raw stream.

Reject requests where:
- the signature does not verify
- `X-SYROTP-Webhook-Timestamp` is more than ~5 minutes from your wall
  clock (mitigates replay)

### Headers on every delivery

| Header | Value |
| --- | --- |
| `X-SYROTP-Webhook-Id`         | `wd_<ulid>` — the delivery row's id, useful for receiver-side dedup. |
| `X-SYROTP-Webhook-Timestamp`  | Unix epoch seconds (10 digits today). |
| `X-SYROTP-Webhook-Signature`  | Lowercase hex, 64 chars. |
| `X-SYROTP-Webhook-Event`      | `verification.verified` / `.expired` / `.cancelled`. |
| `X-SYROTP-Webhook-Attempt`    | 1-indexed; increments on each retry. |
| `Content-Type`               | `application/json; charset=utf-8`. |

Example Node verifier (use as a starting point, not as-is):

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySyrotpWebhook(rawBody, headers, secret) {
  const ts = String(headers["x-syrotp-webhook-timestamp"] ?? "");
  const sig = String(headers["x-syrotp-webhook-signature"] ?? "");
  if (!ts || !sig) return false;

  // 5-minute skew window
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(ts, 10)) > 300) return false;

  const expected = createHmac("sha256", secret)
    .update(`${ts}.${rawBody}`)
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

## Retry policy

| Attempt # | Fires at | Notes |
| --- | --- | --- |
| 1 | event creation | t=0 |
| 2 | t + 30s | after 1st failure |
| 3 | t + 2m  | after 2nd failure |
| 4 | t + 10m | after 3rd failure |
| 5 | t + 30m | after 4th failure |
| 6 | t + 2h  | after 5th failure; **last attempt** |

Per attempt:
- 5-second outbound timeout.
- `2xx` → `delivered`. We stop.
- `429`, `5xx`, network error, timeout → retry until budget exhausted, then `abandoned`.
- `4xx` other than `429` → `failed`. We don't retry; receiver clearly rejected the payload shape.
- 3xx redirects are NOT followed — a misconfigured endpoint pointing
  at a 30x to a third party MUST NOT silently leak the signed body.

Idempotency: receivers MUST tolerate duplicates. The combination of
`X-SYROTP-Webhook-Id` + `id` (envelope) is stable per logical event;
deduplicate on either if you process side-effects.

## Operating the worker

The delivery worker runs in the same Node process behind a periodic
timer.

```
WEBHOOK_WORKER_ENABLED=true       # default; set "false" to turn off
WEBHOOK_WORKER_INTERVAL_MS=5000   # 5s default — lower = lower latency, higher = less DB pressure
```

The worker uses `FOR UPDATE SKIP LOCKED` on `webhook_deliveries`, so
running multiple worker processes against the same Postgres is safe
(no double-delivery beyond the at-least-once semantics already in
play).

Metrics:

| Metric | Type | Labels |
| --- | --- | --- |
| `syrotp_webhook_events_total`            | counter   | `event_type` |
| `syrotp_webhook_deliveries_total`        | counter   | `status` (`delivered`/`failed`/`abandoned`/`retried`) |
| `syrotp_webhook_delivery_failures_total` | counter   | `reason` (`network_error`/`timeout`/`client_4xx`/`server_5xx`/`rate_limited`/`endpoint_disabled`/`bad_response`) |
| `syrotp_webhook_delivery_duration_seconds` | histogram | `status` (`2xx`/`4xx`/`5xx`/`network`/`timeout`) |

No high-cardinality labels — never `endpoint_id`, `app_id`, raw URL,
phone, or verification id.

## Limits

- One outbound `POST` per delivery row, per attempt.
- Max 6 attempts; after that, status moves to `abandoned`.
- Per-attempt timeout: 5 seconds.
- Endpoint URL: max 2048 chars; `http://` or `https://` only;
  no userinfo (`user:pass@`).
- Subscribed event types: must be a non-empty subset of the closed
  set above.

## What's not in v0.5

- PATCH endpoint (re-create + delete instead).
- `:id/test` "send a ping" endpoint.
- An admin UI for browsing past events / deliveries.
- Webhook secret rotation (delete + re-create, copy the new secret).
- Per-endpoint custom retry policies.

If any of these block your integration, open an issue — the v0.5
scope was deliberately tight.
