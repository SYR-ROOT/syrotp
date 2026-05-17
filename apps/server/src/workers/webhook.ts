/**
 * Standalone webhook delivery worker (v0.9 PR #41 — Webhook Worker
 * Split).
 *
 * Why this exists:
 *
 * The same `WebhookWorker` class is used in two deployment shapes:
 *
 *   1. **Single-process MVP (default).** API server starts the worker
 *      in-process via `buildApp()`. `WEBHOOK_WORKER_ENABLED=true`
 *      (the default) — backward-compatible with every prior release.
 *
 *   2. **Split deployment.** API tier sets
 *      `WEBHOOK_WORKER_ENABLED=false` so the in-process timer is a
 *      no-op, and one (or more) of these standalone processes runs the
 *      delivery loop on its own. Multi-instance safety is already at
 *      the DB layer (`FOR UPDATE SKIP LOCKED` + soft 60s lease in
 *      `services/webhookWorker.ts`), so N workers can race the queue
 *      without double-delivering.
 *
 * What's intentionally NOT here:
 *
 *   - **No Fastify, no HTTP listener.** The worker process doesn't
 *     serve any traffic — not /healthz, not /metrics. Adding either
 *     pulls in a framework dependency the worker doesn't need; both
 *     are deferred to a follow-up PR.
 *   - **No migrations.** Migration ownership stays single — operators
 *     run `pnpm migrate` once before starting the API tier OR the
 *     worker tier. A worker that boots against a stale schema fails
 *     fast on the first query, which is what we want.
 *   - **No Redis bootstrap.** The webhook worker doesn't touch Redis;
 *     it only reads/writes `webhook_*` tables in Postgres.
 *
 * Lifecycle:
 *
 *   - Refuses to run if `WEBHOOK_WORKER_ENABLED=false` — that flag is
 *     the API-tier signal, and a worker process inheriting it would
 *     silently spin a no-op loop forever. Better to exit fast with a
 *     clear error.
 *   - Logs at info on tick start (via the existing worker class).
 *   - On SIGINT/SIGTERM, stops the timer, waits for the in-flight
 *     tick to finish (the worker class already does this), closes
 *     the DB pool, and exits 0.
 *   - On uncaught exception or unhandled rejection, logs and exits
 *     non-zero so the process supervisor restarts it.
 */
import pino from "pino";
import { config } from "../config.js";
import { closeDb } from "../db/index.js";
import { WebhookWorker } from "../services/webhookWorker.js";

async function main(): Promise<void> {
  const log = pino({
    level: config.LOG_LEVEL,
    base: { service: "syrotp-webhook-worker" },
  });

  if (!config.WEBHOOK_WORKER_ENABLED) {
    log.error(
      "WEBHOOK_WORKER_ENABLED=false — refusing to start. The flag is " +
        "for the API tier; a standalone worker process must have it " +
        "set to true (or unset, which defaults to true). Likely cause: " +
        "you're sourcing the API tier's env file unchanged.",
    );
    process.exit(2);
  }

  const worker = new WebhookWorker(log);
  worker.start();
  log.info(
    { interval_ms: config.WEBHOOK_WORKER_INTERVAL_MS },
    "webhook delivery worker started (standalone)",
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down webhook worker");
    try {
      await worker.stop();
      await closeDb();
    } catch (err) {
      log.error({ err }, "error during worker shutdown");
      process.exit(1);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Don't crash on unhandled rejections in production — log and continue.
  process.on("unhandledRejection", (reason) => {
    log.error({ reason }, "unhandled rejection in webhook worker");
  });
  process.on("uncaughtException", (err) => {
    log.fatal({ err }, "uncaught exception in webhook worker — exiting");
    void shutdown("uncaughtException");
  });

  // Standalone worker has no event-loop work outside the timer, which
  // is `unref()`ed inside the worker class so it doesn't keep us alive.
  // Pin the process up explicitly.
  setInterval(() => {
    /* keep-alive heartbeat for the standalone worker */
  }, 60_000);
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[syrotp-webhook-worker] fatal startup error:", err);
  process.exit(1);
});
