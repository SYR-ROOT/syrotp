import type { FastifyInstance } from "fastify";

const startedAt = Date.now();

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/health", async () => ({
    status: "ok" as const,
    version: process.env.npm_package_version ?? "0.1.0",
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
  }));
}
