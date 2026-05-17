# Operational Baseline — v0.9

This is the **operational gate** for SYROTP from v0.9 onward — the
counterpart to the integration suite (correctness gate) and the
release-baseline loadtest (release-readiness gate). The operational
baseline is what you run when you want to characterise **steady-state
behaviour over minutes**, not seconds, and decide whether a deployment
is ready to scale beyond the single-process MVP.

Compared with the existing release-baseline:

| Gate | Wall-clock | Run when | Purpose |
| --- | --- | --- | --- |
| Integration suite | ~30 s | every PR + pre-tag | Correctness — does the protocol still work? |
| `release-baseline` loadtest | ~1 min | pre-tag | Burst-shape SLOs hold, no 5xx, no double-verify |
| `soak` loadtest | ~3-5 min | pre-promotion to multi-instance, after major refactors | Steady-state: lease churn, log growth, abuse-signal drift, p99 capture |
| Manual RSS / log-growth observation | the soak window | alongside the soak | Memory + on-disk growth aren't measured automatically |

The soak is **opt-in** — it's NOT part of the `release-baseline.yml`
workflow that runs on tag push. v0.9 ships the machinery; operators
choose when to run it.

## What "v0.9 ready-to-scale" means

A deployment is ready to be promoted from single-process to split (or
multi-API + multi-worker) when:

1. **Integration suite** is green on `main` against the deployment's
   image. (`pnpm --filter @syrotp/server test:integration`).
2. **`release-baseline` suite** passes against the deployment's image
   with hard-safety counters at zero. This is the burst-shape gate.
3. **`soak` suite** passes against the deployment's image. This is the
   steady-state gate.
4. **Manual observation during the soak window** confirms RSS is
   stable (within ~10% of the start-of-soak value) and Postgres
   `pg_stat_activity` count matches the formula in
   [`docs/multi-instance-deployment.md`](multi-instance-deployment.md)
   (`(api_replicas + worker_replicas) × 30`).

If any of the above fails, **do not promote**. The release-baseline
suite is fast enough to be the pre-tag gate; the soak is slow enough
to surface things release-baseline can't.

## Running the soak

Same shape as any other loadtest run:

```bash
# 1. Server up at the version under test (single-process or split mode).
docker compose up -d
pnpm --filter @syrotp/server migrate
pnpm --filter @syrotp/server start &

# 2. Loadtest env.
export SYROTP_BASE_URL=http://localhost:3000
export DATABASE_URL=postgres://syrotp:<pwd>@localhost:5432/syrotp
export MASTER_ENCRYPTION_KEY=$(grep ^MASTER_ENCRYPTION_KEY .env | cut -d= -f2)

# 3. Soak suite.
pnpm loadtest suite soak

# Or just the soak scenario standalone (skips the storms after).
pnpm loadtest soak
```

The suite runs four steps: `soak` (sustained full-flow,
50 000 requests / 100 workers), `replay-storm`, `wrong-code-storm`,
`receiver-disabled`. Aggregated report lands at
`tools/loadtest/reports/<ts>-soak/{aggregate.json,summary.md}`.

## Latency budget — what to expect, and what to do

The acceptance policy for the `soak` scenario gates p95 latencies at
**500 ms each** for `start`, `inbound`, `status` — slightly relaxed
vs. `scenario-b`'s 400 ms because steady-state under sustained load
legitimately runs warmer than a 1k-request burst. p99 is **captured
and reported but NOT gated** in v0.9.

What "expected" looks like depends on the hardware and the deployment
shape. The numbers below are the **acceptance shape** — operators
adjust the absolute thresholds via the standard
`--p95-start <ms>` / `--p95-inbound <ms>` / `--p95-status <ms>` flags
once they've baselined their own infra.

| Op | p95 gate | p99 (advisory only) | Comment |
| --- | --- | --- | --- |
| `start` | ≤ 500 ms | record | Verification creation; goes through the per-`(app, phone)` advisory lock from PR #42. |
| `inbound` | ≤ 500 ms | record | Inbound SMS match; HMAC verify + `UPDATE ... WHERE status='pending'`. |
| `status` | ≤ 500 ms | record | Read-only verification status query. |
| `success rate` | ≥ 99.9% | n/a | Same as scenario-b. |
| `5xx total` | == 0 | n/a | Hard safety. |
| `double_verifications` | == 0 | n/a | Hard safety — proves the matching path is still atomic under sustained load. |

### Capturing your own baseline

After the first clean soak run, record the p95 + p99 numbers per
operation as your local baseline in your operations notes. On the
**second** soak run (e.g. after a deployment), compare:

- p95 within ±20% of baseline → expected.
- p95 > 1.5× baseline → investigate (often a stale receiver, a
  Postgres pool exhaustion, or a Redis blip — see triage table
  below).
- p99 climbing over the soak window (e.g. minute-3 p99 is 2× minute-1
  p99) → investigate. Steady-state should mean steady p99.

Once the project has a few real-world v0.9 baselines logged, a future
PR can convert p99 into an **acceptance gate** with thresholds chosen
from data. **In v0.9 it's report-only** by deliberate choice — gating
on a guessed threshold is worse than not gating.

> **p99 in v0.9 is reported but not gated.** Use the captured v0.9
> baseline to decide future p99 thresholds. Don't add a p99 gate
> without first running the soak on production-shape hardware and
> recording numbers that justify it.

## Manual RSS / log-growth observation

There is no automated memory-growth check in v0.9 — by design, since
adding a sampler that doesn't perturb the workload is its own design
problem. The manual procedure that goes alongside the soak is:

### Linux

```bash
# In one terminal, before starting the soak:
pidstat -r -p $(pgrep -f syrotp-server) 30   # every 30s, RSS in KB

# In another terminal:
pnpm loadtest suite soak
```

What "stable" looks like: RSS climbs from baseline to a plateau over
the first ~30 seconds (warm-up + connection pool fill), then stays
within ±10% for the remaining 3-5 minutes of the soak. **A monotonic
climb past the warm-up is the symptom that matters** — usually a
listener leak (subscriber not being removed), a circular ref in a
service singleton, or unbounded log buffering.

### macOS

```bash
ps -o pid,rss,command -p $(pgrep -f syrotp-server) | awk '{print $2}' \
  > /tmp/rss-baseline.txt

# while the soak runs, periodically:
ps -o pid,rss,command -p $(pgrep -f syrotp-server) | awk '{print $2}'
```

### Windows

```powershell
# Periodically, while the soak runs:
Get-Process -Name node | Where-Object { $_.MainWindowTitle -like "*syrotp*" -or $_.Id -eq <pid> } | `
  Select-Object Id, @{Name="RSS_MB"; Expression={[math]::Round($_.WorkingSet64 / 1MB, 1)}}
```

### Log growth

The server's pino logs go to stdout by default. Pipe to a file when
soaking:

```bash
pnpm --filter @syrotp/server start > /tmp/syrotp-soak.log 2>&1 &
SOAK_PID=$!
# … run soak …
ls -la /tmp/syrotp-soak.log
```

A 50 000-request soak at default `LOG_LEVEL=info` produces ~3-5 MB of
log output (one line per request, plus periodic abuse-signal +
receiver-gauge refresh entries). If your log file blows past
~50 MB, something is logging in a tight loop — flag and triage.

## Soak failure-mode triage

| Symptom in soak report | Likely cause | Next step |
| --- | --- | --- |
| `5xx total > 0` | Postgres connection pool exhaustion, or an unhandled exception in a service path | Check server logs around the timestamp; query `pg_stat_activity` for connection saturation. The pool is `max=30` per process — see [`docs/multi-instance-deployment.md`](multi-instance-deployment.md). |
| `double_verifications > 0` | The advisory-lock fix from PR #42 is not landing | Verify the `verifications` route is wrapping count + insert in a transaction with `pg_advisory_xact_lock`. See [`docs/multi-instance-safety.md`](multi-instance-safety.md). |
| `p95 start` climbs over the soak window | `pickReceiver` is doing extra work as receivers go stale; advisory lock contention on a hot phone | Check `last_heartbeat_at` for all enabled receivers; ensure heartbeats are landing. Hot-phone contention is rarely the issue at single-tenant scale. |
| `p95 inbound` climbs but `start` is flat | Webhook delivery is starving the same DB pool | Confirm `WEBHOOK_WORKER_INTERVAL_MS` is at the default 5000 ms; if you've cranked it lower, the pool's getting hammered. |
| `success rate < 99.9%` with 4xx | Rate limit kicking in; the loadtest isn't tuned for the configured caps | Bump `RATE_LIMIT_VERIFICATIONS_PER_APP_PER_MIN` for the soak window, or shrink the loadtest's `--workers`. |
| `p99 climbs over the soak window` | A growing queue somewhere — webhook deliveries piling up faster than the worker drains, abuse-signal computation getting slower, or DB index bloat | Watch the abuse-signals gauges via `/admin/abuse-signals`; check `webhook_deliveries` row counts before and after the soak. |
| `receiver-disabled` step fails | The mid-flight disable isn't being respected | Check that the `/admin/receivers/<id>` disable path actually flipped `enabled` (the loadtest's mid-flight hook expects synchronous DB visibility). |
| RSS climbs monotonically past warm-up | Listener / cache / log-buffer leak | See "Manual RSS / log-growth observation" above. |

## What a green soak looks like

The aggregate report's `overall: PASS` line is the gate, but the
shape of a healthy soak in `summary.md` looks like:

```
- soak: ✅ PASS — p95 start=<x>ms, inbound=<y>ms, status=<z>ms,
  p99 start=<a>ms inbound=<b>ms status=<c>ms,
  success=99.97%, 5xx=0
- replay-storm: ✅ PASS — replay_rejected=1000, 5xx=0
- wrong-code-storm: ✅ PASS — no_match=1000, matched_unexpectedly=0, 5xx=0
- receiver-disabled: ✅ PASS — start ok=…, inbound ok=…, 5xx total=0

## Hard Safety
| double_verifications | 0 |
| unhandled_exceptions | 0 |
| err_5xx | 0 |
| network_err | 0 |
| timeout | 0 |
```

Anything other than zero in the hard-safety table is an automatic
fail regardless of latency. A 1.5× p95 vs your local baseline,
combined with a clean hard-safety table, is **investigate, don't
panic** — it's usually a hardware contention you can identify.

## Out of scope (not in v0.9)

- **Mandatory p99 acceptance gates** — captured but advisory until
  real baselines are recorded. A future PR can pick thresholds from
  data.
- **Automated memory-growth measurement** — manual is enough for
  v0.9; an in-runner sampler that doesn't perturb the workload is a
  larger design.
- **Automated log-growth measurement** — same reasoning.
- **Webhook delivery soak scenario** — would need an inbound HTTP
  receiver embedded in the loadtest. Defer.
- **Distributed-trace + flame-graph integration** — out of v0.9
  scope; production observability layer is its own track.
- **Auto-scaling triggers off any soak metric** — out of scope by
  policy. Operators read the report and decide.
- **CI integration of the soak suite** — kept opt-in, NOT auto-run
  on tag push. The release-baseline suite is the fast pre-tag gate;
  soak is run at operator discretion.

## Related

- [`tools/loadtest/README.md`](../tools/loadtest/README.md) — the
  loadtest runner itself; scenario definitions, CLI flags, report
  format.
- [`docs/multi-instance-deployment.md`](multi-instance-deployment.md) —
  what changes when you scale beyond single-process; the
  `pg_stat_activity` formula referenced in the ready-to-scale
  checklist.
- [`docs/multi-instance-safety.md`](multi-instance-safety.md) — the
  shared-state audit; the source of truth for what each operation's
  safety depends on.
- [`docs/webhook-worker.md`](webhook-worker.md) — the worker process
  whose tick stability the soak indirectly exercises.
- [`docs/receiver-fleet.md`](receiver-fleet.md) — receiver lifecycle
  states; the soak's `receiver-disabled` step exercises the
  mid-flight disable behaviour documented there.
- [`docs/monitoring.md`](monitoring.md) — Prometheus metrics catalog;
  the abuse-signals gauges (`syrotp_abuse_*`) are what you watch
  alongside the soak to confirm steady-state.
