/**
 * Bootstrap CLI — thin wrapper around the admin module's `bootstrapApp`
 * + `addReceiver` so this script and the `@syrotp/cli` `syrotp bootstrap`
 * command share one source of truth.
 *
 * Usage:
 *   pnpm --filter @syrotp/server tsx src/scripts/bootstrap.ts \
 *     --app-name "My App" --receiver-name "Phone-1" --msisdn "+963991234567"
 *
 * Optional:
 *   --simulate-heartbeat   set last_heartbeat_at = now() so the receiver
 *                          looks "healthy" immediately. Use this for
 *                          smoke / integration tests where no real
 *                          gateway is available.
 *
 * Prints raw keys ONCE to stdout. They are never written to disk.
 */
import { parseArgs } from "node:util";
import { addReceiver, bootstrapApp, closeDb } from "../admin/index.js";
import { config } from "../config.js";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "app-name": { type: "string" },
      "receiver-name": { type: "string" },
      msisdn: { type: "string" },
      "operator": { type: "string" },
      "simulate-heartbeat": { type: "boolean", default: false },
    },
  });

  const appName = values["app-name"] ?? "Default App";
  const receiverName = values["receiver-name"] ?? "Receiver-1";
  const msisdnRaw = values.msisdn;
  if (!msisdnRaw) {
    console.error("--msisdn is required (E.164, e.g. +963991234567)");
    process.exit(2);
  }

  const app = await bootstrapApp({ name: appName });
  const receiver = await addReceiver({
    appId: app.appId,
    name: receiverName,
    msisdn: msisdnRaw,
    operator: values["operator"],
    simulateHeartbeat: !!values["simulate-heartbeat"],
  });

  console.log(`
=== SYROTP bootstrap complete ===
App ID:           ${app.appId}
App name:         ${app.appName}

Public key (frontend, restricted):
  ${app.publicKey}

Secret key (backend, full access):
  ${app.secretKey}

Receiver ID:      ${receiver.receiverId}
Receiver MSISDN:  ${receiver.msisdn}

Gateway signing key (paste into the Android gateway / GSM gateway):
  ${receiver.signingKey}

Save these values now. They will not be shown again.
`);

  // Sanity log so operators know whether heartbeat was pre-set.
  if (values["simulate-heartbeat"]) {
    console.log(
      `(simulated heartbeat — receiver is healthy for ` +
        `${config.RECEIVER_HEARTBEAT_TIMEOUT_SECONDS}s without a real gateway)`,
    );
  }

  await closeDb();
  // Force exit. addReceiver pulls in services/hmac.ts → lib/redis.ts,
  // which opens an eager Redis connection that keeps the event loop
  // alive forever. We don't have a closeRedis hook on the admin module
  // (PR 2 scope keeps the surface small), so explicitly exit here. The
  // success message has already been flushed to stdout above.
  process.exit(0);
}

main().catch(async (err) => {
  console.error("[bootstrap] failed:", err instanceof Error ? err.message : err);
  await closeDb().catch(() => {});
  process.exit(1);
});
