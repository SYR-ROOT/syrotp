# Multi-Instance Deployment Guide

This is the canonical deployment doc for SYROTP from **v0.9 onward**.
It's the single doc you read when you're deciding whether to run one
process or many, and what changes when you do. Other docs go deep on
specific subsystems — this one ties them together.

## Three deployment modes

SYROTP supports three shapes. Pick the smallest one that fits your
load; all three use the **same Postgres + same Redis**.

### 1. Single-process (default)

One Node process serves HTTP **and** drains the webhook queue. This
is the v0.8 default and remains the v0.9 default — every existing
deployment runs unchanged.

```bash
pnpm migrate                        # once, before first start
pnpm start                          # one Node process, port 3000
```

`WEBHOOK_WORKER_ENABLED=true` (the default; leave unset).

Use this when:

- You have one SYROTP server in production.
- Your verification volume fits comfortably inside one host's CPU /
  network budget.
- You don't need to scale API and webhook delivery independently.

### 2. Split — API + dedicated worker

API tier handles HTTP traffic only; one (or more) standalone webhook
worker process drains the delivery queue. The API tier sets
`WEBHOOK_WORKER_ENABLED=false` so the in-process timer is a no-op.

```bash
pnpm migrate                                          # once

# API tier (any number of instances behind a load balancer)
WEBHOOK_WORKER_ENABLED=false pnpm start

# Worker tier (1 or more instances)
pnpm start:webhook
```

The worker entrypoint (`apps/server/src/workers/webhook.ts`,
introduced in v0.9 PR #41) is a minimal process: pino logger +
Postgres pool + the existing `WebhookWorker` class + signal
handlers. **No HTTP listener, no `/healthz`, no `/metrics`** on the
worker process today — those land in their own follow-up PR.

Use this when:

- You want to isolate webhook delivery latency from the verification
  hot path.
- You operate behind a load balancer and want N API replicas.
- You expect heavy webhook fan-out (many endpoints per event) and
  want to scale workers independently.

### 3. Multi-API + multi-worker

Same as split, but with **N API instances and M worker instances**.
No coordination service is required — the DB layer carries every
shared invariant. See `docs/multi-instance-safety.md` for the full
audit.

```bash
pnpm migrate                                          # once

# API tier × N
WEBHOOK_WORKER_ENABLED=false pnpm start

# Worker tier × M
pnpm start:webhook
```

Use this when you've outgrown a single API server or single worker
and need horizontal scale. **There is no leader election, no
sharding, no Zookeeper / etcd / Consul required.**

## What guarantees each operation under N processes

This section is the operator-facing summary of the audit in
`docs/multi-instance-safety.md`. The full file:line references and
verdicts live there. Below is just the contract you rely on.

### Verification creation

`POST /v1/verifications` runs inside a Postgres transaction with a
per-`(app_id, phone_e164)` advisory lock
(`pg_advisory_xact_lock(hashtextextended('<app>:<phone>', 0))`).

- Different phones don't contend.
- The same phone serializes — concurrent callers wait their turn,
  the cap holds, callers past the cap get `409 too_many_pending`.
- The lock releases automatically when the transaction commits or
  aborts. There is no possibility of a stuck lock from a crashed
  Node process.

### Webhook delivery leasing

The worker class uses
`SELECT ... FROM webhook_deliveries ... FOR UPDATE SKIP LOCKED` plus
a soft 60-second `next_attempt_at` lease committed before the
outbound HTTP call.

- N concurrent workers race the queue without double-delivering.
- A worker that crashes mid-tick (after the lease but before the
  HTTP completes) leaves the row stuck for at most 60s; the next
  tick on any worker recovers it.
- No leader election. The queue itself is the lock.

### Rate-limit buckets

Per-IP, per-receiver, and per-app rate limits all use a Redis
pipeline of `INCR` (atomic) + `EXPIRE NX` (idempotent window
setup). Counters are **shared across all API instances** because
they live in Redis, not in process memory.

**This means Redis is required, not optional**, for any deployment
beyond a single API process. With per-process counters, a runaway
caller could hit your N replicas in parallel and slip past the
bucket N times over.

### Idempotency keys

`POST /v1/inbound/sms` uses a unique constraint
(`inbound_sms_idem_uq` on `(receiver_id, idempotency_key)`) plus a
catch-and-`SELECT` fallback. Two concurrent inbound POSTs with the
same idempotency key — even if they hit different API instances —
will see exactly one INSERT succeed; the other receives the same
matched/unmatched outcome from the existing row.

### Phone-binding consume

The `pending → verified` transition is an atomic conditional UPDATE
(`UPDATE phone_bindings SET status='verified' WHERE nonce=$1 AND
status='pending' AND ...`). Plus a partial unique index on
`(app_id, phone_e164) WHERE status='verified'`. Multi-instance safe;
no extra lock required.

## Migration ownership

**Run database migrations once before starting either tier.**

```bash
pnpm --filter @syrotp/server migrate
```

Neither the API server nor the standalone worker runs migrations on
boot. A worker (or API) that boots against a stale schema fails fast
on the first query. This is intentional — better than two parallel
processes racing each other for `ALTER TABLE` or partially applying
the same migration.

In a CI/CD pipeline, the natural shape is:

1. **Migrate step** runs `pnpm migrate` once against the target DB.
2. **Deploy step** rolls API replicas + worker replicas in parallel
   once the migrate step completes.
3. **Rollback step** is "deploy the previous image"; migrations
   should be backwards-compatible by design (drop columns in a
   later release, never the same one that adds them).

## Required and shared environment

These env vars **must be identical** across all API and worker
processes pointing at the same database. A drift here will produce
silent decryption failures or incompatible sessions:

| Var | Why every process must agree |
| --- | --- |
| `DATABASE_URL` | All instances read/write the same logical DB. |
| `REDIS_URL` | Rate-limit counters live here; per-process counters are useless across N replicas. |
| `MASTER_ENCRYPTION_KEY` | AEAD key for wrapped secrets (gateway signing keys, webhook secrets). A drift means a process can't decrypt rows another process wrote. |
| `COOKIE_SECRET` | Hosted-page session cookies are signed with this; drift means hosted-page sessions break across API replicas. |

These are **per-tier**; the API tier and the worker tier can hold
different values without harm:

| Var | API tier | Worker tier |
| --- | --- | --- |
| `WEBHOOK_WORKER_ENABLED` | `false` (in split mode) | `true` (or unset) |
| `PORT` / `HOST` | the load-balancer-facing address | unused — worker has no HTTP listener |
| `LOG_LEVEL` | per operator preference | per operator preference |

The worker process refuses to start with
`WEBHOOK_WORKER_ENABLED=false` (exits `2`). This is deliberate —
the flag is the API-tier opt-out signal, and a worker inheriting it
would silently spin a no-op loop forever. See
`docs/webhook-worker.md` for the full failure-message text.

## Postgres connection pool sizing

Each Node process opens a Postgres pool with `max=30` (set in
`apps/server/src/db/index.ts`). Total connections opened against
your Postgres equal `(api_replicas + worker_replicas) × 30`, plus
any admin sessions you're holding open.

| Topology | Connections at saturation |
| --- | --- |
| 1 API + 0 dedicated worker | 30 |
| 1 API + 1 worker | 60 |
| 2 API + 1 worker | 90 |
| 3 API + 1 worker | **120** — exceeds Postgres default `max_connections=100`. |
| 4 API + 2 workers | **180** — clearly needs tuning. |

Two paths once you cross the default ceiling:

1. **Bump `max_connections` in `postgresql.conf`** (managed Postgres
   uses parameter groups). The cost is RAM per connection; a
   well-provisioned managed Postgres instance handles 200–400 idle
   connections without trouble.
2. **Drop the per-process pool size** to e.g. `max=15`. Total
   connections become `(api + worker) × 15`. The trade-off is
   more head-of-line waiting under burst load — usually fine for
   the worker tier (it's always serial-per-tick), tighter for the
   API tier.

A connection pooler in front of Postgres (PgBouncer in transaction
mode) is the long-term answer once you go past ~10 replicas, but
that's outside v0.9 scope.

Redis: the per-process Redis client doesn't have a comparable
ceiling. Redis handles thousands of idle connections cheaply. No
tuning required for the topologies above.

## Webhook worker interval

The standalone worker ticks every `WEBHOOK_WORKER_INTERVAL_MS`
(default `5000`, range `100`–`60_000`).

- **Smaller interval** = lower webhook delivery latency for the next
  pending row, but more empty-tick DB load when the queue is idle.
- **Larger interval** = quieter when idle, but a single delivery's
  worst-case wait is the interval.

For the production MVP (N=1, single phone, single SIM) the default
of 5s is fine. Multi-tenant deployments with many endpoints often
land in the 1000–3000 ms range. Don't go below 500 ms — at that
rate the empty-tick `SELECT ... FOR UPDATE SKIP LOCKED` becomes a
noticeable fraction of the worker's CPU.

## Failure modes

These are the failure shapes you'll see in practice. Each maps to
either a documented behaviour or a follow-up to investigate.

### Redis is briefly unreachable

Rate-limit checks **fail open** —
`apps/server/src/services/rateLimit.ts:28-32` returns
`{ allowed: true, count: 0, ... }` when `redis.multi().exec()`
returns null. A 30-second Redis outage doesn't reject legitimate
traffic; it does mean abuse can get through during the window.

The trade-off was deliberate: rejecting traffic on a transient blip
is worse than briefly under-enforcing the bucket, especially since
the per-app cap is in place behind it as a second layer. Operators
should monitor Redis liveness independently and alert on outages
longer than ~60 seconds.

### Postgres goes away

Both API and worker hard-fail on the next query. The Node processes
themselves stay up; their next request returns `500`. There is no
in-memory queue that can mask a Postgres outage — webhook
deliveries that haven't been claimed yet stay in the table, and the
worker resumes draining when Postgres returns.

### One worker process crashes mid-tick

The 60-second `next_attempt_at` lease holds the row out of any
other worker's view. After the lease expires, the next tick on any
worker (the same one restarted, or a sibling) picks up the row
again. Worst-case delivery latency is `lease + interval` ≈ 65s on
defaults.

### Worker starts before migrations are run

The first `claimBatch()` query fails with `relation
"webhook_deliveries" does not exist` (or similar) and the worker
process exits. The supervisor should not auto-restart in this case
— investigate. The fail-fast is intentional; there is no "wait for
migrations" mode.

### `WEBHOOK_WORKER_ENABLED=false` mistakenly set on the worker tier

The worker process exits with code `2` and the message:

> `WEBHOOK_WORKER_ENABLED=false — refusing to start. The flag is
> for the API tier; a standalone worker process must have it set to
> true (or unset, which defaults to true). Likely cause: you're
> sourcing the API tier's env file unchanged.`

This is the single most likely env-mistake in split mode.

### Drift in `MASTER_ENCRYPTION_KEY` between API and worker

The worker reads `webhook_endpoints.secret_ciphertext` and unwraps
it with `MASTER_ENCRYPTION_KEY`. A drift here means the worker
**logs an unwrap error per delivery** and the row stays pending
forever (lease keeps refreshing on each tick, unwrap keeps failing).
Symptom: webhook deliveries aren't going out, but no row is
abandoned. Fix: equalize the env across tiers.

## Operator checklist for promoting from single-process to split

When you're moving an existing v0.8/v0.9 single-process deployment
into split mode:

1. **Verify the database has the v0.9 schema.** `pnpm migrate` is
   idempotent — running it again is safe. Don't assume; run it.
2. **Equalize the four shared env vars** (`DATABASE_URL`,
   `REDIS_URL`, `MASTER_ENCRYPTION_KEY`, `COOKIE_SECRET`) across
   what will become your API tier and worker tier.
3. **Add `WEBHOOK_WORKER_ENABLED=false` to the API tier's env**.
   Roll the API tier; the in-process worker timer is now a no-op.
4. **Start the worker tier separately** with `pnpm start:webhook`.
   On first boot, watch the logs for the
   `webhook delivery worker started (standalone)` info line.
5. **Verify deliveries are still flowing** by registering a webhook
   endpoint, triggering a verification → inbound → match flow, and
   confirming the receiver gets the POST. The
   `webhook_deliveries.status` column moves through `pending →
   delivered` exactly as before.
6. **Confirm rate limits are still applied** by hitting one
   endpoint past the per-app bucket from N different IPs and seeing
   the 429s land at the correct count, not at N × correct-count.
7. **Check Postgres connection count** matches expectations:
   `SELECT count(*) FROM pg_stat_activity WHERE usename='syrotp';`
   should equal `(api_replicas + worker_replicas) × 30` plus your
   admin connections.

If any of these is off, **stop and investigate before scaling
further**. Adding a third API replica on top of a misconfigured
two-replica deployment makes the diagnosis harder, not easier.

## Out of scope (deferred to later v0.9 PRs and beyond)

- **Worker `/healthz` and `/metrics` HTTP endpoints** — neither
  exists today. Process supervisors use `pgrep` / `pidof` /
  liveness probes against the API tier in the meantime. Adding an
  HTTP listener to the worker is a small, focused PR.
- **Receiver fleet operations** (heartbeat aging, manual disable,
  delete-and-rotate) — `docs/operations.md § Android Gateway
  runbook` is the current source; a fuller fleet-ops doc is planned
  as v0.9 PR #44.
- **Long soak / operational baseline** — extended loadtest, p95/p99
  latency budget, abuse-signals shape under sustained load. Planned
  as v0.9 PR #45.
- **Sharding strategies, connection poolers, paid SaaS dashboards,
  Play Integrity, auto-ban** — none of these are v0.9 scope. v0.9
  is Scale / HA / Operations *only*; product features are not
  appropriate here.

## Related

- [`docs/webhook-worker.md`](webhook-worker.md) — deep on the worker
  process itself (lifecycle, fail-fast on misconfig, SIGTERM
  semantics).
- [`docs/multi-instance-safety.md`](multi-instance-safety.md) — the
  audit artifact: file:line refs and verdicts for every shared-state
  operation.
- [`docs/operations.md`](operations.md) — operator runbook for the
  single-process MVP.
- [`docs/monitoring.md`](monitoring.md) — Prometheus metrics catalog
  and recommended alerts.
- [`docs/protocol.md`](protocol.md) — the wire contract this
  deployment guide preserves end-to-end.
