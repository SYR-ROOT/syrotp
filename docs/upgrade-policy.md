# SYROTP Upgrade & Migration Policy

**Status:** Normative for v1.0. Pins the migration discipline, the
upgrade order, and what's actually tested vs left to operator
diligence.

This document is intentionally narrow: it covers **how** to upgrade an
SYROTP deployment safely and what the project guarantees while you do.
For the deployment topologies themselves see
[`multi-instance-deployment.md`](multi-instance-deployment.md). For
the wire-contract stability commitment, see
[`api-contract.md`](api-contract.md). For the version skew rules SDKs
implement, see [`sdk-versioning.md`](sdk-versioning.md).

## Discipline summary

Two rules govern everything below:

1. **Forward-only migrations.** Every change is a new SQL file with a
   higher number. There are no down migrations. Rolling back means
   "deploy the previous server image" — not "undo the schema."
2. **Additive within a protocol MAJOR.** Every migration that ships
   inside `1.x` must be backwards-compatible with the previous server
   image. Drop a column in a later release than the one that stops
   reading it; never in the same one.

These two rules together are what makes a "stop API → run migration →
start API" upgrade survivable, and what makes rolling deploys feasible
for operators who choose to do them. Neither is automatically tested
in CI today — operators verify both by following the
[Pre-upgrade checklist](#pre-upgrade-checklist) and the
[Post-upgrade sanity checklist](#post-upgrade-sanity-checklist) below.

## How migrations work

The runner lives at
[`apps/server/src/db/migrate.ts`](../apps/server/src/db/migrate.ts).
It is small enough to read in one screen — read the source if you're
unsure about an edge case. Behaviour:

- Walks `apps/server/migrations/*.sql` in lexicographic order.
- Applies each file inside its **own transaction** so a half-applied
  migration is impossible — Postgres either commits the whole `.sql`
  body or rolls it back.
- Records successful runs in `_syrotp_migrations` (file name + FNV-1a
  checksum + timestamp). On the next run, already-applied files are
  skipped by name.
- The checksum is for change-detection, not security. Editing a
  migration file after it has been applied does NOT re-run it. **Never
  edit an applied migration** — write a new file instead.

The migrations on `main` as of v1.0-rc.1:

| File | Landed in | What it adds |
| --- | --- | --- |
| `0001_init.sql` | v0.1.0 | Initial schema: apps, api_keys, receivers, verifications, inbound_sms. |
| `0002_webhooks.sql` | v0.5.0 (PR #20) | webhook_endpoints, webhook_events, webhook_deliveries. |
| `0003_receiver_snapshots.sql` | v0.5.0 (PR #22) | `receiver_msisdn_snapshot`, `receiver_operator_snapshot` columns on `verifications`. |
| `0004_webauthn.sql` | v0.5.0 (PR #23) | webauthn_credentials, webauthn_challenges. |
| `0005_phone_bindings.sql` | v0.8.0 (PR #36) | phone_bindings + partial unique index on `(app_id, phone_e164) WHERE status='verified'`. |

Every one of the above is additive — adds tables, columns, or indexes,
never removes. That's the v1.0 baseline.

## Migration ownership

**Run database migrations exactly once before any API or worker
process starts handling traffic.**

```bash
pnpm --filter @syrotp/server migrate
```

Cross-references for the reasoning, not duplicated here:

- Multi-instance topology, why neither tier auto-migrates, and the
  CI/CD shape:
  [`multi-instance-deployment.md § Migration ownership`](multi-instance-deployment.md#migration-ownership).
- Hard invariant #16 (migrations run once, before either tier starts):
  [`security-checklist.md`](security-checklist.md#hard-invariants--must-never-regress).

In short: **one tier owns the migrate step** (typically the API
tier's deploy step). Workers MUST NOT migrate. A worker booting
against a stale schema fails fast on the first query.

## Authoring migrations

Rules every new migration file must satisfy:

1. **Filename is `NNNN_<short-description>.sql`** with `NNNN`
   sequential, zero-padded, four digits. The runner sorts
   lexicographically — `0010` sorts after `0009`, but `10` would sort
   *before* `9`. Pad.
2. **Forward-only.** Add tables, add columns, add indexes, add
   constraints. Removing requires a separate later migration AND a
   server release in between that no longer reads the dropped column.
3. **Additive within `1.x`.** Old code MUST keep running against the
   post-migration schema. Practically:
   - New columns are nullable OR have a `DEFAULT`. Never `NOT NULL`
     without a default on a non-empty table.
   - New indexes are safe at any time. `CREATE INDEX CONCURRENTLY`
     is preferred for production-sized tables — but the runner's
     transaction wrapping forbids `CONCURRENTLY` (Postgres rejects it
     inside a transaction). For large-table indexes that need
     concurrent creation, split the migration: an empty file that
     just records progress, then run the `CREATE INDEX CONCURRENTLY`
     out-of-band, then a follow-up migration that asserts the index
     exists.
   - New constraints (`CHECK`, foreign keys) on existing data require
     pre-validation that every row already satisfies them; otherwise
     the migration fails on apply.
4. **Wrap any data backfill in a `WITH` / `UPDATE ... WHERE` that's
   safe to re-run.** The runner's per-file transaction guards against
   partial application, but if you ever do split a migration the
   pieces must each be idempotent.
5. **Comment the why, not the what.** Every migration committed to
   the repo carries a header explaining what user-visible behaviour
   it enables (see `0005_phone_bindings.sql` for the canonical
   shape). Reviewers shouldn't have to load the matching service file
   to understand the intent.
6. **Never edit an applied migration.** The checksum column will not
   re-run it; production drift between operators on different
   versions becomes silent. Write a new file.

## Upgrade order

The supported upgrade sequence between two consecutive SYROTP server
releases is:

```
[ pre-upgrade checklist ]
        │
        ▼
1. STOP migration ownership (block CI/CD from racing)
        │
        ▼
2. RUN  pnpm --filter @syrotp/server migrate
        │  (idempotent; safe to re-run; aborts on first error)
        │
        ▼
3. ROLL API tier  (one-by-one OR all-at-once — see Rolling deploys)
        │
        ▼
4. ROLL worker tier (any time after step 2; order vs API doesn't matter
        │  because workers don't talk to the API)
        │
        ▼
[ post-upgrade sanity checklist ]
```

Steps 3 and 4 are independent: the worker can roll before, after, or
in parallel with the API tier. Both depend on step 2.

For the single-process default mode (the v0.8 / v0.9 baseline) steps
3 and 4 collapse into one — you stop the one process, you start the
new image of the same one process. That's the topology this project
was originally written against and is the most-tested path.

## Rolling deploys

Rolling deploys (replacing API replicas one at a time without
stopping traffic) are **possible but not automatically tested**.
What makes them possible:

- Migrations are additive, so the old image runs against the new
  schema for the duration of the roll.
- The wire contract is frozen at `1.0.0` final, so a request handled
  by the old image and the same request retried against the new
  image return identically-shaped responses.
- All shared state (rate limits, webhook leases, idempotency keys)
  is multi-instance-safe per
  [`multi-instance-safety.md`](multi-instance-safety.md). Two
  versions of the API code reading and writing the same DB / Redis
  do not corrupt anything.

What the project does NOT promise about rolling deploys:

- **No CI matrix today** asserts "image vN and image vN-1 both
  serving the same DB at once produces correct outcomes." If you
  rely on rolling deploys in production, run the full integration
  suite against a build of N pointing at a DB that's been migrated
  for N+1, periodically.
- **No load-balancer drain hooks** are baked in. The Fastify process
  responds to SIGTERM by closing the HTTP server gracefully (see
  `apps/server/src/index.ts`), but the load balancer's drain semantics
  — taking the instance out of rotation, waiting for in-flight
  requests to finish — are the operator's concern.
- **No long-poll endpoint** is special-cased. The longest-running
  request shape is `POST /v1/inbound/sms` at ~5s worst case, which
  is well within most LB drain windows; if your LB drain is shorter
  than 30s, in-flight requests may be cut off.

The simpler, fully-tested upgrade shape is **stop → migrate → start**:
brief downtime (typically tens of seconds for a small deployment),
no version skew window, no surprises. Operators who can tolerate
that should prefer it.

## Rollback

There is no schema rollback. The supported rollback path is:

1. **Deploy the previous server image** to both API and worker tiers.
2. **Leave the database alone.** The previous image will read and
   write the same schema; the additive columns / tables introduced
   by the rolled-back release simply go unused.
3. **Investigate** what made the new release roll back. The next
   forward release fixes it; do not re-attempt the same image.

When a rollback is NOT recoverable this way:

- The rolled-back release introduced a **breaking, non-additive
  schema change**. By policy this should never happen inside a
  protocol MAJOR (see [Discipline summary](#discipline-summary)). If
  it did, the project considers that a v1.0 contract violation and
  the fix is a forward release that re-introduces compatibility, not
  a SQL `DOWN`.
- The rolled-back release **wrote rows the previous image cannot
  parse**. Same answer: the contract violation is shipping a write
  that the previous image cannot read. The fix is forward.

In both pathological cases the operator's emergency path is a
**point-in-time DB restore** to before the bad release, plus
deploying the previous image. Backups are therefore the foundation
of any rollback story past "redeploy old image."

## Backup & restore expectations

The project does not ship a backup tool. Postgres backups are an
operator concern. The minimum the operator MUST have in place
before a v1.0 deployment is considered production-ready:

| What | Why |
| --- | --- |
| **Daily logical backup** (`pg_dump`) of the `syrotp` database. | Recovers from a corrupted row, a dropped table, or a runaway `DELETE` without affecting the rest of the host. |
| **Continuous WAL archiving + point-in-time recovery (PITR)**, OR managed Postgres with point-in-time restore. | Recovers from a bad release that wrote unparseable rows; restores to a moment **before** the deploy. The window between checkpoints determines how much data you lose. |
| **Restore drills**, at least once per quarter. | A backup that's never restored is not a backup. |
| **Encryption at rest** for the backup destination. | The `apps`, `api_keys`, `webhook_endpoints`, and `phone_bindings` rows carry secrets that are wrapped at-rest in the DB but plain in a logical dump. |

Redis is **not** backed up. Rate-limit counters and the WebAuthn
challenge cache (live data only) are intentionally
ephemeral; losing Redis means rate-limit windows reset and any
in-flight WebAuthn ceremony has to retry. Both are recoverable
without operator intervention.

## API ↔ worker version skew

For brief windows (during an upgrade, or during a rollback), an API
instance and a worker instance may run different server image
versions. The project supports this **inside one MINOR cycle of the
server version**, e.g. an API on `v0.9.0` paired with a worker on
`v0.9.1`.

Why one MINOR is the bound:

- The `WebhookWorker` class (in `services/webhookWorker.ts`) is
  shared by the in-process timer AND the standalone worker. They run
  the same code; a MINOR bump may add fields to `webhook_deliveries`
  but won't change the queue semantics (lease, backoff schedule,
  signature scheme — all frozen by [hard invariants 9 / 14 /
  15](security-checklist.md#hard-invariants--must-never-regress)).
- The shared env contract
  ([`multi-instance-deployment.md § Required and shared environment`](multi-instance-deployment.md#required-and-shared-environment))
  is not allowed to change inside a MINOR. So a worker on `v0.9.0`
  can read rows written by an API on `v0.9.1` and vice versa.

A MAJOR-cross skew (API on `v1.0.x` with worker on `v2.0.x`) is NOT
supported. Roll all tiers across a MAJOR boundary together; do not
intermix.

The project does NOT test arbitrary skews in CI. The safe upgrade
shape (migrate → roll API → roll worker, all to the same target
version) avoids skew except for the brief rolling window.

## SDK ↔ server skew

Already covered in detail in
[`compatibility.md § Server ↔ SDK skew`](compatibility.md#server--sdk-skew)
and [`sdk-versioning.md § Version skew policy`](sdk-versioning.md#4-version-skew-policy).
The summary for operators:

- Pre-`1.0.0`: SDKs and server move at their own paces; both speak
  protocol `0.1.0` from `v0.1` through `v0.9` (see
  [`compatibility.md`](compatibility.md#protocol-versions-and-server-releases)).
- Post-`1.0.0`: any SDK on the `1.x` protocol MAJOR works against
  any server on the `1.x` protocol MAJOR. Operators do not need to
  upgrade SDKs in lockstep with the server.

## Pre-upgrade checklist

Run through this on the morning of the upgrade window. Items marked
**MUST** are non-negotiable.

- [ ] **MUST** Read the target release's `CHANGELOG.md` entry. Look
      specifically for entries under **Migrations**, **Breaking**, or
      **Operator action required**. The v1.0 commitment is no
      breaking inside `1.x`, but operator-action callouts can land
      anywhere (e.g. v0.8 phone-binding backfill).
- [ ] **MUST** Confirm a recent successful backup. Note its timestamp
      — that's your worst-case rollback target.
- [ ] **MUST** Confirm the migration tier is identified (which CI/CD
      step, on which infra). If you can't answer "who runs `pnpm
      migrate`," stop and figure that out first.
- [ ] **MUST** Confirm the four shared env vars (`DATABASE_URL`,
      `REDIS_URL`, `MASTER_ENCRYPTION_KEY`, `COOKIE_SECRET`) are
      identical across all API and worker instances. A drift here
      causes silent decryption failures after the upgrade — see
      [`multi-instance-deployment.md § Drift in MASTER_ENCRYPTION_KEY`](multi-instance-deployment.md#drift-in-master_encryption_key-between-api-and-worker).
- [ ] **MUST** If splitting an existing single-process deployment in
      the same upgrade, follow
      [`multi-instance-deployment.md § Operator checklist for promoting from single-process to split`](multi-instance-deployment.md#operator-checklist-for-promoting-from-single-process-to-split)
      first — do not combine "split topology" with "version bump" in
      one window unless you've staged it.
- [ ] **SHOULD** Have a rollback decision criterion ready before
      starting. "I will roll back if X" is a faster answer at 02:00
      than "let me think about it."
- [ ] **SHOULD** Drain non-essential traffic if practical (lower
      `RATE_LIMIT_*` to clamp; or pause whatever upstream sends bulk
      bindings). The fewer in-flight requests during the cutover,
      the smaller the surface area.

## Post-upgrade sanity checklist

Run through this within five minutes of bringing the new image up.

- [ ] **MUST** Confirm `_syrotp_migrations` lists every file in
      `apps/server/migrations/` for the target release:
      `SELECT name FROM _syrotp_migrations ORDER BY name;` matches
      `ls apps/server/migrations/*.sql`.
- [ ] **MUST** Confirm at least one happy-path verification flow
      end-to-end. Easiest: `pnpm --filter @syrotp/cli smoke` against a
      bound test phone. The smoke run hits start → inbound → match
      → status, so a regression in any of those surfaces immediately.
- [ ] **MUST** Confirm webhook deliveries are flowing. Cancel a test
      verification (`POST /v1/verifications/{id}/cancel`) and watch
      the receiver's endpoint receive the `verification.cancelled`
      event within the worker's tick interval (default 5s).
- [ ] **MUST** Tail server logs for the first 60 seconds after
      cutover. Specifically look for any `unhandled error` lines or
      rate of `validation_error` higher than baseline; either is
      cause to roll back.
- [ ] **SHOULD** Confirm Prometheus is still scraping (i.e. metrics
      cardinality didn't change). If it did, the dashboard alerts
      may stop firing. The cardinality discipline is a hard
      invariant ([`security-checklist.md` #27](security-checklist.md#hard-invariants--must-never-regress))
      so this should never be needed — but verifying is cheap.
- [ ] **SHOULD** Run the soak loadtest if the upgrade is a major
      operational change (multi-instance promotion, worker split,
      pool resizing). See
      [`operational-baseline.md`](operational-baseline.md).

## What this document does NOT cover

- **Upgrading SDKs** — see
  [`compatibility.md`](compatibility.md#per-release-operator-requirements)
  for the per-release matrix. SDKs are versioned independently from
  the server; bumping an SDK is an application team's deploy, not an
  operator upgrade.
- **Upgrading the Android gateway** — see
  [`android-gateway-keystore.md`](android-gateway-keystore.md). The
  v0.8+ gateway migrates its signing key into AndroidKeyStore on
  first launch; that's the only operator-facing event.
- **Schema design choices** — `apps/server/src/db/schema.ts` is the
  authoritative schema. Migrations under `apps/server/migrations/`
  are how that schema got there, in order. Read both side by side
  when authoring the next one.
