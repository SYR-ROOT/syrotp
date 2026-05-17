import { db, schema } from "../db/index.js";
import { newId } from "../lib/ids.js";

export interface AuditEntry {
  appId?: string;
  actor?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  ip?: string;
  userAgent?: string;
  requestId?: string;
  meta?: Record<string, unknown>;
}

export async function audit(entry: AuditEntry): Promise<void> {
  // Fire and forget — never let logging block the request, but surface
  // failures so we notice if writes are silently dropping.
  try {
    await db.insert(schema.auditLog).values({
      id: newId("aud"),
      appId: entry.appId,
      actor: entry.actor,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      ip: entry.ip,
      userAgent: entry.userAgent?.slice(0, 256),
      requestId: entry.requestId,
      metaJson: entry.meta ? JSON.stringify(entry.meta) : null,
    });
  } catch (err) {
    console.error("[audit] failed to write entry:", (err as Error).message);
  }
}
