/**
 * Refresh receiver-related Prometheus gauges on a fixed interval.
 *
 * We can't push these on every heartbeat / receiver-add / receiver-disable
 * because a Prometheus gauge needs to know about EVERY receiver, including
 * the ones that haven't moved since boot. A periodic SELECT is simpler,
 * its query plan is identical to pickReceiver's predicates (so no new
 * indexes), and at expected fleet sizes (1-100 receivers) it's free.
 *
 * Lifecycle:
 *   - First refresh runs immediately on app boot.
 *   - Subsequent refreshes every REFRESH_INTERVAL_MS.
 *   - timer.unref() so the loop never blocks process shutdown.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { config } from "../config.js";
import { metrics } from "./metrics.js";

const REFRESH_INTERVAL_MS = 30_000;

interface ReceiverRow extends Record<string, unknown> {
  id: string;
  enabled: boolean;
  last_heartbeat_at: Date | null;
}

let timer: NodeJS.Timeout | null = null;
let stopped = false;

export function startReceiverGaugesRefresh(): void {
  if (timer || stopped) return;
  // Kick off the first refresh on next tick so app.ts boot finishes
  // before we touch the DB.
  setImmediate(() => {
    void runOnce();
  });
  timer = setInterval(() => {
    void runOnce();
  }, REFRESH_INTERVAL_MS);
  timer.unref();
}

export function stopReceiverGaugesRefresh(): void {
  stopped = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function runOnce(): Promise<void> {
  try {
    const rows = (await db.execute<ReceiverRow>(sql`
      SELECT id, enabled, last_heartbeat_at
      FROM receivers
    `)) as unknown as ReceiverRow[];

    const fresh = config.RECEIVER_HEARTBEAT_TIMEOUT_SECONDS * 1000;
    const now = Date.now();

    let enabled = 0;
    let disabled = 0;
    let healthy = 0;
    const ages: Array<{ receiverId: string; ageSeconds: number }> = [];

    for (const r of rows) {
      if (r.enabled) enabled++;
      else disabled++;

      const ts = r.last_heartbeat_at ? new Date(r.last_heartbeat_at).getTime() : null;
      if (
        r.enabled &&
        ts !== null &&
        now - ts <= fresh
      ) {
        healthy++;
      }
      // Always emit per-receiver age (even disabled) so dashboards can
      // distinguish "disabled" from "no recent heartbeat". A receiver
      // with no heartbeat at all gets a sentinel large value.
      ages.push({
        receiverId: r.id,
        ageSeconds: ts === null ? 365 * 24 * 3600 : Math.max(0, Math.floor((now - ts) / 1000)),
      });
    }

    metrics.setReceiverGauges({
      enabledTotal: enabled,
      disabledTotal: disabled,
      healthyTotal: healthy,
      perReceiverHeartbeatAge: ages,
    });
  } catch (err) {
    // Don't crash the process on a transient DB blip — gauges go stale
    // for one interval, the next tick recovers. Log so it's visible.
    console.error(
      "[metrics] receiver-gauges refresh failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
