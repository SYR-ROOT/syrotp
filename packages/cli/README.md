# @syrotp/cli

Command-line interface for SYROTP. Operators run **`syrotp doctor`**,
**`syrotp bootstrap`**, **`syrotp receiver`**, **`syrotp smoke`**, and
**`syrotp loadtest`** instead of stitching together docker compose,
direct Postgres queries, and shell scripts.

## Install

The CLI lives in the SYROTP monorepo. From the repo root:

```bash
pnpm install
pnpm --filter @syrotp/cli build
pnpm syrotp --help        # convenience alias from root package.json
# or
pnpm exec syrotp --help
```

After publishing:

```bash
npm install -g @syrotp/cli
syrotp --help
```

## Commands

| Command | Effect |
|---|---|
| `syrotp doctor`                                          | check Node, pnpm, docker, `.env`, and reachability of postgres/redis/server |
| `syrotp bootstrap --app-name <s> --msisdn <e164>`        | mint a fresh app + API keys + receiver in one shot |
| `syrotp receiver add --app-id <id> --name <s> --msisdn <e164>` | register a new receiver under an existing app |
| `syrotp receiver list [--json]`                          | enumerate receivers (table or JSON) |
| `syrotp receiver disable <rcv_*>`                        | flip enabled=false (idempotent) |
| `syrotp receiver test <rcv_*> --signing-key <hex>`       | sign a probe inbound and verify the gateway path works |
| `syrotp smoke`                                           | run the end-to-end smoke test against a live server |
| `syrotp loadtest quick`                                  | the CI gate: scenario-a + replay-storm |
| `syrotp loadtest release-baseline [--continue-on-fail] [--csv]` | the v0.x release gate: 5-step suite |
| `syrotp version` / `syrotp help [<command>]`              | meta |

> ⚠️ **Secret keys (`sk_live_*`) and gateway signing keys are printed
> exactly once on the success path of `bootstrap` / `receiver add`.**
> Save them in your secret manager before doing anything else.

## Quickstart

```bash
docker compose up -d postgres redis
docker compose --profile migrate run --rm migrate
docker compose up -d server

pnpm syrotp doctor
pnpm syrotp bootstrap --app-name "My App" --msisdn +963991234567 --simulate-heartbeat
pnpm syrotp receiver list

# Use the signing key the bootstrap command printed:
pnpm syrotp receiver test <rcv_...> --signing-key <hex>

# Set SYROTP_BASE_URL/PUBLIC_KEY/SECRET_KEY/RECEIVER_ID/GATEWAY_KEY/PHONE
# (the bootstrap output gives you all of these), then:
pnpm syrotp smoke
pnpm syrotp loadtest quick
```

## `syrotp doctor`

Three groups of checks:

| Group         | Checks |
|---|---|
| Environment   | Node ≥ 20.10, pnpm, docker, docker compose |
| Configuration | `.env` file present, `DATABASE_URL`, `REDIS_URL`, `SYROTP_BASE_URL` |
| Reachability  | TCP probe to postgres, TCP probe to redis, GET `/v1/health` on the server |

`doctor` never modifies anything — it only reads env, files, and probes
ports. Safe to run on a stranger's machine.

## `syrotp loadtest`

| Subcommand | Wraps | Notes |
|---|---|---|
| `quick`             | `pnpm loadtest:quick`                                          | scenario-a (50 workers) + replay-storm chain |
| `release-baseline`  | `pnpm --filter @syrotp/loadtest start suite release-baseline`   | full 5-step suite |

Flags:

- `--continue-on-fail` — **release-baseline only**. Keep going after a step fails.
- `--csv` — **release-baseline only**. Emit `ops.csv` per step.

The quick path rejects both with a precise USAGE error.

## Exit codes (stable contract)

| Code | Name             | When |
|---:|---|---|
| 0  | OK              | every requested action succeeded |
| 1  | RUNTIME         | a check or operation failed at runtime (e.g. acceptance failed, scenario rejected) |
| 2  | USAGE           | bad CLI arguments / unknown command / unknown flag |
| 3  | MISSING_CONFIG  | required env var or `.env` is not present |
| 4  | MISSING_DEP     | Node too old / pnpm or docker not on PATH |
| 5  | UNREACHABLE     | postgres / redis / SYROTP server didn't answer |

These numbers are part of the public contract — CI scripts and Makefiles
branch on them. They will not change across minor versions of the CLI.

## Environment

| Var | Used by | Effect |
|---|---|---|
| `SYROTP_BASE_URL`             | doctor, smoke, loadtest, receiver test | server URL (e.g. `http://localhost:3000`) |
| `DATABASE_URL`               | doctor, bootstrap, receiver add/list/disable | postgres connection (writes happen here) |
| `MASTER_ENCRYPTION_KEY`      | bootstrap, receiver add | wraps gateway signing keys at rest |
| `REDIS_URL`                  | doctor | redis reachability probe |
| `SYROTP_PUBLIC_KEY` / `SYROTP_SECRET_KEY` / `SYROTP_RECEIVER_ID` / `SYROTP_GATEWAY_KEY` / `SYROTP_PHONE` | smoke | smoke fixture set |
| `NO_COLOR=1`                 | all              | disable ANSI color output |
| `DEBUG=1`                    | all              | print stack traces on unexpected errors |

## Design principles

- **Wrappers, not re-implementations.** `bootstrap` and `receiver`
  call helpers in `@syrotp/server/admin` (the same code path the legacy
  `dist/scripts/bootstrap.js` runs). `smoke` and `loadtest` spawn
  `pnpm smoke` and `pnpm --filter @syrotp/loadtest start ...` verbatim.
  No scenario or auth logic is duplicated inside the CLI.
- **Pre-flight before spawn.** Every command that hits the network
  validates env up-front and probes `/v1/health` so failures surface as
  a clean `MISSING_CONFIG` (3) or `UNREACHABLE` (5) instead of a cryptic
  trace from the spawned tool.
- **Secrets shown once.** Success paths print `pk_live_*`, `sk_live_*`,
  and signing keys exactly once. Error paths never echo them — every
  argv-validation and missing-config branch is regression-tested.
- **Cross-platform spawn.** `pnpm` on Windows is a `.cmd` shim; the
  spawn helper sets `shell: true` on win32 only when invoking pnpm so
  shims resolve without breaking `execFile` semantics elsewhere.
