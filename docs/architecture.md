# Architecture

A bird's-eye view of how the pieces fit together. For the wire format,
see [`openapi.yaml`](../openapi.yaml). For the threat model, see
[`SECURITY.md`](../SECURITY.md).

## High-level diagram

```
                  ┌────────────────────────────────────────────────┐
                  │              Developer's product               │
                  │   (web app, mobile app, server, etc.)          │
                  └─────────┬──────────────────────────┬───────────┘
                            │ pk_live_*  (browser)     │ sk_live_*  (backend)
                            │                          │
                            ▼                          ▼
                  ┌──────────────────────────────────────────────┐
                  │              SYROTP API server                │
                  │   POST /v1/verifications                     │
                  │   GET  /v1/verifications/{id}                │
                  │   POST /v1/verifications/{id}/cancel         │
                  │   POST /v1/inbound/sms          (HMAC-signed)│
                  │   POST /v1/receivers/{id}/heartbeat          │
                  └─────────┬─────────────────────┬──────────────┘
                            │                     │
                ┌───────────▼──────┐    ┌─────────▼─────────────┐
                │   PostgreSQL     │    │       Redis           │
                │   apps           │    │   nonce replay set    │
                │   api_keys       │    │   rate-limit buckets  │
                │   receivers      │    └───────────────────────┘
                │   verifications  │
                │   inbound_sms    │
                │   audit_log      │
                └──────────────────┘

                            ▲ HMAC-signed
                            │ X-SYROTP-Signature
                  ┌─────────┴────────────────────────────┐
                  │       SMS receiver gateway           │
                  │   (Android app  /  GSM USB modem)    │
                  └─────────────────┬────────────────────┘
                                    │ SIM-level SMS
                                    ▼
                              ╔═══════════╗
                              ║  User's   ║
                              ║   phone   ║   sends "VERIFY A7K9P2"
                              ╚═══════════╝
```

## Request flows

### Flow 1: starting a verification

```
Developer ──POST /v1/verifications──► Server
                                      ├─ rate-check IP bucket          (Redis)
                                      ├─ resolve API key               (Postgres)
                                      ├─ normalize phone to E.164      (libphonenumber-js)
                                      ├─ check pending cap per phone   (Postgres)
                                      ├─ pick healthy receiver         (Postgres + heartbeat window)
                                      ├─ generate code (crypto.randomInt over 31-char alphabet)
                                      └─ INSERT verifications row       (Postgres)
Server ──201 { id, send_to, message, expires_at }──► Developer
Server ──audit verification.start──► audit_log
```

### Flow 2: inbound SMS arrives

```
User's phone ──SMS──► Gateway device ──captures via SmsReceiver──► local queue
Gateway worker ──HTTPS POST /v1/inbound/sms (HMAC-signed)──► Server
                                  ├─ verify HMAC, fail = 401              (timestamp skew, body hash)
                                  ├─ replay-guard nonce in Redis (SET NX)
                                  ├─ rate-check per receiver bucket
                                  ├─ INSERT inbound_sms (idempotent on receiver_id, idempotency_key)
                                  ├─ extract code from body
                                  └─ atomic UPDATE verifications
                                       SET status='verified'
                                       WHERE phone_e164 = sender
                                         AND code = extracted
                                         AND status = 'pending'
                                         AND expires_at > now()
Server ──202 { matched, verification_id }──► Gateway
```

The `UPDATE … WHERE` is the **only** place a `pending` becomes `verified`.
Postgres serializes concurrent updates on the same row, so even five
inbounds racing for the same code result in exactly one winner — see
test T11 in `apps/server/test/suites/concurrency.ts`.

### Flow 3: developer polls status

```
Developer (every ≥ 2s) ──GET /v1/verifications/{id}──► Server
                                                       ├─ rate-check IP
                                                       ├─ SELECT verifications row
                                                       ├─ if pending && past TTL → mark expired (lazy)
                                                       └─ return masked view
Server ──200 { status, verified_at? }──► Developer
```

## Storage layout

```
apps                  one row per developer integration
  └─ api_keys          (1:N)  key_hash = HMAC(MASTER, "api_key:" + raw)
  └─ receivers         (1:N)  secret_hash = AES-GCM(MASTER, signing_key, aad="receiver:<id>")
  └─ verifications     (1:N)  code stored plaintext during TTL (matchable)
  └─ inbound_sms       (1:N)  unique(receiver_id, idempotency_key)
audit_log              append-only, cross-cuts everything
```

## Trust boundaries

| Boundary | What crosses it | What protects it |
|---|---|---|
| Developer ↔ Server | API key (bearer) | TLS + key validation + rate limits |
| Server ↔ Gateway | HMAC-signed JSON | Per-receiver signing key + nonce + body-bound signature |
| Server ↔ Postgres | SQL | Network isolation, role with least privilege, parameterized queries |
| Server ↔ Redis | Commands | Network isolation, separate logical DB |
| Gateway ↔ User's SIM | SMS | Carrier — out of our control |
| MASTER_ENCRYPTION_KEY | Env var | Secret manager (AWS / Vault / sealed secrets); never in DB |

## Process model

In Docker compose:

- `postgres` — single container, persistent volume `pgdata`
- `redis` — single container, no persistence (best-effort cache)
- `server` — Node.js, single process per container; horizontal scale by
  running multiple replicas behind a proxy (no sticky sessions needed)
- `migrate` — one-shot job, runs forward-only `.sql` files

The server is **stateless beyond Redis**. Adding replicas is safe — the
nonce-replay set is shared via Redis, so a captured signature can't be
replayed onto a different replica.
