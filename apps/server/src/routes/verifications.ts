import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { badRequest, notFound } from "../lib/errors.js";
import { normalizePhone, PhoneError } from "../lib/phone.js";
import { rateCheck } from "../services/rateLimit.js";
import { rateLimited } from "../lib/errors.js";
import { audit } from "../services/audit.js";
import { metrics } from "../services/metrics.js";
import {
  cancelVerification,
  getVerification,
  startVerification,
  validatePurpose,
} from "../services/verifications.js";

const startBody = z.object({
  phone: z.string().min(5).max(20),
  purpose: z.string().min(2).max(64),
  client_ref: z.string().max(128).optional(),
  locale: z.string().max(16).optional(),
  // Optional carrier hint. The router prefers a healthy receiver
  // whose `operator` matches; falls back to any healthy if none
  // does. Bounded charset prevents injection / surprises in logs.
  operator: z.string().min(1).max(32).regex(/^[a-zA-Z0-9_-]+$/).optional(),
});

const idParam = z.object({
  id: z.string().regex(/^vrf_[A-Za-z0-9]+$/),
});

function clientIp(req: FastifyRequest): string {
  // Fastify resolves req.ip respecting trustProxy config we set at boot.
  return req.ip;
}

export async function verificationRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/verifications", async (req, reply) => {
    // Latency on the success path only — error branches throw before
    // reaching the observe() call below. Each error category has its
    // own dedicated counter (api_key_rejected, rate_limited, ...) so
    // we don't lose visibility, we just don't conflate error latency
    // with happy-path latency in the histogram.
    const t0 = performance.now();

    const auth = await app.requireKey(req, ["public", "secret"]);

    const ip = clientIp(req);
    const rl = await rateCheck(
      `start:ip:${ip}`,
      config.RATE_LIMIT_START_PER_IP_PER_MIN,
      60,
    );
    if (!rl.allowed) {
      metrics.rateLimited("start");
      throw rateLimited(rl.resetSeconds);
    }

    // v0.8 PR #38 — per-app bucket stacked on top of the per-IP
    // bucket above. Both must pass; the cheap per-IP guard runs
    // first, the broader per-app bucket second so a single
    // compromised key fanning out across many IPs still hits a
    // ceiling before drowning the tenant's neighbors.
    const rlApp = await rateCheck(
      `start:app:${auth.appId}`,
      config.RATE_LIMIT_VERIFICATIONS_PER_APP_PER_MIN,
      60,
    );
    if (!rlApp.allowed) {
      metrics.rateLimited("verification_start_per_app");
      throw rateLimited(rlApp.resetSeconds);
    }

    const parsed = startBody.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("validation_error", "invalid request body", { issues: parsed.error.issues });
    }
    const body = parsed.data;
    validatePurpose(body.purpose);

    let phone;
    try {
      phone = normalizePhone(body.phone, config.DEFAULT_PHONE_REGION);
    } catch (e) {
      if (e instanceof PhoneError) throw badRequest(e.code, "phone is not valid");
      throw e;
    }

    const v = await startVerification({
      appId: auth.appId,
      phoneE164: phone.e164,
      purpose: body.purpose,
      clientRef: body.client_ref,
      locale: body.locale,
      preferredOperator: body.operator,
      ip,
    });

    metrics.verificationStarted(auth.appId);
    metrics.verificationStartObserved((performance.now() - t0) / 1000, 201);

    await audit({
      appId: auth.appId,
      actor: `key:${auth.id}`,
      action: "verification.start",
      resourceType: "verification",
      resourceId: v.id,
      ip,
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
      requestId: req.id,
      meta: { phone_masked: v.phone_masked, purpose: body.purpose },
    });

    reply.code(201);
    return v;
  });

  app.get("/v1/verifications/:id", async (req) => {
    const auth = await app.requireKey(req, ["public", "secret"]);

    const ip = clientIp(req);
    const rl = await rateCheck(
      `status:ip:${ip}`,
      config.RATE_LIMIT_STATUS_PER_IP_PER_MIN,
      60,
    );
    if (!rl.allowed) {
      metrics.rateLimited("status");
      throw rateLimited(rl.resetSeconds);
    }

    const params = idParam.safeParse(req.params);
    if (!params.success) throw notFound("verification");
    return getVerification(auth.appId, params.data.id, auth.kind === "secret" ? "secret" : "public");
  });

  app.post("/v1/verifications/:id/cancel", async (req) => {
    // Cancel is a destructive operation — only backend (secret) keys may do
    // it. A leaked public key in a browser must not be able to grief
    // pending verifications.
    const auth = await app.requireKey(req, ["secret"]);
    const params = idParam.safeParse(req.params);
    if (!params.success) throw notFound("verification");

    const result = await cancelVerification(auth.appId, params.data.id);
    metrics.verificationTerminal(auth.appId, "cancelled");

    await audit({
      appId: auth.appId,
      actor: `key:${auth.id}`,
      action: "verification.cancel",
      resourceType: "verification",
      resourceId: params.data.id,
      ip: clientIp(req),
      requestId: req.id,
    });

    return result;
  });
}
