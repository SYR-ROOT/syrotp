/**
 * Read-only queries that back the admin dashboard pages.
 *
 * Everything is bounded — no unbounded SELECTs without LIMIT, no
 * cross-app joins that would balloon for large fleets. Pagination is
 * deferred to a later PR (current limit: latest 100 per table page).
 *
 * No write paths. The dashboard is intentionally read-only in v0.3 PR 2.
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "../../db/index.js";
import { config } from "../../config.js";
import { Redis } from "ioredis";

const PAGE_LIMIT = 100;

// ----- dashboard overview ------------------------------------------

export interface DashboardOverview {
  receiverCounts: { total: number; enabled: number; healthy: number };
  pendingVerifications: number;
  verifiedLast24h: number;
  inboundLast24h: number;
  unmatchedLast24h: number;
}

export async function fetchOverview(now: Date = new Date()): Promise<DashboardOverview> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const fresh = config.RECEIVER_HEARTBEAT_TIMEOUT_SECONDS;

  // Receivers: one query, three counts.
  const recRows = await db.execute<{
    total: number;
    enabled: number;
    healthy: number;
  }>(sql`
    SELECT
      COUNT(*)::int                                                        AS total,
      COUNT(*) FILTER (WHERE enabled)::int                                  AS enabled,
      COUNT(*) FILTER (
        WHERE enabled
          AND last_heartbeat_at IS NOT NULL
          AND last_heartbeat_at > now() - (${fresh} || ' seconds')::interval
      )::int                                                                AS healthy
    FROM receivers
  `);
  const recRow = (recRows as unknown as Array<{ total: number; enabled: number; healthy: number }>)[0];

  const pendingRows = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count FROM verifications WHERE status = 'pending'
  `);
  const pending = (pendingRows as unknown as Array<{ count: number }>)[0];

  const verifiedRows = await db.execute<{ count: number }>(sql`
    SELECT COUNT(*)::int AS count
    FROM verifications
    WHERE status = 'verified' AND verified_at >= ${since.toISOString()}::timestamptz
  `);
  const verified = (verifiedRows as unknown as Array<{ count: number }>)[0];

  const inRows = await db.execute<{ total: number; matched: number }>(sql`
    SELECT
      COUNT(*)::int                                          AS total,
      COUNT(*) FILTER (WHERE matched_verification_id IS NOT NULL)::int AS matched
    FROM inbound_sms
    WHERE received_at >= ${since.toISOString()}::timestamptz
  `);
  const inb = (inRows as unknown as Array<{ total: number; matched: number }>)[0];

  return {
    receiverCounts: {
      total: recRow?.total ?? 0,
      enabled: recRow?.enabled ?? 0,
      healthy: recRow?.healthy ?? 0,
    },
    pendingVerifications: pending?.count ?? 0,
    verifiedLast24h: verified?.count ?? 0,
    inboundLast24h: inb?.total ?? 0,
    unmatchedLast24h: (inb?.total ?? 0) - (inb?.matched ?? 0),
  };
}

// ----- receivers list ----------------------------------------------

export interface AdminReceiverRow {
  id: string;
  appId: string;
  appName: string;
  name: string;
  operator: string | null;
  msisdn: string;
  enabled: boolean;
  lastHeartbeatAt: Date | null;
  createdAt: Date;
  /** Computed: enabled AND heartbeat within window. */
  healthy: boolean;
}

export async function fetchReceivers(): Promise<AdminReceiverRow[]> {
  const rows = await db
    .select({
      id: schema.receivers.id,
      appId: schema.receivers.appId,
      appName: schema.apps.name,
      name: schema.receivers.name,
      operator: schema.receivers.operator,
      msisdn: schema.receivers.msisdn,
      enabled: schema.receivers.enabled,
      lastHeartbeatAt: schema.receivers.lastHeartbeatAt,
      createdAt: schema.receivers.createdAt,
    })
    .from(schema.receivers)
    .innerJoin(schema.apps, eq(schema.receivers.appId, schema.apps.id))
    .orderBy(desc(schema.receivers.createdAt))
    .limit(PAGE_LIMIT);

  const fresh = config.RECEIVER_HEARTBEAT_TIMEOUT_SECONDS * 1000;
  const now = Date.now();
  return rows.map((r) => ({
    ...r,
    healthy:
      r.enabled &&
      r.lastHeartbeatAt !== null &&
      now - r.lastHeartbeatAt.getTime() <= fresh,
  }));
}

// ----- verifications list ------------------------------------------

export interface AdminVerificationRow {
  id: string;
  appId: string;
  phoneE164: string;
  purpose: string;
  status: "pending" | "verified" | "expired" | "cancelled" | "failed";
  createdAt: Date;
  expiresAt: Date;
  verifiedAt: Date | null;
}

export async function fetchVerifications(): Promise<AdminVerificationRow[]> {
  const rows = await db
    .select({
      id: schema.verifications.id,
      appId: schema.verifications.appId,
      phoneE164: schema.verifications.phoneE164,
      purpose: schema.verifications.purpose,
      status: schema.verifications.status,
      createdAt: schema.verifications.createdAt,
      expiresAt: schema.verifications.expiresAt,
      verifiedAt: schema.verifications.verifiedAt,
    })
    .from(schema.verifications)
    .orderBy(desc(schema.verifications.createdAt))
    .limit(PAGE_LIMIT);
  return rows;
}

// ----- inbound SMS list --------------------------------------------

export interface AdminInboundRow {
  id: string;
  receiverId: string;
  fromE164: string;
  body: string;
  receivedAt: Date;
  matchedVerificationId: string | null;
}

export async function fetchInbound(): Promise<AdminInboundRow[]> {
  const rows = await db
    .select({
      id: schema.inboundSms.id,
      receiverId: schema.inboundSms.receiverId,
      fromE164: schema.inboundSms.fromE164,
      body: schema.inboundSms.body,
      receivedAt: schema.inboundSms.receivedAt,
      matchedVerificationId: schema.inboundSms.matchedVerificationId,
    })
    .from(schema.inboundSms)
    .orderBy(desc(schema.inboundSms.receivedAt))
    .limit(PAGE_LIMIT);
  return rows;
}

// ----- health page -------------------------------------------------

export interface AdminHealth {
  serverVersion: string;
  dbOk: boolean;
  dbLatencyMs: number | null;
  redisOk: boolean;
  redisLatencyMs: number | null;
  receivers: { healthy: number; stale: number; disabled: number };
}

export async function fetchHealth(): Promise<AdminHealth> {
  const out: AdminHealth = {
    serverVersion: process.env.npm_package_version ?? "0.1.0",
    dbOk: false,
    dbLatencyMs: null,
    redisOk: false,
    redisLatencyMs: null,
    receivers: { healthy: 0, stale: 0, disabled: 0 },
  };

  // DB ping.
  const t0 = performance.now();
  try {
    await db.execute(sql`SELECT 1`);
    out.dbOk = true;
    out.dbLatencyMs = round(performance.now() - t0);
  } catch {
    out.dbLatencyMs = round(performance.now() - t0);
  }

  // Redis ping (own connection — the app's redis is busy with rate
  // limits and replay guards; we don't want to interfere).
  const t1 = performance.now();
  const r = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await r.connect();
    const pong = await r.ping();
    out.redisOk = pong === "PONG";
    out.redisLatencyMs = round(performance.now() - t1);
  } catch {
    out.redisLatencyMs = round(performance.now() - t1);
  } finally {
    await r.quit().catch(() => {});
  }

  // Receiver state breakdown — shares logic with the metrics gauge.
  const fresh = config.RECEIVER_HEARTBEAT_TIMEOUT_SECONDS;
  const recRows = await db.execute<{ healthy: number; stale: number; disabled: number }>(sql`
    SELECT
      COUNT(*) FILTER (
        WHERE enabled
          AND last_heartbeat_at IS NOT NULL
          AND last_heartbeat_at > now() - (${fresh} || ' seconds')::interval
      )::int AS healthy,
      COUNT(*) FILTER (
        WHERE enabled
          AND (last_heartbeat_at IS NULL
            OR last_heartbeat_at <= now() - (${fresh} || ' seconds')::interval)
      )::int AS stale,
      COUNT(*) FILTER (WHERE NOT enabled)::int AS disabled
    FROM receivers
  `);
  const counts = (recRows as unknown as Array<{ healthy: number; stale: number; disabled: number }>)[0];
  if (counts) {
    out.receivers = {
      healthy: counts.healthy,
      stale: counts.stale,
      disabled: counts.disabled,
    };
  }

  return out;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
