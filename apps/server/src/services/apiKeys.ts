import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { config } from "../config.js";
import { hashSecret } from "../lib/crypto.js";

export type ApiKeyKind = "public" | "secret" | "gateway";

export interface AuthedKey {
  id: string;
  appId: string;
  kind: ApiKeyKind;
}

const PREFIX_TO_KIND: Record<string, ApiKeyKind> = {
  pk_live: "public",
  sk_live: "secret",
  gw_live: "gateway",
};

/**
 * Look up an API key by its raw value.
 *
 * Returns null on any failure path (unknown prefix, no row, revoked, app
 * disabled). Never reveal *why* a key was rejected to clients — log it
 * server-side instead.
 */
export async function lookupApiKey(raw: string): Promise<AuthedKey | null> {
  if (typeof raw !== "string" || raw.length < 16 || raw.length > 128) return null;

  const lastUnderscore = raw.lastIndexOf("_");
  if (lastUnderscore < 0) return null;
  const prefix = raw.slice(0, lastUnderscore); // "pk_live", "sk_live", "gw_live"
  const kind = PREFIX_TO_KIND[prefix];
  if (!kind) return null;

  const hash = hashSecret("api_key", config.MASTER_ENCRYPTION_KEY, raw);

  const rows = await db
    .select({
      id: schema.apiKeys.id,
      appId: schema.apiKeys.appId,
      kind: schema.apiKeys.kind,
      revokedAt: schema.apiKeys.revokedAt,
      appDisabled: schema.apps.disabled,
    })
    .from(schema.apiKeys)
    .innerJoin(schema.apps, eq(schema.apiKeys.appId, schema.apps.id))
    .where(eq(schema.apiKeys.keyHash, hash))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.appDisabled) return null;
  if (row.kind !== kind) return null; // prefix/kind mismatch — corrupted record

  // Best-effort last-used update; do not block the request on it.
  void db
    .update(schema.apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.apiKeys.id, row.id))
    .catch(() => {});

  return { id: row.id, appId: row.appId, kind: row.kind };
}
