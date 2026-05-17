# Performance baseline

This is the published reference baseline for SYROTP. The numbers come from
the `release-baseline` suite (`pnpm syrotp loadtest release-baseline`).
They are **reference points**, not SLAs — your hardware, network, and
operator integration will be different.

## How to reproduce

```bash
docker compose up -d postgres redis
docker compose --profile migrate run --rm migrate
docker compose up -d server

export SYROTP_BASE_URL=http://localhost:3000
export DATABASE_URL=postgres://syrotp:syrotp_dev_password@localhost:5432/syrotp
export MASTER_ENCRYPTION_KEY=$(grep MASTER_ENCRYPTION_KEY .env | cut -d= -f2)

pnpm syrotp loadtest release-baseline
# (or `pnpm loadtest:all` for the raw alias)
```

Outputs land in `tools/loadtest/reports/<timestamp>-release-baseline/`,
including a per-scenario subdirectory and a top-level `aggregate.json` +
`summary.md`.

## What the suite covers

| Step | Scenario | Total ops | Workers | What it proves |
|---|---|---:|---:|---|
| 1 | `scenario-a`        |  1 000 |  50 | Happy-path full flow at modest concurrency. |
| 2 | `scenario-b`        | 10 000 | 100 | Same flow at 10× volume / higher concurrency. |
| 3 | `replay-storm`      |  1 000 |  50 | Same nonce hammered: every replay rejected (401). |
| 4 | `wrong-code-storm`  |  1 000 |  50 | Signed inbounds with garbage codes: every one `no_match`, none verifies. |
| 5 | `receiver-disabled` |  1 000 |  50 | One of two receivers flips disabled mid-run; traffic continues on the other. |

Total ≈ 14 000 operations. Local single-node compose: ≈ 60–90 seconds.

## Acceptance gates (defaults)

These are what the suite exits non-zero on. Override per-scenario with
`--p95-*` flags if your hardware needs different numbers.

| Gate | Applies to | Threshold |
|---|---|---|
| p95 latency (start, inbound, status)  | full-flow scenarios | ≤ 400 ms locally / ≤ 500 ms in CI |
| success rate                          | full-flow scenarios | ≥ 99.9 % |
| no 5xx responses                      | every step          | err_5xx == 0 |
| no double-verifications               | every step that does inbound | == 0 |
| no unhandled worker exceptions        | every step          | == 0 |

The 400 ms "local" target is intentionally cross-platform: Linux native
typically lands around 100–200 ms, while Windows + Docker Desktop adds
~5–15 ms per DB round-trip due to WSL2/Hyper-V networking. A full-flow
op makes ~4 round-trips, so 350 ms is achievable but 250 ms is unrealistic
on Windows hardware. If you're on Linux native, tighten the target with
`--p95-start 200 --p95-inbound 200 --p95-status 150`.

The aggregate `summary.md` adds a **Hard Safety** section that sums these
counters across the whole suite. The suite is **PASS only if every step
passes AND every hard-safety counter is zero.**

## Reference numbers (v0.1.1 baseline)

Captured on **Windows 11 + Docker Desktop (WSL2 backend), Node 22, Postgres 16,
Redis 7**, all on a single laptop, server running natively on host with
Postgres + Redis in compose mapped to host ports 5433/6380.

| Scenario | p50 start | p95 start | p50 inbound | p95 inbound | p50 status | p95 status | success |
|---|---:|---:|---:|---:|---:|---:|---:|
| scenario-a (1k @ 50w)   | ~115 ms | ~194 ms | ~119 ms | ~196 ms | ~55 ms  | ~86 ms  | 100% |
| scenario-b (10k @ 100w) | ~247 ms | ~328 ms | ~238 ms | ~317 ms | ~106 ms | ~144 ms | 100% |
| replay-storm  (1k)      | — | — | ~36 ms  | ~46 ms  | — | — | 1000/1000 replays rejected |
| wrong-code-storm (1k)   | — | — | ~111 ms | ~131 ms | — | — | 1000/1000 no_match |
| receiver-disabled (1k)  | ~125 ms | ~178 ms | ~107 ms | ~152 ms | ~58 ms  | ~88 ms  | 100% (graceful failover) |

Hard safety across all five steps: **double_verifications=0, unhandled_exceptions=0,
err_5xx=0, network_err=0, timeout=0**.

Throughput on this hardware: ~163 full-flow ops/sec at scenario-b's 100-worker
concurrency (each op = start + inbound + status, so ~490 HTTP req/s).

Memory: server RSS stays under ~80 MB through scenario-b. PostgreSQL
working set is dominated by inserts (verifications + inbound_sms).

**Don't quote these numbers in capacity plans without re-running on your
own hardware.** Linux native deployments will likely show p95s 30–50 % lower.

## What we monitor in production

These are the signals to graph and alert on for any real SYROTP
deployment:

- **Verifications/sec** at the `POST /v1/verifications` endpoint.
- **Inbound match rate** (matched / total inbound). A sudden drop
  usually means a receiver clock skew or a code-prefix change.
- **5xx rate**. Must be zero in steady state.
- **p95 latency** per endpoint. Set the alert threshold to ~3× your
  baseline p95 — that's where Postgres or Redis pressure usually shows
  up first.
- **Receiver heartbeat age**. Page someone if any active receiver's
  `last_heartbeat_at` exceeds `2 × RECEIVER_HEARTBEAT_TIMEOUT_SECONDS`.
- **Unmatched inbound rate**. A spike often means a broken gateway,
  abuse, or a misrouted carrier sender.

A `/metrics` Prometheus endpoint is on the v0.2 list; until it lands,
scrape from the audit log + `pg_stat_statements`.

## Known scaling boundaries

What we have NOT yet measured:

- Sustained load over many hours (soak / leak detection).
- Multi-replica server with a shared Postgres + Redis.
- Cross-region latency between server and gateway.
- Behavior when Postgres exceeds its working set / WAL pressure.
- Behavior when Redis is unreachable (rate limits fail open; replay
  guard fails closed — both intentional).

These are on the v1.0 hardening list — see [ROADMAP.md](../ROADMAP.md).

## When to rerun the baseline

- Before tagging any release that touches the request path, DB schema,
  auth/HMAC code, or rate-limit logic.
- After a Node, Fastify, Drizzle, postgres-js, or ioredis upgrade.
- Whenever a CHANGELOG entry mentions performance or reliability.

Compare the new `aggregate.json` with the previous run before publishing
new numbers — a 30 % p95 regression that still passes the gate is still
worth a paragraph in the release notes.
