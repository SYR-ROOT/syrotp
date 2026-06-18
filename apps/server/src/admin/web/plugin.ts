/**
 * Admin dashboard plugin — read-only, server-rendered HTML, behind
 * Basic Auth.
 *
 * The plugin is **disabled by default**: if either ADMIN_USER or
 * ADMIN_PASSWORD_HASH is unset, no /admin/* route is registered, so
 * every probe returns 404 and there's no auth surface to attack.
 *
 * If both are set:
 *   - all /admin/* routes require Basic Auth (HTTP 401 otherwise)
 *   - password compare goes through async scrypt + timingSafeEqual,
 *     so the ~50ms derivation runs on libuv's thread pool instead of
 *     blocking the main event loop
 *   - usernames are constant-time-compared too
 *   - a per-IP rate limit (10 attempts / 5 min by default — see
 *     RATE_LIMIT_ADMIN_PER_IP_PER_5MIN) runs BEFORE basic-auth so
 *     brute-forcers never reach the scrypt path
 *   - a strict CSP and a few hardening headers are set on every
 *     /admin response, including 401 and 429 — applied via onSend
 *     so they ride along with @fastify/basic-auth's auto-401 too
 *   - the Basic Auth realm is a generic "Restricted" so phishing
 *     prompts can't lean on a product-specific hint
 *   - no write actions exist in v0.3 PR 2 (read-only)
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import basicAuth from "@fastify/basic-auth";
import { Eta } from "eta";
import fp from "fastify-plugin";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { config } from "../../config.js";
import { rateLimited } from "../../lib/errors.js";
import { rateCheck } from "../../services/rateLimit.js";
import { verifyAdminPassword } from "./passwords.js";
import {
  fetchHealth,
  fetchInbound,
  fetchOverview,
  fetchReceivers,
  fetchVerifications,
} from "./queries.js";
import { maskInboundBody, maskPhone, relativeTime, shortId } from "./masks.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// At runtime via tsc this file lives at dist/admin/web/plugin.js, and
// the templates ship at src/admin/views/ → dist/admin/views/. Resolve
// the views directory robustly: try the dist layout first, fall back
// to src for tsx-driven test runs.
function resolveViewsDir(): string {
  const candidates = [
    join(__dirname, "..", "views"),                // dist/admin/web/.. /views
    join(__dirname, "..", "..", "..", "src", "admin", "views"), // dist → src
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!;
}

// Env is read at register time (each buildApp() call), not from the
// frozen config snapshot. This lets tests toggle admin on/off by
// setting / unsetting ADMIN_USER / ADMIN_PASSWORD_HASH before calling
// buildApp() — config.ts freezes its values on first import, but each
// buildApp() invocation re-runs this plugin function. The format
// check matches config.ts, inlined here so the plugin's runtime
// behavior matches its boot-time validation.
const HASH_RE = /^scrypt\$[0-9a-fA-F]{16,128}\$[0-9a-fA-F]{32,256}$/;

// 5-minute window for the per-IP admin rate limit. Hoisted as a
// constant so the bucket math is obvious at the rateCheck call site.
const ADMIN_RL_WINDOW_SECONDS = 5 * 60;

// Hardening headers applied to EVERY /admin/* response — success, 401
// from basic-auth, 429 from our rate limiter, and 5xx from the error
// handler. Centralized so each header has exactly one definition.
function applyHardeningHeaders(reply: FastifyReply): void {
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Cache-Control", "no-store");
  // No external resources, no scripts (server-rendered HTML + inline
  // CSS only). `'unsafe-inline'` for style covers the inline <style>
  // in _layout.eta; script-src is omitted, so default-src 'none'
  // blocks all script execution.
  reply.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
}

export const adminPlugin = fp(async function adminPlugin(app: FastifyInstance): Promise<void> {
  const user = process.env.ADMIN_USER ?? "";
  const hash = process.env.ADMIN_PASSWORD_HASH ?? "";

  // Disabled-by-default: don't even mount the routes if creds aren't
  // configured. /admin/* will 404 with no hint that the dashboard exists.
  if (!user || !hash || !HASH_RE.test(hash)) {
    app.log.info(
      { reason: !user ? "no_user" : !hash ? "no_hash" : "bad_hash_format" },
      "admin dashboard disabled",
    );
    return;
  }

  // Username compare — constant-time-ish. Pad with zero buffer when
  // length differs so timing doesn't reveal the configured length.
  const expectedUserBuf = Buffer.from(user, "utf8");
  const compareUser = (candidate: string): boolean => {
    const cb = Buffer.from(candidate, "utf8");
    if (cb.length !== expectedUserBuf.length) {
      const filler = Buffer.alloc(expectedUserBuf.length);
      timingSafeEqual(expectedUserBuf, filler);
      return false;
    }
    return timingSafeEqual(cb, expectedUserBuf);
  };

  // Eta renderer with a stable views dir.
  const eta = new Eta({ views: resolveViewsDir(), cache: true, autoEscape: true });
  const helpers = { maskPhone, maskInboundBody, shortId, relativeTime };

  // Mount /admin/* routes inside an isolated Fastify scope. basicAuth
  // is registered ON the scope and added as the scope's onRequest hook,
  // so its 401-with-WWW-Authenticate response runs naturally inside the
  // hook chain. Wiring it via `app.basicAuth(req, reply, done)` from a
  // wrapping hook bypasses the auto-401 path and surfaces "invalid
  // credentials" as a 500 through the global error handler.
  await app.register(async function adminScope(scope) {
    await scope.register(basicAuth, {
      // Async form: scrypt is awaited so the ~50ms derivation runs on
      // libuv's thread pool instead of blocking the main event loop.
      // The constant-time-anti-username-oracle behavior is preserved:
      // both compares ALWAYS run before the decision, regardless of
      // which half failed first.
      async validate(username, password, _req, _reply) {
        const userOk = compareUser(username);
        const passOk = await verifyAdminPassword(hash, password);
        if (userOk && passOk) return;
        // Generic message so the response can't tell which half failed.
        throw new Error("invalid credentials");
      },
      // Generic realm — a SYROTP-specific string would help a phishing
      // page mimic the prompt convincingly. "Restricted" matches the
      // RFC 7235 examples and reveals nothing about the product.
      authenticate: { realm: "Restricted" },
    });

    // Hardening headers on EVERY response in this scope — success,
    // 401 from basic-auth's auto-reject, 429 from the rate limiter,
    // and any 5xx from the global error handler. onSend runs after
    // the response status is decided but before it's flushed, which
    // is the only place that catches all of them. We also set a
    // sensible default Content-Type for HTML routes; JSON routes
    // (e.g. /admin/abuse-signals) override it explicitly.
    scope.addHook("onSend", async (_req, reply, payload) => {
      applyHardeningHeaders(reply);
      if (!reply.getHeader("Content-Type")) {
        reply.header("Content-Type", "text/html; charset=utf-8");
      }
      return payload;
    });

    // Per-IP rate limit — runs BEFORE basic-auth so brute-forcers
    // never reach the scrypt path. The bucket uses `req.ip`, which
    // honors `trustProxy` (configured at app boot) — without it,
    // req.ip is the socket peer address; with it, the leftmost
    // untrusted X-Forwarded-For hop. Both are the right granularity
    // for an attacker-distinguishing throttle. Fastify runs
    // onRequest hooks in registration order, so this hook MUST be
    // added before the `scope.basicAuth` hook a few lines below for
    // the rate limit to gate the password compare.
    scope.addHook("onRequest", async (req, reply) => {
      const ip = req.ip;
      const rl = await rateCheck(
        `admin:ip:${ip}`,
        config.RATE_LIMIT_ADMIN_PER_IP_PER_5MIN,
        ADMIN_RL_WINDOW_SECONDS,
      );
      if (!rl.allowed) {
        // Log but don't increment the syrotp_rate_limited_total
        // counter — its label set is closed and admin auth isn't
        // one of the documented buckets. Operators can track this
        // in the access log if needed.
        req.log.warn(
          { ip, path: req.url, bucket: "admin", resetSeconds: rl.resetSeconds },
          "admin rate limit exceeded",
        );
        // Pre-apply hardening headers — the onSend hook will also
        // apply them, but doing it here makes the intent obvious.
        applyHardeningHeaders(reply);
        throw rateLimited(rl.resetSeconds);
      }
    });

    // Auth before every route in this scope. Registered AFTER the
    // rate-limit hook above so Fastify runs the rate-limit check
    // first (onRequest hooks run in registration order).
    scope.addHook("onRequest", scope.basicAuth);

    scope.get("/admin", async (_req, reply) => {
      const overview = await fetchOverview();
      return renderPage(eta, reply, "dashboard", "Overview", "dashboard", { overview, ...helpers });
    });

    scope.get("/admin/receivers", async (_req, reply) => {
      const rows = await fetchReceivers();
      return renderPage(eta, reply, "receivers", "Receivers", "receivers", { rows, ...helpers });
    });

    scope.get("/admin/verifications", async (_req, reply) => {
      const rows = await fetchVerifications();
      return renderPage(eta, reply, "verifications", "Verifications", "verifications", { rows, ...helpers });
    });

    scope.get("/admin/inbound-sms", async (_req, reply) => {
      const rows = await fetchInbound();
      return renderPage(eta, reply, "inbound-sms", "Inbound SMS", "inbound-sms", { rows, ...helpers });
    });

    scope.get("/admin/health", async (_req, reply) => {
      const h = await fetchHealth();
      return renderPage(eta, reply, "health", "Health", "health", { h });
    });

    // v0.8 PR #39 — abuse-signals JSON endpoint. Per-app +
    // per-receiver detail kept off the Prometheus surface to
    // respect the project's metric-cardinality discipline; ops
    // dashboards / scripts hit this instead. The cached value
    // updates every 60s via the refresh loop in
    // services/abuseSignals.ts.
    scope.get("/admin/abuse-signals", async (_req, reply) => {
      const { getCachedSignals, computeSignals } = await import(
        "../../services/abuseSignals.js"
      );
      // Boot races: if the first refresh hasn't landed yet, compute
      // on demand. The query is cheap and only runs once.
      const signals = getCachedSignals() ?? (await computeSignals());
      reply.header("Content-Type", "application/json; charset=utf-8");
      return signals;
    });
  });
}, { name: "syrotp-admin" });

async function renderPage(
  eta: Eta,
  reply: FastifyReply,
  template: string,
  title: string,
  active: string,
  data: Record<string, unknown>,
): Promise<string> {
  const body = await eta.renderAsync(template, data);
  const html = await eta.renderAsync("_layout", {
    title,
    active,
    body,
    version: process.env.npm_package_version ?? "0.1.0",
    now: new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC",
  });
  void reply;
  return html;
}
