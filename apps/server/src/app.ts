import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import { randomUUID } from "node:crypto";
import { config, trustedProxies } from "./config.js";
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
  interface FastifyRequest {
    /**
     * The raw, attacker-controlled `X-Request-Id` header value, if the
     * client sent one (and it passed shape validation). Carried so
     * audit / debug surfaces can echo what the client claimed without
     * letting that value poison `req.id` — which we always
     * server-generate. Never use this for log correlation or as a key
     * in any data structure indexed by request identity.
     */
    clientRequestId?: string;
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
  // Resolve the proxy-trust configuration:
  //   - If TRUSTED_PROXIES is set, we always trust it — `trustProxy`
  //     receives the array form, so Fastify only honours X-Forwarded-*
  //     from those exact hops.
  //   - Otherwise we fall back to `false` (trust nobody). The legacy
  //     boolean TRUST_PROXY=true used to silently mean "trust EVERY
  //     upstream", which allowed req.ip spoofing via X-Forwarded-For.
  //     In production we now refuse to boot in that configuration
  //     (see config.ts). In dev we warn and downgrade to `false`.
  let resolvedTrustProxy: string[] | false;
  if (trustedProxies.length > 0) {
    resolvedTrustProxy = [...trustedProxies];
  } else {
    resolvedTrustProxy = false;
    if (config.TRUST_PROXY && config.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn(
        "[syrotp] TRUST_PROXY=true but TRUSTED_PROXIES is empty — " +
          "downgrading to trustProxy=false. Set TRUSTED_PROXIES to the " +
          "IP(s) / CIDR(s) of your reverse proxy to honour " +
          "X-Forwarded-For. Production refuses to boot in this state.",
      );
    }
  }

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
    // ALWAYS server-generate req.id. We used to honour an upstream
    // X-Request-Id when TRUST_PROXY was set, but that lets a caller
    // (or any peer the proxy forwards from) poison our logs / audit
    // rows / 500-response bodies with attacker-chosen values —
    // including IDs that collide with real verifications. The raw
    // header is still captured on `req.clientRequestId` (see the
    // onRequest hook below) for audit echo purposes only.
    genReqId: () => randomUUID(),
    trustProxy: resolvedTrustProxy,
    // Cap request body size — inbound SMS bodies are < 2KB; admin payloads small.
    bodyLimit: 64 * 1024,
    // Disable x-powered-by-style server fingerprinting.
    disableRequestLogging: false,
  });

  // Capture (but never trust) the client-supplied X-Request-Id. Shape-
  // validated to keep log lines tidy if anything ever echoes it.
  app.addHook("onRequest", async (req) => {
    const h = req.headers["x-request-id"];
    if (typeof h === "string" && h.length > 0 && h.length <= 128 && /^[A-Za-z0-9._-]+$/.test(h)) {
      req.clientRequestId = h;
    }
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
