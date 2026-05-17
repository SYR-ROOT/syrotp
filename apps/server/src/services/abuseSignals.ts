/**
 * Abuse-signals computation — v0.8 PR #39.
 *
 * Read-only observability layer that computes per-app and
 * per-receiver health signals on a 60s refresh interval. Surfaces:
 *
 *   - Project-wide Prometheus gauges (no high-cardinality labels)
 *     for ops dashboards and alerts.
 *   - A JSON endpoint at `/admin/abuse-signals` (basic-auth gated)
 *     for per-app / per-receiver drill-down.
 *
 * **No auto-ban, no enforcement, no webhook events**. PR #39 is
 * pure observability so v0.8 PR #40 (Keystore) and any future
 * abuse-policy work can decide what to DO with the signals — the
 * data infrastructure has to land first.
 *
 * Health score (per app):
 *
 *   score = clamp(
 *     100
 *     - failed_rate * 30           // bad verifications
 *     - unmatched_rate * 40        // inbound that didn't match
 *     - binding_failure_rate * 10  // bindings that timed out
 *     , 0, 100
 *   )
 *
 * Each rate is in `[0, 1]`; a score < 70 is the rough "look at me"
 * line. Operators can tighten / loosen the line via dashboard
 * thresholds — the score itself is intentionally simple math the
 * service can compute without a feedback loop.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { metrics } from "./metrics.js";

const REFRESH_INTERVAL_MS = 60_000;
const WINDOW_INTERVAL = "1 hour";

export interface AppHealthRow {
  app_id: string;
  total_verifications: number;
  failed_verifications: number;
  failed_rate: number;
  total_inbounds: number;
  unmatched_inbounds: number;
  unmatched_rate: number;
  total_bindings: number;
  expired_bindings: number;
  binding_failure_rate: number;
  health_score: number;
}

export interface ReceiverHealthRow {
  receiver_id: string;
  app_id: string;
  total_inbounds: number;
  unmatched_inbounds: number;
  unmatched_rate: number;
}

export interface AbuseSignals {
  generated_at: string;
  window: string;
  apps: AppHealthRow[];
  receivers: ReceiverHealthRow[];
}

let timer: NodeJS.Timeout | null = null;
let stopped = false;
let cached: AbuseSignals | null = null;

export function startAbuseSignalsRefresh(): void {
  if (timer || stopped) return;
  setImmediate(() => {
    void runOnce();
  });
  timer = setInterval(() => {
    void runOnce();
  }, REFRESH_INTERVAL_MS);
  timer.unref();
}

export function stopAbuseSignalsRefresh(): void {
  stopped = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function getCachedSignals(): AbuseSignals | null {
  return cached;
}

/**
 * Compute the score from already-aggregated rates. Pure function —
 * exported so unit tests can pin the math without going through
 * the DB.
 */
export function calcHealthScore(input: {
  failed_rate: number;
  unmatched_rate: number;
  binding_failure_rate: number;
}): number {
  const raw =
    100
    - input.failed_rate * 30
    - input.unmatched_rate * 40
    - input.binding_failure_rate * 10;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

async function runOnce(): Promise<void> {
  try {
    const signals = await computeSignals();
    cached = signals;
    pushToGauges(signals);
  } catch (err) {
    // Don't crash the refresh loop on a transient DB blip.
    // eslint-disable-next-line no-console
    console.warn("[abuse-signals] refresh failed:", err);
  }
}

export async function computeSignals(): Promise<AbuseSignals> {
  // Three small aggregates joined by app_id. Each query stays under
  // 1ms at single-app MVP scale; at multi-tenant scale the indexes
  // already in place (status, expires_at, app_id) keep them cheap.

  const verifyAgg = await db.execute<{
    app_id: string;
    total: number;
    failed: number;
  }>(sql`
    SELECT app_id,
           count(*)::int AS total,
           count(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM verifications
     WHERE created_at > now() - interval '${sql.raw(WINDOW_INTERVAL)}'
     GROUP BY app_id
  `);

  const inboundAgg = await db.execute<{
    app_id: string;
    receiver_id: string;
    total: number;
    unmatched: number;
  }>(sql`
    SELECT r.app_id,
           i.receiver_id,
           count(*)::int AS total,
           count(*) FILTER (WHERE i.matched_verification_id IS NULL)::int AS unmatched
      FROM inbound_sms i
      JOIN receivers r ON r.id = i.receiver_id
     WHERE i.received_at > now() - interval '${sql.raw(WINDOW_INTERVAL)}'
     GROUP BY r.app_id, i.receiver_id
  `);

  const bindingAgg = await db.execute<{
    app_id: string;
    total: number;
    expired: number;
  }>(sql`
    SELECT app_id,
           count(*)::int AS total,
           count(*) FILTER (
             WHERE status = 'pending' AND expires_at < now()
           )::int AS expired
      FROM phone_bindings
     WHERE created_at > now() - interval '${sql.raw(WINDOW_INTERVAL)}'
     GROUP BY app_id
  `);

  // Merge into per-app rows. Apps that show up in any of the three
  // aggregates appear in the result.
  const apps = new Map<string, AppHealthRow>();
  const ensure = (appId: string): AppHealthRow => {
    let row = apps.get(appId);
    if (!row) {
      row = {
        app_id: appId,
        total_verifications: 0,
        failed_verifications: 0,
        failed_rate: 0,
        total_inbounds: 0,
        unmatched_inbounds: 0,
        unmatched_rate: 0,
        total_bindings: 0,
        expired_bindings: 0,
        binding_failure_rate: 0,
        health_score: 100,
      };
      apps.set(appId, row);
    }
    return row;
  };

  for (const v of verifyAgg) {
    const r = ensure(v.app_id);
    r.total_verifications = v.total;
    r.failed_verifications = v.failed;
    r.failed_rate = v.total > 0 ? v.failed / v.total : 0;
  }

  // Roll inbound aggregates from per-receiver up to per-app.
  const receivers: ReceiverHealthRow[] = [];
  for (const i of inboundAgg) {
    const r = ensure(i.app_id);
    r.total_inbounds += i.total;
    r.unmatched_inbounds += i.unmatched;
    receivers.push({
      receiver_id: i.receiver_id,
      app_id: i.app_id,
      total_inbounds: i.total,
      unmatched_inbounds: i.unmatched,
      unmatched_rate: i.total > 0 ? i.unmatched / i.total : 0,
    });
  }
  for (const r of apps.values()) {
    r.unmatched_rate = r.total_inbounds > 0 ? r.unmatched_inbounds / r.total_inbounds : 0;
  }

  for (const b of bindingAgg) {
    const r = ensure(b.app_id);
    r.total_bindings = b.total;
    r.expired_bindings = b.expired;
    r.binding_failure_rate = b.total > 0 ? b.expired / b.total : 0;
  }

  // Compute health scores last so all three rates are populated.
  for (const r of apps.values()) {
    r.health_score = calcHealthScore({
      failed_rate: r.failed_rate,
      unmatched_rate: r.unmatched_rate,
      binding_failure_rate: r.binding_failure_rate,
    });
  }

  return {
    generated_at: new Date().toISOString(),
    window: WINDOW_INTERVAL,
    apps: [...apps.values()].sort((a, b) => a.app_id.localeCompare(b.app_id)),
    receivers: receivers.sort((a, b) => a.receiver_id.localeCompare(b.receiver_id)),
  };
}

function pushToGauges(signals: AbuseSignals): void {
  // Project-wide rollups — intentionally NO high-cardinality
  // labels (no app_id, no receiver_id) to respect the project's
  // metrics discipline. Per-app / per-receiver detail goes through
  // the JSON endpoint instead.
  let totalVerifications = 0;
  let totalFailed = 0;
  let totalInbounds = 0;
  let totalUnmatched = 0;
  let totalBindings = 0;
  let totalExpired = 0;
  let minScore = 100;

  for (const a of signals.apps) {
    totalVerifications += a.total_verifications;
    totalFailed += a.failed_verifications;
    totalInbounds += a.total_inbounds;
    totalUnmatched += a.unmatched_inbounds;
    totalBindings += a.total_bindings;
    totalExpired += a.expired_bindings;
    if (a.health_score < minScore) minScore = a.health_score;
  }

  const failedRate = totalVerifications > 0 ? totalFailed / totalVerifications : 0;
  const unmatchedRate = totalInbounds > 0 ? totalUnmatched / totalInbounds : 0;
  const bindingFailureRate = totalBindings > 0 ? totalExpired / totalBindings : 0;

  metrics.setAbuseSignals({
    failed_verification_rate: failedRate,
    unmatched_inbound_rate: unmatchedRate,
    binding_failure_rate: bindingFailureRate,
    min_app_health_score: signals.apps.length > 0 ? minScore : 100,
  });
}
