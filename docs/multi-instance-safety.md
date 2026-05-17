# Multi-Instance Safety — Audit & Guarantees

This document is the audit artifact produced by **v0.9 PR #42 —
Multi-instance safety audit + targeted fix**. It records, for every
operation that mutates shared state, the concurrency model the SYROTP
server relies on and the verdict we drew when reviewing it for
"can N concurrent processes against the same Postgres + Redis violate
an invariant?"

The motivation: v0.9 PR #41 split the webhook delivery worker into its
own process. From v0.9 onward, an SYROTP deployment can run **N API
servers + M webhook worker processes** against one Postgres + one
Redis. The audit below proves what that's safe to do today, fixes the
one place it wasn't, and lists the two minor items deferred to follow-
up PRs.

The single-process MVP (the v0.8 default) is unaffected — every
guarantee below already held there. The reason this audit had to
happen now is that **JavaScript's await-yields-the-event-loop semantics
already produce the same race window inside a single Node process** as
two separate processes do. A safe-against-multi-instance code path is
also safe against itself.

## Audit verdicts

| # | Operation | Critical code | Concurrency model | Verdict |
| --- | --- | --- | --- | --- |
| 1 | Verification creation | [`services/verifications.ts:185-258`](../apps/server/src/services/verifications.ts#L185-L258) | `db.transaction` + `pg_advisory_xact_lock(hashtextextended(app_id\|\|':'\|\|phone, 0))` + count + insert | **SAFE** (was GAP — fixed in PR #42) |
| 2 | Inbound matching | [`services/matching.ts:74-196`](../apps/server/src/services/matching.ts#L74-L196) | DB unique constraint on `(receiver_id, idempotency_key)` + atomic `UPDATE ... WHERE status='pending'` | **SAFE** |
| 3 | Phone-binding consume | [`services/phoneBindings.ts:238-250`](../apps/server/src/services/phoneBindings.ts#L238-L250) | Atomic conditional `UPDATE ... WHERE nonce=? AND status='pending' AND ...` + partial unique index `WHERE status='verified'` | **SAFE** |
| 4 | Webhook delivery leasing | [`services/webhookWorker.ts:166-203`](../apps/server/src/services/webhookWorker.ts#L166-L203) | `SELECT ... FOR UPDATE SKIP LOCKED` + 60-second `next_attempt_at` lease committed before the HTTP call | **SAFE** |
| 5 | Idempotency keys (inbound) | [`db/schema.ts:137`](../apps/server/src/db/schema.ts#L137) + [`services/matching.ts:74-105`](../apps/server/src/services/matching.ts#L74-L105) | Unique constraint `inbound_sms_idem_uq (receiver_id, idempotency_key)` + catch-and-`SELECT` returns the original outcome | **SAFE** |
| 6 | Rate-limit buckets (per-IP, per-receiver, per-app) | [`services/rateLimit.ts:24-27`](../apps/server/src/services/rateLimit.ts#L24-L27) | Redis pipeline of `INCR` (atomic) + `EXPIRE NX` (idempotent window setup) | **SAFE** |

## What changed in PR #42

Only path #1 needed code. The fix is small:

```diff
- const pendingForPhone = await db.select({ count: ... }) ... ;
- if (phonePending >= MAX) throw conflict("too_many_pending", ...);
- const receiver = await pickReceiver(...);
- await db.insert(schema.verifications).values({ ... });
+ await db.transaction(async (tx) => {
+   await tx.execute(sql`
+     SELECT pg_advisory_xact_lock(hashtextextended(${appId + ':' + phoneE164}, 0))
+   `);
+   const pendingForPhone = await tx.select({ count: ... }) ... ;
+   if (phonePending >= MAX) throw conflict("too_many_pending", ...);
+   const receiver = await pickReceiver(tx, ...);
+   await tx.insert(schema.verifications).values({ ... });
+ });
```

Why this specific shape:

- **`pg_advisory_xact_lock`** is a Postgres-native primitive that
  takes a single 64-bit key and releases automatically when the
  transaction ends. No schema change, no Redis dependency, no lock
  table, no trigger.
- **Per-`(app_id, phone_e164)` granularity** — different phones don't
  contend; the same phone serializes. The hash key uses
  `hashtextextended('<app>:<phone>', 0)` so collisions are
  cryptographically improbable at any realistic key cardinality.
- **Receiver pick stays inside the lock** — the pick is read-only, so
  it doesn't extend the lock window meaningfully, and keeping it
  inside means a request that's about to be rejected with `409
  too_many_pending` doesn't waste a `metrics.receiverSelected`
  increment.
- **Lock key uses normalized E.164** — the input is normalized via
  `normalizePhone(...)` before this point in the pipeline (it's the
  same `phone_e164` field stored in the row), so two callers with
  `0991234567` vs `+963991234567` for the same phone hit the same
  lock.

## How we know it works

Regression test [`test/suites/concurrency.ts` T12](../apps/server/test/suites/concurrency.ts):

1. Launch `MAX_PENDING_PER_PHONE + 5` concurrent `startVerification`
   calls for the same phone via `Promise.all`.
2. Assert exactly `MAX_PENDING_PER_PHONE` succeed with `201`.
3. Assert the rest get `409 too_many_pending`.
4. **Query the DB directly** and assert the pending row count for that
   phone equals `MAX_PENDING_PER_PHONE` exactly — not `≤`.

The DB-state assertion is the load-bearing one. A "no 500" check would
pass on a buggy version that successfully inserts too many rows.
T12 fails any code path where the post-condition `count(*) ≤ MAX` is
ever violated, regardless of timing.

## Known limitations / follow-ups (NOT in #42)

These are not multi-instance races — they're separate items that
surfaced during the audit. Recording them here so a future operator /
contributor can pick them up cleanly.

### Limitation 1: `MAX_PENDING_PER_IP` is defined but never enforced

[`config.ts:21`](../apps/server/src/config.ts#L21) defines
`MAX_PENDING_PER_IP` (default 10), but no service code actually
queries against it. This is a missing-feature bug, not a multi-
instance race. The existing per-IP rate limit (`RATE_LIMIT_START_PER_IP_PER_MIN`,
default 10) covers most of the same ground at a finer granularity.

**Why we left it for a follow-up**: PR #42 is an audit + targeted fix.
Wiring up a previously-unenforced cap is feature work; if we did it
here we'd also have to decide whether to add the same per-IP race
protection (advisory lock or otherwise), and the discussion isn't
about multi-instance safety at that point.

### Limitation 2: `startBinding` allows two concurrent `pending` rows for the same `(app, phone)`

[`services/phoneBindings.ts:84-146`](../apps/server/src/services/phoneBindings.ts#L84-L146)
checks for an existing `verified` row, then inserts a `pending` row.
Two concurrent calls can both pass the check and both insert
`pending` rows for the same `(app, phone)` — each with its own
nonce. The hard invariant ("at most one verified binding per
`(app, phone)`") is still enforced by the partial unique index
`phone_bindings_active_uq WHERE status='verified'`; the second
ceremony's `verify` step will hit that index and surface as a 500.

**Why we left it for a follow-up**: it's an edge UX issue (developer
racing themselves with two concurrent ceremony starts), not a
multi-instance correctness issue. The DB invariant holds; the user-
visible failure mode is "second concurrent ceremony fails with a
500 instead of a graceful `409 already_bound`." That's a UX PR, not
an audit PR.

## Operating an N-API + M-worker deployment

With PR #42 landed, you can run:

- **Any number of API server instances** (each with the in-process
  webhook worker disabled per [`docs/webhook-worker.md`](webhook-worker.md)).
- **One or more standalone webhook worker processes**, all sharing
  the same Postgres and Redis.

…without coordinating between them. The DB primitives and the
advisory lock above carry every shared invariant. There is **no
leader election**, **no consensus**, **no Zookeeper / etcd / Consul
dependency** — and we deliberately want to keep it that way as long
as the data layer can shoulder the load.

If the workload pattern eventually outgrows what Postgres advisory
locks + `SKIP LOCKED` can provide cheaply, the natural next step is
to introduce a sharding strategy (per-app shards, or per-receiver
shards) rather than to add a coordination service. That's well past
v0.9 scope and not something this audit tries to anticipate.

## Related

- [`docs/webhook-worker.md`](webhook-worker.md) — the standalone
  worker process introduced in v0.9 PR #41.
- [`docs/operations.md`](operations.md) — operator runbook.
- [`docs/protocol.md`](protocol.md) — the wire contract this audit
  preserves end-to-end.
