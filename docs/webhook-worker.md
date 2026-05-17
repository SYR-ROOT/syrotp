# Webhook Delivery Worker — Deployment Modes

The SYROTP webhook delivery worker can run in **two** deployment shapes.
Both produce identical wire output; the choice is operational.

## 1. Single-process (default)

The API server starts the worker in-process at boot. This is the
default since v0.5 (when webhooks landed) and remains the default
through v0.9.

- `WEBHOOK_WORKER_ENABLED=true` (the default) — leave it unset and it
  stays true.
- One Node process serves HTTP **and** drains the delivery queue.
- `pnpm migrate` once, then `pnpm start` — that's the deployment.

This is the right shape for the production MVP and for any
single-tenant deployment. Verification latency is dominated by
Postgres + Redis round-trips; the in-process worker doesn't visibly
contend.

## 2. Split (worker on its own process)

For deployments where the operator wants to:

- Scale API and worker tiers independently (heavy webhook fan-out
  without touching the verification path's CPU budget).
- Run multiple API instances behind a load balancer (the in-process
  worker would compete with itself — disabling it on the API tier
  and running one or more dedicated workers is cleaner).
- Deploy the worker to a different VM / container so a webhook
  delivery storm can't saturate the API server's outbound socket
  budget.

The split mode looks like this:

| Process | `WEBHOOK_WORKER_ENABLED` | Command |
| --- | --- | --- |
| API server (any number of instances) | `false` | `pnpm start` |
| Worker process (1+ instances) | `true` (or unset) | `pnpm start:webhook` |

The worker entrypoint lives at `apps/server/src/workers/webhook.ts`
and is built to `dist/workers/webhook.js`. It is intentionally
minimal: pino logger + Postgres pool + the existing `WebhookWorker`
class + signal handlers. **No Fastify, no HTTP listener, no
/healthz, no /metrics on this process** in v0.9 PR #41 — adding
those is a follow-up.

### Multi-instance safety

The DB layer already handles N concurrent workers without
double-delivery:

- Claim query uses `FOR UPDATE SKIP LOCKED` so two workers can't
  pick up the same row.
- Each claimed row gets a soft 60-second `next_attempt_at` lease
  before the HTTP call. A worker that crashes mid-tick recovers
  within a minute.

You can run two or more `start:webhook` processes against the same
database without configuration changes. There is no leader
election, no per-worker shard key, no distributed lock — the queue
itself is the lock.

### What runs migrations

**Migration ownership stays single.** Run database migrations
**once** before starting the API and worker processes:

```bash
pnpm --filter @syrotp/server migrate
```

Neither the API nor the worker runs migrations on boot. A worker
booting against a stale schema fails fast on the first claim query,
which is the desired behaviour — better than two parallel processes
racing each other for `ALTER TABLE`.

### `WEBHOOK_WORKER_ENABLED=false` on a worker process

The standalone worker entrypoint refuses to start when
`WEBHOOK_WORKER_ENABLED=false` and exits with status 2. The flag is
meant for the **API tier** in split mode; a worker process
inheriting it would silently spin a no-op loop forever. Failing
fast surfaces an env-file mistake immediately.

```text
$ WEBHOOK_WORKER_ENABLED=false pnpm start:webhook
ERROR: WEBHOOK_WORKER_ENABLED=false — refusing to start. The flag
is for the API tier; a standalone worker process must have it set
to true (or unset, which defaults to true). Likely cause: you're
sourcing the API tier's env file unchanged.
```

### Stopping a worker

The standalone process handles SIGINT and SIGTERM. On signal:

1. Timer is cleared (no new ticks scheduled).
2. The worker waits for any in-flight tick to finish — the existing
   `stop()` polls the in-flight flag every 25 ms.
3. The Postgres pool is drained via `closeDb()`.
4. Process exits 0.

Process supervisors (`systemd`, `kubernetes`, `pm2`) should send
SIGTERM and allow at least 90 seconds for graceful shutdown — long
enough for one in-flight HTTP delivery (5s timeout) plus the soft
lease window margin.

## What happens to existing single-process deployments

Nothing. The default of `WEBHOOK_WORKER_ENABLED=true` is unchanged.
A v0.8 deployment upgrading to v0.9 keeps running exactly as it
did, the in-process timer still ticks, the worker still drains the
queue. Split mode is purely additive — opt in by setting the env
flag and running the new process.

## Metrics

Webhook delivery metrics are emitted by the worker class regardless
of which process it runs in. In the standalone process, those
counters land in the worker process's prom-client `Registry` — but
since the standalone process doesn't currently expose `/metrics`,
they're not scrape-visible from the standalone worker in PR #41.
**Track Prometheus webhook metrics from the API tier's `/metrics`
endpoint until the worker exposes its own.** This is on the v0.9
backlog.

## Related

- `apps/server/src/workers/webhook.ts` — the standalone entrypoint.
- `apps/server/src/services/webhookWorker.ts` — the shared worker
  class used by both deployment modes.
- `apps/server/src/services/webhooks.ts` — endpoint/event/delivery
  CRUD + the wire signature contract.
- [`docs/webhooks.md`](webhooks.md) — webhook protocol from the
  developer's side (signature scheme, retry table, payload shape).
- [`docs/operations.md`](operations.md) — operator runbook.
