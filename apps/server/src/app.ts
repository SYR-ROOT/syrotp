import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { authPlugin } from "./plugins/auth.js";
import { errorHandlerPlugin } from "./plugins/errorHandler.js";
import { rawBodyPlugin } from "./plugins/rawBody.js";
import { healthRoutes } from "./routes/health.js";
import { metricsRoutes } from "./routes/metrics.js";
import { verificationRoutes } from "./routes/verifications.js";
import { inboundRoutes } from "./routes/inbound.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { phoneBindingRoutes } from "./routes/phoneBindings.js";
import { webauthnRoutes } from "./routes/webauthn.js";
import { startAbuseSignalsRefresh } from "./services/abuseSignals.js";
import { startReceiverGaugesRefresh } from "./services/receiverGauges.js";
import { WebhookWorker } from "./services/webhookWorker.js";
import { adminPlugin } from "./admin/web/plugin.js";
import { hostedPlugin } from "./hosted/web/plugin.js";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Same-process webhook delivery worker. Started after the app is
     * built; stopped via the `onClose` hook so DB connections finish
     * cleanly. Tests trigger ticks deterministically with
     * `app.webhookWorker.runOnce()`.
     */
    webhookWorker: WebhookWorker;
  }
}

export interface BuildAppOptions {
  /**
   * Optional onRoute callback fired for every route registered by the
   * built app. The OpenAPI contract drift test uses this to enumerate
   * the server's live route surface against `openapi.yaml`. Production
   * code passes nothing.
   */
  onRoute?: (route: { method: string | string[]; url: string }) => void;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // Redact obvious secret-bearing fields.
      redact: {
        paths: [
          "req.headers.authorization",
          'req.headers["x-syrotp-signature"]',
          'req.headers["cookie"]',
          "*.api_key",
          "*.apiKey",
          "*.secret",
        ],
        censor: "[REDACTED]",
      },
    },
    // Always assign a request id; trust upstream X-Request-Id only when behind proxy.
    genReqId: (req) => {
      if (config.TRUST_PROXY) {
        const h = req.headers["x-request-id"];
        if (typeof h === "string" && h.length <= 128 && /^[A-Za-z0-9._-]+$/.test(h)) return h;
      }
      return randomUUID();
    },
    trustProxy: config.TRUST_PROXY,
    // Cap request body size — inbound SMS bodies are < 2KB; admin payloads small.
    bodyLimit: 64 * 1024,
    // Disable x-powered-by-style server fingerprinting.
    disableRequestLogging: false,
  });

  if (opts.onRoute) {
    const cb = opts.onRoute;
    app.addHook("onRoute", (route) => {
      cb({ method: route.method, url: route.url });
    });
  }

  await app.register(sensible);
  await app.register(helmet, {
    // We don't serve HTML from the API; lock things down.
    contentSecurityPolicy: false, // not relevant for JSON API; would block hosted page
    crossOriginResourcePolicy: { policy: "same-origin" },
    referrerPolicy: { policy: "no-referrer" },
  });

  const origins = config.CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  await app.register(cors, {
    // Locked-down by default. Wildcard only if explicitly configured.
    origin: origins.length === 0 ? false : origins.includes("*") ? true : origins,
    credentials: false,
    methods: ["GET", "POST"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Request-Id"],
    maxAge: 600,
  });

  await app.register(rawBodyPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);

  await app.register(healthRoutes);
  await app.register(metricsRoutes);
  await app.register(verificationRoutes);
  await app.register(inboundRoutes);
  await app.register(webhookRoutes);

  // Phone-binding ceremony mounts /v1/phone-bindings/* (v0.8 PR
  // #36). All sk_live_* gated. v0.8 PR #37 will turn the existence
  // of a `verified` row into a HARD prerequisite for
  // `startVerification`.
  await app.register(phoneBindingRoutes);

  // WebAuthn fallback mounts /v1/webauthn/* — disabled by default;
  // returns early (no routes mapped, every probe 404s) when
  // WEBAUTHN_ENABLED is false or RP_ID/ORIGINS are unset.
  await app.register(webauthnRoutes);

  // Admin dashboard mounts /admin/* — but only if ADMIN_USER and
  // ADMIN_PASSWORD_HASH are set. Otherwise the plugin returns early and
  // /admin/* is unmapped (404). See src/admin/web/plugin.ts.
  await app.register(adminPlugin);

  // Hosted verification page mounts /v/:id (HTML) and /v/:id/status
  // (JSON). Public — the verification id is the auth token. Disabled
  // by setting HOSTED_PAGE_ENABLED=false. See src/hosted/web/plugin.ts.
  await app.register(hostedPlugin);

  // Periodically refresh receiver-related gauges. Cheap query (one
  // SELECT, indexed) — runs every 30s. Refresher unrefs its timer so
  // it never blocks process shutdown.
  startReceiverGaugesRefresh();

  // v0.8 PR #39 — periodically recompute per-app + per-receiver
  // abuse signals + the global health-score rollup. 60s refresh,
  // unrefed timer. Read-only observability — no auto-ban.
  startAbuseSignalsRefresh();

  // Webhook delivery worker. Periodic timer; disabled by setting
  // WEBHOOK_WORKER_ENABLED=false. See src/services/webhookWorker.ts.
  const webhookWorker = new WebhookWorker(app.log);
  webhookWorker.start();
  app.decorate("webhookWorker", webhookWorker);
  app.addHook("onClose", async () => {
    await webhookWorker.stop();
  });

  return app;
}
