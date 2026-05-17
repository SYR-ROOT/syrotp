/**
 * Receiver CRUD. Same wrap/unwrap semantics as the production server
 * uses — see services/hmac.ts. The CLI is a thin formatter on top of
 * these functions; the source of truth stays here inside the server
 * package.
 *
 * NOTE: testReceiver is intentionally in admin/probe.ts (separate
 * module path) so the CLI can run `syrotp receiver test` without
 * pulling in services/hmac.ts → lib/redis.ts (which opens an eager
 * Redis connection at import time).
 */
import { and, desc, eq } from "drizzle-orm";
import { config } from "../config.js";
import { db, schema } from "../db/index.js";
import { generateNonce } from "../lib/crypto.js";
import { newId, RECEIVER_PREFIX } from "../lib/ids.js";
import { normalizePhone, PhoneError } from "../lib/phone.js";
import { wrapGatewaySigningKey } from "../services/hmac.js";

// ----- add receiver --------------------------------------------------

export interface AddReceiverOptions {
  appId: string;
  name: string;
  /** Free-form, e.g. "syriatel", "mtn". Stored as-is. */
  operator?: string;
  /** Phone number (E.164 or local — normalized internally). */
  msisdn: string;
  /**
   * Set last_heartbeat_at = now() at insert time. Useful for testing
   * (smoke flows, integration runs) where a real gateway hasn't paired.
   * Default: false — production receivers earn "healthy" status only by
   * sending a real heartbeat.
   */
  simulateHeartbeat?: boolean;
}

export interface AddReceiverResult {
  receiverId: string;
  msisdn: string;
  signingKey: string;
  appId: string;
  appName: string;
  operator: string | null;
  name: string;
}

export async function addReceiver(opts: AddReceiverOptions): Promise<AddReceiverResult> {
  if (!/^app_[A-Za-z0-9]+$/.test(opts.appId)) {
    throw new AdminError("invalid_app_id", `appId must look like 'app_<ulid>'; got: ${opts.appId}`);
  }
  if (typeof opts.name !== "string" || opts.name.trim().length === 0) {
    throw new AdminError("invalid_name", "receiver name is required");
  }
  let phone;
  try {
    phone = normalizePhone(opts.msisdn, config.DEFAULT_PHONE_REGION);
  } catch (e) {
    if (e instanceof PhoneError) {
      throw new AdminError("invalid_msisdn", `msisdn '${opts.msisdn}' is not a valid phone`);
    }
    throw e;
  }

  // Confirm the parent app exists. Without this, a typo'd app id would
  // succeed at the FK level (Postgres only enforces presence) but the
  // receiver would be unreachable forever.
  const apps = await db
    .select({ id: schema.apps.id, name: schema.apps.name, disabled: schema.apps.disabled })
    .from(schema.apps)
    .where(eq(schema.apps.id, opts.appId))
    .limit(1);
  const app = apps[0];
  if (!app) throw new AdminError("app_not_found", `app ${opts.appId} not found`);
  if (app.disabled) {
    throw new AdminError("app_disabled", `app ${opts.appId} is disabled — re-enable before adding receivers`);
  }

  const receiverId = newId(RECEIVER_PREFIX);
  const signingKey = generateNonce(32); // 256 bits
  const wrapped = wrapGatewaySigningKey(signingKey, receiverId);

  await db.insert(schema.receivers).values({
    id: receiverId,
    appId: opts.appId,
    name: opts.name.trim(),
    operator: opts.operator?.trim() || null,
    msisdn: phone.e164,
    secretHash: wrapped,
    enabled: true,
    lastHeartbeatAt: opts.simulateHeartbeat ? new Date() : null,
  });

  return {
    receiverId,
    msisdn: phone.e164,
    signingKey,
    appId: opts.appId,
    appName: app.name,
    operator: opts.operator?.trim() || null,
    name: opts.name.trim(),
  };
}

// ----- list receivers -----------------------------------------------

export interface ReceiverRecord {
  id: string;
  appId: string;
  appName: string;
  name: string;
  operator: string | null;
  msisdn: string;
  enabled: boolean;
  lastHeartbeatAt: Date | null;
  /** Seconds since last heartbeat, or null if never. */
  lastHeartbeatAgoSeconds: number | null;
  /** True if heartbeat is fresh (within RECEIVER_HEARTBEAT_TIMEOUT_SECONDS). */
  healthy: boolean;
  createdAt: Date;
}

export interface ListReceiversOptions {
  appId?: string;
  /** If true, include disabled receivers. Default: true (admins want everything). */
  includeDisabled?: boolean;
}

export async function listReceivers(opts: ListReceiversOptions = {}): Promise<ReceiverRecord[]> {
  const conditions = [];
  if (opts.appId) conditions.push(eq(schema.receivers.appId, opts.appId));
  if (opts.includeDisabled === false) conditions.push(eq(schema.receivers.enabled, true));

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
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.receivers.createdAt));

  const now = Date.now();
  const fresh = config.RECEIVER_HEARTBEAT_TIMEOUT_SECONDS * 1000;
  return rows.map((r) => {
    const ago = r.lastHeartbeatAt ? Math.floor((now - r.lastHeartbeatAt.getTime()) / 1000) : null;
    const healthy =
      r.enabled && r.lastHeartbeatAt !== null && now - r.lastHeartbeatAt.getTime() <= fresh;
    return {
      id: r.id,
      appId: r.appId,
      appName: r.appName,
      name: r.name,
      operator: r.operator,
      msisdn: r.msisdn,
      enabled: r.enabled,
      lastHeartbeatAt: r.lastHeartbeatAt,
      lastHeartbeatAgoSeconds: ago,
      healthy,
      createdAt: r.createdAt,
    };
  });
}

// ----- disable receiver ---------------------------------------------

export interface DisableReceiverResult {
  id: string;
  wasEnabled: boolean;
  msisdn: string;
}

export async function disableReceiver(receiverId: string): Promise<DisableReceiverResult> {
  if (!/^rcv_[A-Za-z0-9]+$/.test(receiverId)) {
    throw new AdminError("invalid_receiver_id", `receiver id must look like 'rcv_<ulid>'`);
  }

  const before = await db
    .select({ id: schema.receivers.id, enabled: schema.receivers.enabled, msisdn: schema.receivers.msisdn })
    .from(schema.receivers)
    .where(eq(schema.receivers.id, receiverId))
    .limit(1);
  const row = before[0];
  if (!row) throw new AdminError("receiver_not_found", `receiver ${receiverId} not found`);

  if (!row.enabled) return { id: row.id, wasEnabled: false, msisdn: row.msisdn };

  await db.update(schema.receivers).set({ enabled: false }).where(eq(schema.receivers.id, receiverId));
  return { id: row.id, wasEnabled: true, msisdn: row.msisdn };
}

/**
 * Symmetric to [disableReceiver]: flip `enabled` back to true so a
 * receiver disabled for maintenance returns to the selection pool
 * (and the HMAC verify path stops rejecting its inbound).
 *
 * Idempotent: a receiver already enabled is a no-op (`wasDisabled: false`).
 *
 * Note: `enabled` is the only thing this flips. A receiver whose
 * `last_heartbeat_at` is stale will still be excluded from the
 * selection path until the gateway sends a fresh heartbeat — there's
 * no "force healthy" mode by design. v0.9 PR #44.
 */
export async function enableReceiver(receiverId: string): Promise<EnableReceiverResult> {
  if (!/^rcv_[A-Za-z0-9]+$/.test(receiverId)) {
    throw new AdminError("invalid_receiver_id", `receiver id must look like 'rcv_<ulid>'`);
  }

  const before = await db
    .select({ id: schema.receivers.id, enabled: schema.receivers.enabled, msisdn: schema.receivers.msisdn })
    .from(schema.receivers)
    .where(eq(schema.receivers.id, receiverId))
    .limit(1);
  const row = before[0];
  if (!row) throw new AdminError("receiver_not_found", `receiver ${receiverId} not found`);

  if (row.enabled) return { id: row.id, wasDisabled: false, msisdn: row.msisdn };

  await db.update(schema.receivers).set({ enabled: true }).where(eq(schema.receivers.id, receiverId));
  return { id: row.id, wasDisabled: true, msisdn: row.msisdn };
}

export interface EnableReceiverResult {
  id: string;
  wasDisabled: boolean;
  msisdn: string;
}

// testReceiver intentionally lives in admin/probe.ts (a separate module
// path: `@syrotp/server/admin/probe`) so callers can import it without
// pulling in db/redis. See admin/probe.ts for the rationale.

// ----- shared error type -------------------------------------------

/**
 * Typed error thrown by admin functions. Code is a stable string the CLI
 * (or any caller) can branch on without parsing English messages.
 */
export class AdminError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "AdminError";
  }
}
