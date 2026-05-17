/**
 * Integration test entry point.
 *
 * Why a single entry: node --test parallelizes files by default. Loading
 * every suite from one file gives us deterministic, sequential execution
 * inside one process — important because the suites share a Postgres test
 * DB and a Redis test DB.
 *
 * Run:
 *   pnpm --filter @syrotp/server test:integration
 *
 * Requires:
 *   docker compose up -d postgres redis
 */
import "./setup.js"; // MUST be first; sets env vars before any other imports.

import { after, before } from "node:test";
import { initTestDatabase, resetDatabase } from "./helpers/db.js";
import { resetRedis } from "./helpers/redis.js";
import { closeTestApp } from "./helpers/app.js";

before(async () => {
  await initTestDatabase();
  await resetDatabase();
  await resetRedis();
});

after(async () => {
  await closeTestApp();
  // Best-effort: close any straggler connections.
  const { closeDb } = await import("../src/db/index.js");
  const { closeRedis } = await import("../src/lib/redis.js");
  await closeDb().catch(() => {});
  await closeRedis().catch(() => {});
});

// The order matters: each suite drops state via its own beforeEach hook,
// but the *first* suite gets a clean slate from the before() above.
import "./suites/verifications.js";
import "./suites/inbound.js";
import "./suites/auth.js";
import "./suites/rateLimit.js";
import "./suites/cors.js";
import "./suites/logs.js";
import "./suites/atRest.js";
import "./suites/concurrency.js";
import "./suites/metrics.js";
import "./suites/admin.js";
import "./suites/hosted.js";
import "./suites/webhooks.js";
import "./suites/webhookWorker.js";
import "./suites/webhookWorkerStandalone.js";
import "./suites/multiReceiver.js";
import "./suites/receiverFleet.js";
import "./suites/webauthn.js";
import "./suites/phoneBindings.js";
import "./suites/phoneBindingEnforcement.js";
import "./suites/rateLimitPerApp.js";
import "./suites/openapiContract.js";
