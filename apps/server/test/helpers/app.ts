/**
 * Build a Fastify app suitable for `app.inject()` testing — much faster
 * than a real listening server and gives us deterministic responses.
 *
 * We re-use the production buildApp() so tests exercise the same plugin
 * pipeline, error handler, redaction config, etc.
 */
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";

let cached: FastifyInstance | null = null;

export async function getTestApp(): Promise<FastifyInstance> {
  if (cached) return cached;
  cached = await buildApp();
  await cached.ready();
  return cached;
}

export async function closeTestApp(): Promise<void> {
  if (!cached) return;
  await cached.close();
  cached = null;
}
