/**
 * Suite 6: log redaction (T16).
 *
 * Every log line emitted while serving a request must NEVER contain:
 *   - the raw API key
 *   - the X-SYROTP-Signature value
 *
 * We capture stdout (where pino writes) for the duration of one request
 * and grep the captured lines.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { resetDatabase } from "../helpers/db.js";
import { resetRedis } from "../helpers/redis.js";
import { createTestApp } from "../helpers/fixtures.js";
import { getTestApp } from "../helpers/app.js";
import { startCapture, stopCapture } from "../helpers/logCapture.js";
import { inboundBody, signGateway } from "../helpers/sign.js";

describe("log redaction", () => {
  let captured: string[] = [];

  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  afterEach(() => {
    if (captured.length === 0) stopCapture();
  });

  it("T16: secret headers do not appear in logs", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();
    // Bump log level so the request gets logged.
    app.log.level = "info";

    // Declared outside the try block so the post-try assertions can
    // reference the signed headers (the original placement put `headers`
    // inside the try and produced a ReferenceError after stopCapture).
    let headers: Record<string, string> | null = null;

    startCapture();
    try {
      const start = await app.inject({
        method: "POST",
        url: "/v1/verifications",
        headers: { authorization: `Bearer ${fx.secretKey}` },
        payload: { phone: "0991234567", purpose: "login" },
      });
      assert.equal(start.statusCode, 201);
      const v = start.json();

      const body = inboundBody({
        from: "+963991234567",
        to: fx.receiverMsisdn,
        body: v.message,
      });
      headers = signGateway(fx.receiverId, fx.signingKey, body);
      const r = await app.inject({
        method: "POST",
        url: "/v1/inbound/sms",
        headers,
        payload: body,
      });
      assert.equal(r.statusCode, 202);

      captured = stopCapture();
    } finally {
      // Restore in case of throw.
      stopCapture();
      app.log.level = "warn";
    }

    const blob = captured.join("\n");
    // The redactor wraps matched values with "[REDACTED]". The actual key
    // string must never appear verbatim.
    assert.ok(
      !blob.includes(fx.secretKey),
      "raw secret key leaked into logs",
    );
    if (headers === null) {
      assert.fail("signed headers should have been set inside the try");
    }
    assert.ok(
      !blob.includes(headersOf(headers, "x-syrotp-signature")),
      "raw X-SYROTP-Signature leaked into logs",
    );
  });
});

function headersOf(h: Record<string, string>, k: string): string {
  return h[k] ?? "";
}
