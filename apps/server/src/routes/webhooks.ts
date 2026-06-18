/**
 * Webhook endpoint CRUD — `/v1/webhooks`. Backend-only surface,
 * gated by `sk_live_*` keys (a public key in a browser must NOT be
 * able to point a webhook at a third party). PR #20A scope:
 *
 *   POST   /v1/webhooks       create endpoint, return secret ONCE
 *   GET    /v1/webhooks       list endpoints (no secrets)
 *   GET    /v1/webhooks/:id   read one endpoint (no secret)
 *   DELETE /v1/webhooks/:id   delete (cascade kills queued deliveries)
 *
 * No PATCH / no test-fire by design — see PR #20A scope notes. Add
 * those in a follow-up if needed.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { badRequest, notFound, rateLimited } from "../lib/errors.js";
import { WebhookValidationError } from "../lib/ssrfGuard.js";
import { audit } from "../services/audit.js";
import { metrics } from "../services/metrics.js";
import { rateCheck } from "../services/rateLimit.js";
import {
  VERIFICATION_EVENT_TYPES,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getWebhookEndpoint,
  listWebhookEndpoints,
} from "../services/webhooks.js";

/**
 * v1.0.1 — every webhook CRUD endpoint runs through one shared
 * per-app rate limit. A leaked `sk_live_*` without this ceiling would
 * let an attacker churn endpoint rows (create / delete loops to
 * exhaust the AEAD secret namespace, or list-poll to enumerate
 * tenants' delivery URLs) at unlimited rates. There's no per-IP
 * guard here — webhook CRUD is backend-only, not browser traffic —
 * so the per-app bucket is the only ceiling.
 *
 * One shared bucket (rather than four route-specific buckets) is
 * intentional: an attacker who has the key can amplify on whichever
 * verb they pick, so the cap has to be on the whole surface.
 */
async function webhookCrudRateLimit(appId: string): Promise<void> {
  const rl = await rateCheck(
    `webhook_crud:app:${appId}`,
    config.RATE_LIMIT_WEBHOOK_CRUD_PER_APP_PER_MIN,
    60,
  );
  if (!rl.allowed) {
    metrics.rateLimited("webhook_crud_per_app");
    throw rateLimited(rl.resetSeconds);
  }
}

const idParam = z.object({
  id: z.string().regex(/^whk_[A-Za-z0-9]+$/),
});

const createBody = z.object({
  url: z.string().min(1).max(2048),
  event_types: z
    .array(z.enum(VERIFICATION_EVENT_TYPES))
    .min(1)
    .max(VERIFICATION_EVENT_TYPES.length),
});

function clientIp(req: FastifyRequest): string {
  return req.ip;
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // Create
  app.post("/v1/webhooks", async (req, reply) => {
    const auth = await app.requireKey(req, ["secret"]);
    await webhookCrudRateLimit(auth.appId);
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("validation_error", "invalid request body", {
        issues: parsed.error.issues,
      });
    }

    let created: Awaited<ReturnType<typeof createWebhookEndpoint>>;
    try {
      created = await createWebhookEndpoint({
        appId: auth.appId,
        url: parsed.data.url,
        eventTypes: parsed.data.event_types,
      });
    } catch (err) {
      // SSRF guard refused the URL — map to 400 with the dedicated
      // code so the SDK / caller can distinguish "you sent garbage"
      // from "we refused to deliver to that target".
      if (err instanceof WebhookValidationError) {
        throw badRequest(err.code, err.message);
      }
      throw err;
    }

    await audit({
      appId: auth.appId,
      actor: `key:${auth.id}`,
      action: "webhook.create",
      resourceType: "webhook_endpoint",
      resourceId: created.id,
      ip: clientIp(req),
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
      requestId: req.id,
      meta: { url: created.url, event_types: created.event_types },
    });

    reply.code(201);
    return created; // includes `secret` ONCE — never re-emitted by GET
  });

  // List
  app.get("/v1/webhooks", async (req) => {
    const auth = await app.requireKey(req, ["secret"]);
    await webhookCrudRateLimit(auth.appId);
    const rows = await listWebhookEndpoints(auth.appId);
    return { data: rows };
  });

  // Read one
  app.get("/v1/webhooks/:id", async (req) => {
    const auth = await app.requireKey(req, ["secret"]);
    await webhookCrudRateLimit(auth.appId);
    const params = idParam.safeParse(req.params);
    if (!params.success) throw notFound("webhook_endpoint");
    return getWebhookEndpoint(auth.appId, params.data.id);
  });

  // Delete
  app.delete("/v1/webhooks/:id", async (req, reply) => {
    const auth = await app.requireKey(req, ["secret"]);
    await webhookCrudRateLimit(auth.appId);
    const params = idParam.safeParse(req.params);
    if (!params.success) throw notFound("webhook_endpoint");

    await deleteWebhookEndpoint(auth.appId, params.data.id);

    await audit({
      appId: auth.appId,
      actor: `key:${auth.id}`,
      action: "webhook.delete",
      resourceType: "webhook_endpoint",
      resourceId: params.data.id,
      ip: clientIp(req),
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
      requestId: req.id,
    });

    reply.code(204);
    return null;
  });
}
