/**
 * Phone-binding ceremony routes — `/v1/phone-bindings/*`.
 *
 * All endpoints are gated by `sk_live_*` keys. A leaked `pk_live_*`
 * MUST NOT be able to start a binding ceremony for an arbitrary
 * phone — that's the developer's claim of phone ownership, and it
 * has to come from the secret-keyed backend.
 *
 * v0.8 PR #36 ships only the ceremony endpoints. PR #37 will turn
 * the existence of a `verified` row into a HARD prerequisite for
 * `startVerification`. Until then, these endpoints are
 * informational from the verification path's point of view.
 */
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import { config } from "../config.js";
import { badRequest, rateLimited } from "../lib/errors.js";
import { audit } from "../services/audit.js";
import { metrics } from "../services/metrics.js";
import {
  getBinding,
  revokeBinding,
  startBinding,
} from "../services/phoneBindings.js";
import { rateCheck } from "../services/rateLimit.js";

const startBody = z.object({
  // Generous on input — the service normalizes via libphonenumber-js
  // and stores E.164. Reject obvious non-numbers up front.
  phone: z.string().min(4).max(32),
  receiver_id: z
    .string()
    .regex(/^rcv_[A-Za-z0-9]+$/, "receiver_id must be a rcv_<ulid>"),
});

const idParam = z.object({
  id: z.string().regex(/^pbn_[A-Za-z0-9]+$/, "id must be a pbn_<ulid>"),
});

export const phoneBindingRoutes = fp(async function phoneBindingRoutes(
  app: FastifyInstance,
) {
  app.post("/v1/phone-bindings/start", async (req, reply) => {
    const auth = await app.requireKey(req, ["secret"]);

    // v0.8 PR #38 — per-app rate limit on binding starts. The
    // ceremony has no per-IP guard (bindings come from the
    // developer's backend, not arbitrary clients), so the per-app
    // bucket is the only ceiling. 60/min is generous for legit
    // operator setup workflows; a runaway script that tries to
    // bind thousands of phones gets clamped immediately.
    const rlApp = await rateCheck(
      `phone_binding_start:app:${auth.appId}`,
      config.RATE_LIMIT_BINDINGS_PER_APP_PER_MIN,
      60,
    );
    if (!rlApp.allowed) {
      metrics.rateLimited("phone_binding_start_per_app");
      throw rateLimited(rlApp.resetSeconds);
    }

    const parsed = startBody.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("validation_error", "invalid request body", {
        issues: parsed.error.issues,
      });
    }

    const result = await startBinding({
      appId: auth.appId,
      receiverId: parsed.data.receiver_id,
      phone: parsed.data.phone,
    });

    // Audit the start, but NEVER log the nonce or the bind_message —
    // they're effectively bearer tokens for the binding window.
    await audit({
      appId: auth.appId,
      actor: `key:${auth.id}`,
      action: "phone_binding.start",
      resourceType: "phone_binding",
      resourceId: result.binding.id,
      requestId: req.id,
      meta: { phone_e164: result.binding.phone_e164, receiver_id: result.binding.receiver_id },
    });

    reply.code(201);
    return {
      binding_id: result.binding.id,
      phone_e164: result.binding.phone_e164,
      receiver_id: result.binding.receiver_id,
      status: result.binding.status,
      expires_at: result.binding.expires_at,
      send_to: result.send_to,
      bind_message: result.bind_message,
    };
  });

  app.get("/v1/phone-bindings/:id", async (req) => {
    const auth = await app.requireKey(req, ["secret"]);

    // v1.0.1 — per-app rate limit on binding reads. The endpoint is
    // typically polled by developer backends during the ceremony
    // window (waiting for the BIND inbound to land), so the cap is
    // looser (60/min default) than the destructive revoke below.
    // Without it, a leaked `sk_live_*` could be used to enumerate
    // binding ids cheaply.
    const rlApp = await rateCheck(
      `phone_binding_read:app:${auth.appId}`,
      config.RATE_LIMIT_BINDING_READ_PER_APP_PER_MIN,
      60,
    );
    if (!rlApp.allowed) {
      metrics.rateLimited("phone_binding_read_per_app");
      throw rateLimited(rlApp.resetSeconds);
    }

    const params = idParam.safeParse(req.params);
    if (!params.success) {
      throw badRequest("validation_error", "invalid id");
    }
    return await getBinding(auth.appId, params.data.id);
  });

  app.post("/v1/phone-bindings/:id/revoke", async (req) => {
    const auth = await app.requireKey(req, ["secret"]);

    // v1.0.1 — per-app rate limit on binding revoke. Destructive
    // (flips a `verified` row to `revoked`, breaking subsequent
    // verifications for that phone), so the cap is tighter (30/min
    // default). A leaked `sk_live_*` without this ceiling could be
    // used to mass-revoke a tenant's bindings.
    const rlApp = await rateCheck(
      `phone_binding_revoke:app:${auth.appId}`,
      config.RATE_LIMIT_BINDING_REVOKE_PER_APP_PER_MIN,
      60,
    );
    if (!rlApp.allowed) {
      metrics.rateLimited("phone_binding_revoke_per_app");
      throw rateLimited(rlApp.resetSeconds);
    }

    const params = idParam.safeParse(req.params);
    if (!params.success) {
      throw badRequest("validation_error", "invalid id");
    }
    const updated = await revokeBinding(auth.appId, params.data.id);
    await audit({
      appId: auth.appId,
      actor: `key:${auth.id}`,
      action: "phone_binding.revoke",
      resourceType: "phone_binding",
      resourceId: updated.id,
      requestId: req.id,
      meta: { phone_e164: updated.phone_e164 },
    });
    return updated;
  });
}, { name: "syrotp-phone-bindings" });
