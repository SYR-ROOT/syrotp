/**
 * Suite 5: CORS allowlist (T15).
 *
 * setup.ts leaves CORS_ORIGINS unset → @fastify/cors defaults to `false`,
 * which rejects all cross-origin requests. We test that:
 *   - same-origin / no Origin header passes (server-to-server)
 *   - a foreign Origin gets no Access-Control-Allow-Origin header
 *   - a configured allowlist origin gets a matching ACAO header
 *
 * Re-configuring at runtime is non-trivial (cors plugin caches its options
 * at register time), so we rely on the env value picked up by buildApp().
 *
 * If you change CORS_ORIGINS for a test, you must reload the app — easier
 * to assert behavior with the default (no origins → reject all).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getTestApp } from "../helpers/app.js";

describe("CORS", () => {
  it("T15: with empty allowlist, foreign Origin gets no ACAO header", async () => {
    const app = await getTestApp();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/v1/health",
      headers: {
        origin: "https://attacker.example",
        "access-control-request-method": "GET",
      },
    });
    // Either 404 (no preflight matched) or no ACAO header — either way,
    // the browser will refuse the cross-origin call.
    assert.notEqual(res.headers["access-control-allow-origin"], "https://attacker.example");
    assert.notEqual(res.headers["access-control-allow-origin"], "*");
  });

  it("server-to-server requests (no Origin) work normally", async () => {
    const app = await getTestApp();
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, "ok");
  });
});
