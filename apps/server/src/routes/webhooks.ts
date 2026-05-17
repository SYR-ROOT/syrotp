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
import { badRequest, notFound } from "../lib/errors.js";
import { audit } from "../services/audit.js";
import {
  VERIFICATION_EVENT_TYPES,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getWebhookEndpoint,
  listWebhookEndpoints,
} from "../services/webhooks.js";

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
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("validation_error", "invalid request body", {
        issues: parsed.error.issues,
      });
    }

    const created = await createWebhookEndpoint({
      appId: auth.appId,
      url: parsed.data.url,
      eventTypes: parsed.data.event_types,
    });

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
    const rows = await listWebhookEndpoints(auth.appId);
    return { data: rows };
  });

  // Read one
  app.get("/v1/webhooks/:id", async (req) => {
    const auth = await app.requireKey(req, ["secret"]);
    const params = idParam.safeParse(req.params);
    if (!params.success) throw notFound("webhook_endpoint");
    return getWebhookEndpoint(auth.appId, params.data.id);
  });

  // Delete
  app.delete("/v1/webhooks/:id", async (req, reply) => {
    const auth = await app.requireKey(req, ["secret"]);
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
