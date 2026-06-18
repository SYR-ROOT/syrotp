/**
 * WebAuthn fallback routes — `/v1/webauthn/{register,login}/{options,verify}`.
 *
 * All four POST endpoints are gated by `sk_live_*` keys. A leaked
 * `pk_live_*` in a browser MUST NOT be able to register passkeys
 * for arbitrary `client_ref` values.
 *
 * The plugin is **disabled by default**: when `WEBAUTHN_ENABLED` is
 * unset (or false) — or when the required RP_ID / ORIGINS aren't
 * configured — the routes never mount, so every probe returns 404
 * with no hint that the surface exists.
 */
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import { config } from "../config.js";
import { badRequest, rateLimited } from "../lib/errors.js";
import { audit } from "../services/audit.js";
import { metrics } from "../services/metrics.js";
import { rateCheck } from "../services/rateLimit.js";
import {
  buildLoginOptions,
  buildRegisterOptions,
  isWebAuthnConfigured,
  verifyLogin,
  verifyRegister,
} from "../services/webauthn.js";

/**
 * v1.0.1 — every WebAuthn ceremony endpoint runs through one shared
 * per-app rate limit. A leaked `sk_live_*` without this ceiling would
 * let an attacker spam `register/options` to stamp millions of
 * challenge rows (DoS of webauthn_challenges + the AEAD secret
 * namespace), enumerate registered credentials via repeated
 * `login/options` calls, or grind verify probes. There's no per-IP
 * guard — WebAuthn ceremonies originate from the developer's
 * backend, not arbitrary clients — so the per-app bucket is the
 * only ceiling.
 *
 * One shared bucket across all four routes is intentional: an
 * attacker with the key can amplify on whichever ceremony stage
 * they pick, so the cap has to be on the whole surface.
 */
async function webauthnRateLimit(appId: string): Promise<void> {
  const rl = await rateCheck(
    `webauthn:app:${appId}`,
    config.RATE_LIMIT_WEBAUTHN_PER_APP_PER_MIN,
    60,
  );
  if (!rl.allowed) {
    metrics.rateLimited("webauthn_per_app");
    throw rateLimited(rl.resetSeconds);
  }
}

const clientRefField = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_\-:.]+$/, "client_ref must match [a-zA-Z0-9_-:.]");

const optionsBody = z.object({
  client_ref: clientRefField,
  user_display_name: z.string().min(1).max(128).optional(),
});

// We deliberately don't re-validate the inner WebAuthn response shape
// in zod — `@simplewebauthn/server` has its own strict parser, and
// re-checking would just couple our route layer to library internals.
// We DO fail-closed at the parse boundary so a non-object body
// surfaces as 400 validation_error.
const verifyBody = z.object({
  client_ref: clientRefField,
  response: z.unknown(),
});

export const webauthnRoutes = fp(async function webauthnRoutes(app: FastifyInstance) {
  if (!isWebAuthnConfigured()) {
    app.log.info(
      { reason: "WEBAUTHN_ENABLED is false or RP_ID/ORIGINS missing" },
      "webauthn fallback disabled",
    );
    return;
  }

  app.post("/v1/webauthn/register/options", async (req, reply) => {
    const auth = await app.requireKey(req, ["secret"]);
    await webauthnRateLimit(auth.appId);
    const parsed = optionsBody.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("validation_error", "invalid request body", {
        issues: parsed.error.issues,
      });
    }
    const opts = await buildRegisterOptions({
      appId: auth.appId,
      clientRef: parsed.data.client_ref,
      userDisplayName: parsed.data.user_display_name,
    });
    void reply;
    return opts;
  });

  app.post("/v1/webauthn/register/verify", async (req) => {
    const auth = await app.requireKey(req, ["secret"]);
    await webauthnRateLimit(auth.appId);
    const parsed = verifyBody.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("validation_error", "invalid request body");
    }
    if (!parsed.data.response || typeof parsed.data.response !== "object") {
      throw badRequest("validation_error", "response is required");
    }
    const result = await verifyRegister({
      appId: auth.appId,
      clientRef: parsed.data.client_ref,
      // The library does the strict parse; we pass the raw object through.
      response: parsed.data.response as never,
    });
    await audit({
      appId: auth.appId,
      actor: `key:${auth.id}`,
      action: "webauthn.register",
      resourceType: "webauthn_credential",
      resourceId: result.credential_id,
      ip: req.ip,
      requestId: req.id,
      meta: { client_ref: parsed.data.client_ref },
    });
    return result;
  });

  app.post("/v1/webauthn/login/options", async (req, reply) => {
    const auth = await app.requireKey(req, ["secret"]);
    await webauthnRateLimit(auth.appId);
    const parsed = optionsBody.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("validation_error", "invalid request body");
    }
    const opts = await buildLoginOptions({
      appId: auth.appId,
      clientRef: parsed.data.client_ref,
    });
    void reply;
    return opts;
  });

  app.post("/v1/webauthn/login/verify", async (req) => {
    const auth = await app.requireKey(req, ["secret"]);
    await webauthnRateLimit(auth.appId);
    const parsed = verifyBody.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest("validation_error", "invalid request body");
    }
    if (!parsed.data.response || typeof parsed.data.response !== "object") {
      throw badRequest("validation_error", "response is required");
    }
    const result = await verifyLogin({
      appId: auth.appId,
      clientRef: parsed.data.client_ref,
      response: parsed.data.response as never,
    });
    await audit({
      appId: auth.appId,
      actor: `key:${auth.id}`,
      action: "webauthn.login",
      resourceType: "webauthn_credential",
      ip: req.ip,
      requestId: req.id,
      meta: { client_ref: parsed.data.client_ref },
    });
    return result;
  });
}, { name: "syrotp-webauthn" });
