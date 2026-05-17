# Receiver Fleet Operations

This is the operator runbook for managing the receivers (gateways)
attached to an SYROTP app — listing them, adding new ones, taking one
out of rotation for maintenance, bringing it back, and rotating its
signing key. It assumes you've already read
[`docs/operations.md`](operations.md) and at least skimmed
[`docs/multi-instance-deployment.md`](multi-instance-deployment.md).

The lifecycle CLI surface lives at `syrotp receiver <subcommand>` and
is wired to the same admin module the production server uses — there
is no parallel "fleet management" implementation to drift out of
sync.

## Why "fleet" matters at all

In single-receiver deployments (one Android phone, one SIM, one
`receivers` row), this whole document is academic — the receiver
either works or it doesn't, and you re-pair when it doesn't.

In multi-receiver deployments, you're managing a set of physical
gateways with independent failure modes:

- A SIM running out of credit.
- A modem flapping on USB.
- A phone whose battery died over the weekend.
- A gateway you're swapping for a newer one and want to take out of
  rotation cleanly.

The selection path
([`services/verifications.ts:138-156`](../apps/server/src/services/verifications.ts#L138-L156))
already handles the first three automatically: receivers without a
recent heartbeat fall out of selection. The fourth — deliberate
disable for maintenance — is the operator's lever, and it's what
`receiver disable` / `receiver enable` are for.

## The five lifecycle states

A receiver is in exactly one state at any moment, computed from two
columns:

| State | `enabled` | `last_heartbeat_at` | Selected for new verifications? | Accepts inbound SMS? |
| --- | --- | --- | --- | --- |
| **Healthy** | true | within `RECEIVER_HEARTBEAT_TIMEOUT_SECONDS` (default 120s) | yes | yes |
| **Stale** | true | older than the timeout, or NULL | no | yes (heartbeat-aging is selection-only) |
| **Disabled** | false | (any) | no | **no** — HMAC verify rejects with 401 unauthorized |
| **Disabled + stale** | false | older than the timeout | no | no |
| **Removed** | (row deleted) | (row deleted) | no | no — HMAC verify reports `unknown_receiver` |

"Disabled" rejects inbound at the wire. That's the one state where
the gateway operator gets immediate signal that something's
intentional rather than transient.

Heartbeat aging is **selection-only**. A stale receiver still
accepts inbound SMS the gateway might be holding from before its
last heartbeat — that's deliberate so a momentarily-stale gateway
doesn't drop already-queued messages.

## Listing the fleet

```bash
syrotp receiver list                       # everything, all apps
syrotp receiver list --app-id app_01H...   # filter by app
syrotp receiver list --json                # stable JSON for scripts
```

The default table output shows id, msisdn, operator, enabled,
heartbeat freshness, and creation time. The JSON form is suitable
for piping into `jq` or a monitoring sidecar.

## Adding a new receiver

When you provision a new gateway phone or modem:

```bash
syrotp receiver add \
  --app-id   app_01H... \
  --name     "warehouse-modem-2" \
  --msisdn   "+963991112233" \
  --operator "syriatel"
```

The signing key is printed **once** to stdout. Save it
(`/etc/syrotp-gateway/config.toml` for the Linux GSM gateway, or the
Android gateway's pairing screen for the Android gateway). It is
never recoverable from the database — only the AEAD-wrapped
ciphertext is stored.

`--operator` is optional; pass it when you want operator-aware
routing to be able to reach this receiver via the operator hint on
`POST /v1/verifications`.

## Disabling a receiver (maintenance window)

```bash
syrotp receiver disable rcv_01H...
# or
syrotp receiver disable --id rcv_01H...
```

What flips:

- `receivers.enabled` → `false`. The selection path stops picking
  this receiver immediately.
- The HMAC verify path
  ([`services/hmac.ts:66`](../apps/server/src/services/hmac.ts#L66))
  treats the row as `unknown_receiver` and the inbound route returns
  `401 unauthorized` with no per-row distinction surfaced to the
  caller.

What does NOT flip:

- `last_heartbeat_at` is untouched.
- The signing key is untouched (so re-enable doesn't require
  re-pairing).
- Any in-flight verifications already routed to this receiver stay
  alive. The hosted page still renders normally; the user can still
  send the SMS — but the gateway can no longer deliver it back to
  the server until you re-enable. **Communicate the maintenance
  window to anyone watching live verifications**, or schedule it
  during a low-traffic period.

The disable is **idempotent**: a second disable on the same receiver
exits 0 and prints `· rcv_... was already disabled (msisdn)`.

## Re-enabling a receiver

```bash
syrotp receiver enable rcv_01H...
# or
syrotp receiver enable --id rcv_01H...
```

Symmetric to disable: flips `enabled` back to `true`. The receiver
returns to the selection pool **only if** its `last_heartbeat_at`
is fresh. If the gateway has been physically off during
maintenance, you'll need to bring it back online and let it post a
heartbeat (`HeartbeatWorker` on Android fires every 15 minutes; the
Linux gateway is configurable per `apps/gsm-gateway/config.toml`).

There is no "force healthy" mode by design — a receiver that won't
heartbeat is a receiver that won't actually deliver inbound SMS,
and forcing it into selection only delays the symptom.

The enable is **idempotent** in the same way: enabling an
already-enabled receiver exits 0 with a no-op note.

## Rotating a receiver's signing key

There's no in-place rotation endpoint in v0.9 — by design (the
audit in
[`docs/multi-instance-safety.md`](multi-instance-safety.md) has the
reasoning). Rotation is "mint a new receiver, re-pair the gateway,
delete the old row":

1. **Mint a fresh receiver row** for the same MSISDN:

   ```bash
   syrotp receiver add \
     --app-id   app_01H... \
     --name     "warehouse-modem-2-rotated" \
     --msisdn   "+963991112233"
   ```

   This prints a new `receiver_id` and signing key.

2. **Disable the old row** so it can't be the next pick mid-
   rotation:

   ```bash
   syrotp receiver disable rcv_OLD_ID
   ```

3. **Re-pair the gateway** against the new `receiver_id` + signing
   key. For the Android gateway, that's Unpair → re-enter values.
   For the Linux gateway, edit `/etc/syrotp-gateway/config.toml` and
   restart the systemd unit.

4. **(Optional) Delete the old row** in SQL once you're confident
   the new receiver is healthy:

   ```sql
   DELETE FROM receivers WHERE id = 'rcv_OLD_ID';
   ```

   Only do this **after** re-pair has been confirmed working — a
   premature delete strands any verifications still routed to the
   old row.

A future PR can add a proper `syrotp receiver rotate` command that
sequences these steps; v0.9 keeps the ceremony manual.

## Stale vs disabled — troubleshooting

If a verification is rejected with `503 no_receiver`, the cause is
always one of:

| Symptom | Likely cause | Check |
| --- | --- | --- |
| Selection finds no healthy receiver | All receivers are stale or disabled | `syrotp receiver list` — look at the heartbeat column |
| One specific receiver isn't being picked | Stale or disabled | Same as above; look at the row's `enabled` and `last_heartbeat_at` |
| Inbound SMS is rejected with 401 unauthorized | The receiver is disabled (or the row no longer exists) | `syrotp receiver list` and check `enabled`. If the row exists and `enabled=true`, the gateway is signing with a wrong/old key — re-pair |
| Inbound is accepted (202) but never matches | The gateway is healthy but the bound phone doesn't match a pending verification | `docs/monitoring.md § abuse signals` — look at `unmatched_inbound_rate` |

The two columns to query directly when CLI output isn't enough:

```sql
SELECT id, msisdn, enabled,
       last_heartbeat_at,
       now() - last_heartbeat_at AS staleness
  FROM receivers
 WHERE app_id = 'app_01H...'
 ORDER BY enabled DESC, last_heartbeat_at DESC NULLS LAST;
```

`staleness` should be smaller than your
`RECEIVER_HEARTBEAT_TIMEOUT_SECONDS` config (default 120s) for any
receiver expected to be picked.

## Removing a receiver permanently

There is no `syrotp receiver delete` subcommand in v0.9 — by design,
to make the action explicit. To permanently remove a receiver:

1. Disable it via `syrotp receiver disable rcv_XX`.
2. Run the SQL `DELETE FROM receivers WHERE id = 'rcv_XX';` against
   your production DB during a maintenance window.
3. Re-pair any apps that referenced this receiver via a fresh
   `receiver add` + gateway re-pair (see Rotation above).

Why the manual SQL: a deleted `receivers` row cascades to
`verifications.receiver_id` (NULL on delete) and orphans any
in-flight verifications. The CLI deliberately doesn't paper over
that with an automatic flow — operators should know what they're
breaking.

## Tests pinning this contract

- [`test/suites/receiverFleet.ts § RF1`](../apps/server/test/suites/receiverFleet.ts) —
  HMAC verify rejects inbound from a disabled receiver as `401
  unauthorized`.
- [`test/suites/receiverFleet.ts § RF2`](../apps/server/test/suites/receiverFleet.ts) —
  disable → enable round-trip restores the receiver to the
  selection pool. Idempotency of both `disableReceiver` and
  `enableReceiver` is asserted.
- [`test/suites/multiReceiver.ts § MR2`](../apps/server/test/suites/multiReceiver.ts) —
  stale receiver excluded from selection.
- [`test/suites/multiReceiver.ts § MR3`](../apps/server/test/suites/multiReceiver.ts) —
  disabled receiver excluded from selection.

## Out of scope (explicitly NOT v0.9)

- **Auto-balancing** between receivers beyond the existing "pick
  the receiver with the lowest pending count" tie-breaker.
- **Per-operator routing** beyond the existing
  `operator: "syriatel" | "mtn" | ...` hint on `POST
  /v1/verifications`.
- **In-place rotation endpoint** — mint-new-then-delete-old is the
  v0.9 path; a proper rotation command can land in a future PR.
- **Auto-delete of stale receivers** — the only `enabled=false`
  receivers operators should encounter are the ones they put there;
  auto-delete would mask underlying gateway failures.
- **Audit columns** (`disabled_at`, `enabled_at`, `disabled_by`) —
  if and when an operator audit log becomes a requirement, it
  belongs in its own table, not bolted onto `receivers`.
- **Dual-SIM detection / multi-SIM device support** — the protocol
  treats each SIM as its own receiver row; physical multi-SIM is a
  gateway-side concern.

## Related

- [`docs/operations.md`](operations.md) — operator runbook for the
  baseline single-process deployment.
- [`docs/multi-instance-deployment.md`](multi-instance-deployment.md) —
  what changes when you scale to N API + M worker processes.
- [`docs/multi-instance-safety.md`](multi-instance-safety.md) — the
  audit artifact for shared-state operations.
- [`docs/android-gateway-keystore.md`](android-gateway-keystore.md) —
  the Android gateway's signing-key storage model.
- [`docs/gsm-gateway.md`](gsm-gateway.md) — the Linux GSM modem
  gateway equivalent.
- [`docs/monitoring.md`](monitoring.md) — Prometheus metrics
  catalog and recommended alerts.
