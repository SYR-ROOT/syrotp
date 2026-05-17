/**
 * OpenAPI contract drift — path coverage only.
 *
 * Asserts that every JSON-API path the server actually registers is
 * documented in `openapi.yaml`, modulo a small allowlist of surfaces
 * that are intentionally out of the wire-contract spec (operator HTML,
 * Prometheus exposition, the end-user hosted page).
 *
 * This is the v1.0-rc.1 sentinel: the openapi.yaml realignment audit
 * (PR #46) brought the spec back in sync with the server, and this
 * test fails any future PR that adds a route without also documenting
 * it. Schema-level validation is intentionally out of scope here —
 * deeper schema/error-shape conformance lands in PR #47.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// apps/server/test/suites/openapiContract.ts → repo root → openapi.yaml
const OPENAPI_PATH = resolve(__dirname, "..", "..", "..", "..", "openapi.yaml");

/**
 * Surfaces that are deliberately NOT in the wire-contract spec. Each
 * entry is a regex matched against the server-registered URL. Adding
 * to this list is a deliberate scope decision — when in doubt, prefer
 * documenting in openapi.yaml.
 */
const OUT_OF_CONTRACT: RegExp[] = [
  /^\/metrics$/,             // Prometheus text/plain — operational
  /^\/v\/\{id\}$/,           // hosted-page HTML for end users (status JSON IS documented)
  /^\/admin(\/.*)?$/,        // operator dashboard (HTML + admin JSON, BasicAuth)
  /^\*$/,                    // Fastify wildcard registered by @fastify/cors for OPTIONS preflight
];

/**
 * Extract the top-level path keys from openapi.yaml. The structure is
 * stable enough that a small line-oriented parser beats pulling in a
 * YAML dependency for one test. Looks for two-space-indented keys
 * inside the `paths:` block that begin with `/` and end with `:`.
 */
function readDocumentedPaths(yamlText: string): Set<string> {
  const lines = yamlText.split(/\r?\n/);
  const out = new Set<string>();
  let inPaths = false;
  for (const raw of lines) {
    if (/^paths:\s*$/.test(raw)) {
      inPaths = true;
      continue;
    }
    if (inPaths) {
      // A new top-level section ends the paths block.
      if (/^[A-Za-z_]/.test(raw)) break;
      // Path entries: exactly two leading spaces, slash, then `:` at end.
      const m = raw.match(/^ {2}(\/[A-Za-z0-9_\-{}/.:]*):\s*$/);
      if (m) out.add(m[1]!);
    }
  }
  return out;
}

/**
 * Convert a Fastify-style URL (`/v1/verifications/:id`) to OpenAPI
 * style (`/v1/verifications/{id}`). Method we don't bother with —
 * path coverage is enough for v1.0-rc.1.
 */
function fastifyUrlToOpenApi(url: string): string {
  return url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

describe("OpenAPI contract — path coverage", () => {
  let registered: Set<string>;
  let documented: Set<string>;
  let inspector: FastifyInstance;

  before(async () => {
    const captured: string[] = [];
    inspector = await buildApp({
      onRoute: (r) => {
        // Skip HEAD — Fastify auto-registers HEAD next to GET, and the
        // contract doc does not separately list HEAD entries.
        const method = Array.isArray(r.method) ? r.method[0]! : r.method;
        if (method === "HEAD") return;
        captured.push(r.url);
      },
    });
    await inspector.ready();
    registered = new Set(captured.map(fastifyUrlToOpenApi));
    const yamlText = readFileSync(OPENAPI_PATH, "utf8");
    documented = readDocumentedPaths(yamlText);
  });

  after(async () => {
    await inspector.close();
  });

  it("openapi.yaml has at least one documented path (sanity check)", () => {
    assert.ok(documented.size > 0, "no paths parsed out of openapi.yaml — parser drift?");
  });

  it("the server actually registered some routes (sanity check)", () => {
    assert.ok(registered.size > 0, "no routes captured — onRoute hook drift?");
  });

  it("every server-registered path is documented in openapi.yaml (or explicitly out of contract)", () => {
    const missing: string[] = [];
    for (const url of registered) {
      if (documented.has(url)) continue;
      if (OUT_OF_CONTRACT.some((re) => re.test(url))) continue;
      missing.push(url);
    }
    assert.deepEqual(
      missing,
      [],
      `Routes registered by the server but missing from openapi.yaml:\n  ${missing.join("\n  ")}\n` +
        `Either document them in openapi.yaml or add an entry to OUT_OF_CONTRACT in this file.`,
    );
  });

  it("every path documented in openapi.yaml maps to a real registered route", () => {
    const stale: string[] = [];
    for (const url of documented) {
      if (registered.has(url)) continue;
      stale.push(url);
    }
    assert.deepEqual(
      stale,
      [],
      `Paths documented in openapi.yaml but NOT registered by the server:\n  ${stale.join("\n  ")}\n` +
        `Either remove them from openapi.yaml or wire up the route.`,
    );
  });
});
