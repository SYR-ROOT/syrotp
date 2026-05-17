/**
 * bootstrapApp — create an app + a public + secret API key.
 *
 * This is the SAME code path the v0.1.0 `scripts/bootstrap.ts` runs;
 * we've factored it out so both the existing CLI script and the new
 * `@syrotp/cli` `syrotp bootstrap` command use one source of truth.
 *
 * Returns plaintext keys — they are shown to the operator exactly once
 * and then forgotten. The DB only ever holds HMAC-derived hashes (see
 * `lib/crypto.ts`).
 */
import { config } from "../config.js";
import { db, schema } from "../db/index.js";
import { generateApiKey, hashSecret } from "../lib/crypto.js";
import { newId, APP_PREFIX, API_KEY_PREFIX } from "../lib/ids.js";

export interface BootstrapAppOptions {
  /** Display name. Stored verbatim in the apps table. */
  name: string;
}

export interface BootstrapAppResult {
  appId: string;
  appName: string;
  publicKey: string;
  secretKey: string;
}

export async function bootstrapApp(opts: BootstrapAppOptions): Promise<BootstrapAppResult> {
  if (typeof opts.name !== "string" || opts.name.trim().length === 0) {
    throw new Error("bootstrapApp: name is required");
  }
  const trimmed = opts.name.trim();

  const appId = newId(APP_PREFIX);
  await db.insert(schema.apps).values({ id: appId, name: trimmed });

  const publicKey = generateApiKey("pk_live");
  const secretKey = generateApiKey("sk_live");
  await db.insert(schema.apiKeys).values([
    {
      id: newId(API_KEY_PREFIX),
      appId,
      kind: "public",
      keyHash: hashSecret("api_key", config.MASTER_ENCRYPTION_KEY, publicKey),
      keyPrefix: publicKey.slice(0, 12),
      label: "default-public",
    },
    {
      id: newId(API_KEY_PREFIX),
      appId,
      kind: "secret",
      keyHash: hashSecret("api_key", config.MASTER_ENCRYPTION_KEY, secretKey),
      keyPrefix: secretKey.slice(0, 12),
      label: "default-secret",
    },
  ]);

  return { appId, appName: trimmed, publicKey, secretKey };
}
