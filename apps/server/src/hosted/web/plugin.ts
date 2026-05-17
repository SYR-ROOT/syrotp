/**
 * Hosted verification page — `GET /v/:id` + `GET /v/:id/status`.
 *
 * Public — no API key required. The verification id is the auth token
 * (ULID-style 128-bit; enumeration-safe). The page is meant for the
 * end user: it renders the receiver msisdn, the `VERIFY <code>`
 * message, a countdown to expiry, and polls `/status` every 2.5s
 * until the verification leaves the `pending` state.
 *
 * Disabled by setting `HOSTED_PAGE_ENABLED=false` — every probe under
 * `/v/*` then 404s with no hint that the routes ever existed.
 *
 * Defense in depth:
 *   - strict CSP — `default-src 'none'`, scripts gated by per-request
 *     nonce, no external resources, frame-ancestors locked
 *   - X-Frame-Options DENY, Referrer-Policy no-referrer,
 *     X-Content-Type-Options nosniff, Cache-Control no-store
 *   - autoescape on every template substitution; the verification id
 *     is regex-validated before it ever reaches the renderer
 *   - the polling JSON drops everything except status + timestamps so
 *     the high-frequency endpoint is the leanest possible exposure
 *   - per-IP rate limit on `/status` (reuses the existing
 *     `RATE_LIMIT_STATUS_PER_IP_PER_MIN` budget) so a hostile poller
 *     can't grind on the DB
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Eta } from "eta";
import fp from "fastify-plugin";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { config } from "../../config.js";
import { rateLimited, notFound } from "../../lib/errors.js";
import { rateCheck } from "../../services/rateLimit.js";
import { metrics } from "../../services/metrics.js";
import {
  getHostedVerification,
  getHostedVerificationStatus,
} from "../../services/verifications.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveViewsDir(): string {
  // Mirrors the admin plugin's strategy: prefer the dist layout (where
  // tsc emits), fall back to the src layout for tsx-driven test runs.
  const candidates = [
    join(__dirname, "..", "views"),
    join(__dirname, "..", "..", "..", "src", "hosted", "views"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!;
}

const idParam = z.object({
  id: z.string().regex(/^vrf_[A-Za-z0-9]+$/),
});

function clientIp(req: FastifyRequest): string {
  return req.ip;
}

/**
 * Build a CSP that allows ONLY the inline `<script>` tagged with
 * `nonce-<value>`. Inline styles are still allowed via
 * `'unsafe-inline'` (no equivalent risk surface — admin uses the
 * same trade-off). External requests are limited to `connect-src
 * 'self'` so the polling fetch reaches the same origin and nothing
 * else.
 */
function cspFor(scriptNonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${scriptNonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export const hostedPlugin = fp(async function hostedPlugin(app: FastifyInstance): Promise<void> {
  if (!config.HOSTED_PAGE_ENABLED) {
    app.log.info("hosted verification page disabled (HOSTED_PAGE_ENABLED=false)");
    return;
  }

  const eta = new Eta({ views: resolveViewsDir(), cache: true, autoEscape: true });

  app.get("/v/:id", async (req, reply) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) throw notFound("verification");

    const v = await getHostedVerification(params.data.id);
    if (!v) throw notFound("verification");

    // Per-request script nonce — re-rolled every render so a
    // long-lived browser cache can't surface stale nonces.
    const scriptNonce = randomBytes(16).toString("base64");

    const html = await renderPage(eta, {
      verification: v,
      scriptNonce,
      pollIntervalMs: 2500,
      // Optional fallback URL ("use a passkey instead"). The page
      // itself does NOT inline a WebAuthn flow in v0.5 — clicking
      // the link hands the user off to whatever URL the operator
      // configured. Empty string when WEBAUTHN_FALLBACK_URL is unset.
      webauthnFallbackUrl: config.WEBAUTHN_FALLBACK_URL ?? "",
    });

    reply
      .header("Content-Type", "text/html; charset=utf-8")
      .header("Content-Security-Policy", cspFor(scriptNonce))
      .header("X-Frame-Options", "DENY")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "private, no-store");

    return html;
  });

  app.get("/v/:id/status", async (req, reply) => {
    // Rate-limit the polling endpoint per-IP. Reuses the same budget
    // that the public `GET /v1/verifications/:id` API consumes — same
    // shape of read traffic, same protection model.
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

    const status = await getHostedVerificationStatus(params.data.id);
    if (!status) throw notFound("verification");

    reply
      .header("Cache-Control", "private, no-store")
      .header("Content-Type", "application/json; charset=utf-8");
    return status;
  });
}, { name: "syrotp-hosted" });

async function renderPage(
  eta: Eta,
  data: {
    verification: Awaited<ReturnType<typeof getHostedVerification>>;
    scriptNonce: string;
    pollIntervalMs: number;
    webauthnFallbackUrl: string;
  },
): Promise<string> {
  const body = await eta.renderAsync("verify", data);
  return eta.renderAsync("_layout", {
    title: "Verify your phone — SYROTP",
    body,
    scriptNonce: data.scriptNonce,
  });
}
