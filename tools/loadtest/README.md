# @syrotp/loadtest

Load and reliability tooling for SYROTP. Runs black-box scenarios against a
running server, measures latency / throughput, and **gates a run on
explicit acceptance criteria** so a regression fails the exit code.

## Why a load tool

CLI, Dashboard, and the GSM gateway will all build on top of the same
endpoints (`start verification`, `inbound sms`, `status polling`,
`heartbeat`). If those have hidden bottlenecks, every downstream feature
inherits them. v0.1.1 establishes the baseline numbers we'll publish.

## Quickstart

```bash
# 1. Server up
docker compose up -d
docker compose --profile migrate run --rm migrate
docker compose up -d server

# 2. Auto-prep mode — the load tool creates its own fixtures via the DB.
export SYROTP_BASE_URL=http://localhost:3000
export DATABASE_URL=postgres://syrotp:syrotp_dev_password@localhost:5432/syrotp
export MASTER_ENCRYPTION_KEY=$(grep MASTER_ENCRYPTION_KEY .env | cut -d= -f2)

# 3. Run a scenario
pnpm loadtest scenario-a
```

Each run writes to `tools/loadtest/reports/<timestamp>-<scenario>/`:

- `report.json` — machine-readable, includes meta, metrics, acceptance, env summary (redacted)
- `summary.md` — human-readable
- `ops.csv` — optional, with `--csv`

The process exits **non-zero** if any acceptance check fails — wire it
into CI to catch regressions.

## Scenarios

| Name                | Default total | Receivers | What it does |
|---|---:|:---:|---|
| `scenario-a`        | 1 000 | 1 | full happy-path: start → inbound → status |
| `scenario-b`        | 10 000 | 1 | same as A, larger volume |
| `scenario-c`        | 2 000 | 2 | full flow with 2 receivers (load-balance check) |
| `start-only`        | 1 000 | 1 | start verifications only |
| `inbound-only`      | 1 000 | 1 | seed pending verifications, then storm inbound |
| `full-flow`         | 1 000 | 1 | alias of A with no fixed default |
| `status-polling`    | 5 000 | 1 | hammer GET /v1/verifications/{id} |
| `mixed`             | 1 000 | 1 | 60/30/10 mix of full / poll / start-only |
| `replay-storm`      | 1 000 | 1 | same nonce repeated; expect 401 every time |
| `wrong-code-storm`  | 1 000 | 1 | signed inbound with garbage codes; expect no_match |
| `receiver-disabled` | 1 000 | 2 | mid-flight `UPDATE receivers SET enabled=false` on receiver 1 |

Override defaults:

```bash
pnpm loadtest scenario-b --workers 100 --total 10000 --csv
pnpm loadtest start-only --total 5000 --p95-start 200
```

## Suites — single command release gates

A suite runs an ordered list of scenarios, writes per-step reports into
nested folders, and emits ONE aggregate report (`aggregate.json` +
top-level `summary.md`) at the suite root.

```bash
pnpm loadtest suite release-baseline
pnpm loadtest suite release-baseline --continue-on-fail   # don't stop on first fail
pnpm loadtest suite release-baseline --csv                # also emit ops.csv per step
```

| Suite | Steps |
|---|---|
| `release-baseline` | `scenario-a` → `scenario-b --workers 100` → `replay-storm` → `wrong-code-storm` → `receiver-disabled` |

### Layout

```
tools/loadtest/reports/<timestamp>-release-baseline/
  aggregate.json                # full machine-readable result
  summary.md                    # the human-readable verdict
  scenario-a/
    report.json
    summary.md
    ops.csv      # if --csv
  scenario-b/
    report.json
    summary.md
  replay-storm/
    report.json
    summary.md
  wrong-code-storm/
    report.json
    summary.md
  receiver-disabled/
    report.json
    summary.md
```

### Suite verdict

The aggregate report adds a **Hard Safety** section that sums these
counters across every step:

| Counter | Meaning |
|---|---|
| `double_verifications` | atomic-claim invariant violated |
| `unhandled_exceptions` | a worker threw past its own try/catch |
| `err_5xx`              | server-side errors (DB / Redis pressure usually) |
| `network_err`          | TCP / TLS errors |
| `timeout`              | request exceeded the client timeout |

The suite is **PASS** only if:

1. Every step's individual acceptance check passed, **and**
2. Every hard-safety counter is zero.

That second condition is intentionally stricter than what an individual
scenario gates on — the suite is the release gate, so it doesn't tolerate
any of those counters being non-zero, even if a permissive single-step
policy would.

### Recommended interface: the `syrotp` CLI (v0.2+)

```bash
pnpm syrotp loadtest quick                                  # CI gate
pnpm syrotp loadtest release-baseline                       # release gate
pnpm syrotp loadtest release-baseline --continue-on-fail
pnpm syrotp loadtest release-baseline --csv
```

The CLI pre-flights the env + `/v1/health`, then spawns the load tool
verbatim. Exit codes follow the stable `@syrotp/cli` contract.

### Raw npm aliases (advanced)

| Script | Use for |
|---|---|
| `pnpm loadtest:quick` | Same as `syrotp loadtest quick` — `scenario-a --workers 50` + `replay-storm`. |
| `pnpm loadtest:all`   | Same as `syrotp loadtest release-baseline` — alias of `loadtest suite release-baseline`. |
| `pnpm loadtest <args>` | Direct invocation. Useful for one-off scenario runs (`pnpm loadtest scenario-b --workers 100`, etc.). |

## Acceptance criteria (defaults)

| Check | Default |
|---|---|
| no unhandled worker exceptions | always |
| no 5xx responses | happy-path scenarios (A, B, C, full-flow, mixed, polling, storms) |
| success rate (start ∪ inbound ∪ status) | ≥ 99.9% on full flow; ≥ 99% on mixed |
| p95 start         | ≤ 400ms (cross-platform local — see docs/performance.md) |
| p95 inbound match | ≤ 400ms |
| p95 status        | ≤ 400ms |
| no double-verifications | always when inbound is involved |

Override at the CLI:

```bash
pnpm loadtest scenario-a --p95-start 400 --p95-inbound 400
```

Disable gating (still write the report) with `--no-acceptance`.

## Two ways to provide fixtures

### Auto-prep (developer-friendly)

The tool creates a fresh app, two API keys, and N receivers in the DB. It
writes them with the same wrapping the production bootstrap script uses,
then deletes them on completion. Requires `DATABASE_URL` and
`MASTER_ENCRYPTION_KEY`.

### BYO env (CI-friendly)

Run the production `bootstrap.js` once per receiver and export:

```bash
SYROTP_BASE_URL=https://otp.example.com
SYROTP_PUBLIC_KEY=pk_live_...
SYROTP_SECRET_KEY=sk_live_...
SYROTP_RECEIVER_1_ID=rcv_...
SYROTP_RECEIVER_1_KEY=...           # raw signing key from bootstrap
SYROTP_RECEIVER_1_MSISDN=+963998887777
# For scenarios C and receiver-disabled, also:
SYROTP_RECEIVER_2_ID=rcv_...
SYROTP_RECEIVER_2_KEY=...
SYROTP_RECEIVER_2_MSISDN=+963998887778
```

The tool will not touch the DB in this mode (except `receiver-disabled`,
which still requires `DATABASE_URL` to flip the row mid-flight).

## Sample output

```
[loadtest] scenario=scenario-a total=1000 workers=50
[loadtest] fixtures: auto-prepped, receivers=1
[loadtest] report: tools/loadtest/reports/2026-05-02T14-22-03-321Z-scenario-a

  duration:  3.41s
  start    total=1000 ok=1000 5xx=0 timeout=0 p50=12.4ms p95=38.1ms p99=72.6ms
  inbound  total=1000 ok=1000 5xx=0 timeout=0 p50=8.7ms  p95=24.2ms p99=51.3ms
  status   total=1000 ok=1000 5xx=0 timeout=0 p50=4.9ms  p95=14.8ms p99=31.2ms

  ✅  p95 start ≤ threshold                     threshold=250.00ms actual=38.10ms
  ✅  p95 inbound ≤ threshold                   threshold=250.00ms actual=24.20ms
  ✅  p95 status ≤ threshold                    threshold=250.00ms actual=14.80ms
  ✅  success rate ≥ 99.90%                     threshold=99.90%   actual=100.00%
  ✅  no double-verifications                   threshold=0        actual=0
  ✅  no 5xx responses                          threshold=0        actual=0
  ✅  no unhandled worker exceptions            threshold=0        actual=0

  ✅ ACCEPTANCE PASS
```

Numbers above are illustrative — generate your own on your hardware before
quoting them publicly.

## Output schema (report.json)

```jsonc
{
  "meta": { "scenario": "scenario-a", "command": "...", "git_commit": "...", "node": "v20...", "host": "...",
            "env": { "SYROTP_BASE_URL": "http://localhost:3000", "DATABASE_URL": "postgres://syrotp:***@..." } },
  "metrics": {
    "duration_seconds": 3.41,
    "double_verifications": 0,
    "unhandled_exceptions": 0,
    "start":   { "total": 1000, "ok": 1000, "..." : 0, "latency": { "p50_ms": 12.4, "p95_ms": 38.1, "p99_ms": 72.6 }, "extras": {} },
    "inbound": { "...": 0, "extras": { "matched": 1000 } },
    "status":  { "...": 0, "extras": { "status_verified": 1000 } }
  },
  "acceptance": { "pass": true, "checks": [ ... ] },
  "resources":  { "mem_rss_after_mb": 64.2 }
}
```
