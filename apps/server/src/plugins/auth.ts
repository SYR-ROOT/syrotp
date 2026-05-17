import type { FastifyInstance, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { lookupApiKey, type AuthedKey } from "../services/apiKeys.js";
import { unauthorized, forbidden } from "../lib/errors.js";
import { metrics } from "../services/metrics.js";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthedKey;
  }
}

/**
 * Extract a bearer token from Authorization header. Returns null if absent
 * or malformed. Does NOT throw — callers decide whether absence is fatal.
 */
function extractBearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || typeof h !== "string") return null;
  if (!h.startsWith("Bearer ")) return null;
  const tok = h.slice(7).trim();
  return tok.length > 0 ? tok : null;
}

// Wrapped with `fp` so the decorations are visible to sibling plugins
// (the route plugins). Without this, Fastify encapsulates the decoration
// inside this plugin's scope and `app.requireKey` is undefined elsewhere.
export const authPlugin = fp(async function authPlugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest("auth", undefined);

  // Verify a key is present and resolves. Callers further restrict by kind.
  app.decorate(
    "requireKey",
    async function (
      req: FastifyRequest,
      allowed: ReadonlyArray<AuthedKey["kind"]>,
    ): Promise<AuthedKey> {
      const tok = extractBearer(req);
      if (!tok) {
        metrics.apiKeyRejected("missing");
        throw unauthorized();
      }
      const key = await lookupApiKey(tok);
      if (!key) {
        // lookupApiKey collapses every "not a known live key" path into
        // null — we don't try to distinguish revoked vs unknown vs
        // app-disabled at the metrics layer (they're all
        // "auth-rejected") to avoid leaking shape via timing.
        metrics.apiKeyRejected("unknown");
        throw unauthorized();
      }
      if (!allowed.includes(key.kind)) {
        metrics.apiKeyRejected("wrong_kind");
        throw forbidden("key kind not permitted for this endpoint");
      }
      req.auth = key;
      return key;
    },
  );
}, { name: "syrotp-auth" });

declare module "fastify" {
  interface FastifyInstance {
    requireKey(
      req: FastifyRequest,
      allowed: ReadonlyArray<AuthedKey["kind"]>,
    ): Promise<AuthedKey>;
  }
}
