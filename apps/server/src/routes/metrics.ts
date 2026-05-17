import type { FastifyInstance } from "fastify";
import { renderMetrics } from "../services/metrics.js";

/**
 * GET /metrics — Prometheus exposition format.
 *
 * Public on the assumption that the operator's reverse proxy / WAF
 * restricts it to the Prometheus scraper's IP (or simply doesn't
 * expose the whole API surface to the public). We don't add auth
 * here because that's a deployment concern, not a protocol concern,
 * and adding it would force every Prometheus operator to configure
 * a token.
 *
 * If you need auth, terminate it at the proxy:
 *   nginx allow 10.0.0.0/8; deny all;  → /metrics location
 *   or basic-auth on /metrics only.
 */
export async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/metrics", async (_req, reply) => {
    const { contentType, body } = await renderMetrics();
    reply.header("Content-Type", contentType).send(body);
  });
}
