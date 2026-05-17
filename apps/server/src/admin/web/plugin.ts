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
 *   - password compare goes through scrypt + timingSafeEqual
 *   - usernames are constant-time-compared too
 *   - a strict CSP and a few hardening headers are set on every
 *     /admin response
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
      validate(username, password, _req, _reply, done) {
        const userOk = compareUser(username);
        const passOk = verifyAdminPassword(hash, password);
        // Always run BOTH compares before deciding — defense against a
        // username-existence timing oracle.
        if (userOk && passOk) {
          done();
          return;
        }
        // Generic message so the response can't tell which half failed.
        done(new Error("invalid credentials"));
      },
      authenticate: { realm: "SYROTP admin" },
    });

    // Auth before every route in this scope.
    scope.addHook("onRequest", scope.basicAuth);

    // Hardening headers on every response from this scope.
    scope.addHook("preHandler", async (_req, reply) => {
      reply
        .header("Content-Type", "text/html; charset=utf-8")
        .header("X-Frame-Options", "DENY")
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header("Cache-Control", "private, no-store")
        .header(
          "Content-Security-Policy",
          // No external resources, no scripts (server-rendered HTML +
          // inline CSS only). `'unsafe-inline'` for style covers the
          // inline <style> in _layout.eta; script-src is omitted, so
          // default-src 'none' blocks all script execution.
          "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        );
    });

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
      reply.header("Cache-Control", "private, no-store");
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
