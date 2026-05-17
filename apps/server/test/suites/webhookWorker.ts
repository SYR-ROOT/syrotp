/**
 * Suite 13: webhook delivery worker (PR #20B).
 *
 * Pins the outbound contract end-to-end: a real `http.createServer`
 * receiver, real HTTP between the worker and that receiver, and the
 * status / retry / signature properties asserted from both sides.
 *
 *   WD1   end-to-end happy path → status=delivered, headers + signature OK
 *   WD2   byte-flip on the wire breaks the receiver-side signature check
 *   WD3   5xx → retry with next_attempt_at scheduled per the table
 *   WD4   429 → retry (rate-limited, same schedule as 5xx)
 *   WD5   4xx (non-429) → status=failed, no retry
 *   WD6   network error / refused → retry
 *   WD7   max attempts exhausted → status=abandoned
 *   WD8   endpoint disabled mid-queue → status=abandoned, NO HTTP
 *   WD9   all five X-SYROTP-Webhook-* headers + content-type present
 *   WD10  outbound body has NO raw E.164, OTP, api_key, receiver id, signing key
 *   WD11  fan-out: one event → N endpoints → N HTTP requests
 *   WD12  attempt_count increments and last_status_code/last_error are recorded
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { resetDatabase } from "../helpers/db.js";
import { resetRedis } from "../helpers/redis.js";
import { createTestApp } from "../helpers/fixtures.js";
import { getTestApp } from "../helpers/app.js";
import { inboundBody, signGateway } from "../helpers/sign.js";
import { startTestReceiver, verifySignature } from "../helpers/webhookReceiver.js";
import { unwrap } from "../../src/lib/aead.js";
import { config } from "../../src/config.js";

interface DeliveryRow {
  id: string;
  status: string;
  attempt_count: number;
  next_attempt_at: Date;
  last_status_code: number | null;
  last_error: string | null;
}
interface EndpointRow {
  id: string;
  secret_ciphertext: string;
}

async function dbq<T>(text: string, params: unknown[] = []): Promise<T[]> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    return (await sql.unsafe<T[]>(text, params as never)) as T[];
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function registerEndpoint(secretKey: string, url: string, eventTypes = ["verification.verified"]): Promise<{ id: string; secret: string }> {
  const app = await getTestApp();
  const r = await app.inject({
    method: "POST",
    url: "/v1/webhooks",
    headers: { authorization: `Bearer ${secretKey}` },
    payload: { url, event_types: eventTypes },
  });
  assert.equal(r.statusCode, 201, `create webhook failed: ${r.body}`);
  const body = r.json();
  return { id: body.id, secret: body.secret };
}

async function emitVerifiedEvent(fxPublicKey: string, fxReceiverId: string, fxSigningKey: string, fxReceiverMsisdn: string): Promise<void> {
  const app = await getTestApp();
  const start = await app.inject({
    method: "POST",
    url: "/v1/verifications",
    headers: { authorization: `Bearer ${fxPublicKey}` },
    payload: { phone: "0991234567", purpose: "login" },
  });
  const v = start.json();
  const body = inboundBody({
    from: "+963991234567",
    to: fxReceiverMsisdn,
    body: v.message,
  });
  const headers = signGateway(fxReceiverId, fxSigningKey, body);
  const r = await app.inject({ method: "POST", url: "/v1/inbound/sms", headers, payload: body });
  assert.equal(r.statusCode, 202);
}

describe("webhook delivery worker (PR 20B)", () => {
  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  // ----- WD1: happy path ----------------------------------------------

  it("WD1: end-to-end happy path → status=delivered with valid headers + signature", async () => {
    const fx = await createTestApp();
    const recv = await startTestReceiver();
    try {
      const ep = await registerEndpoint(fx.secretKey, recv.url);
      await emitVerifiedEvent(fx.publicKey, fx.receiverId, fx.signingKey, fx.receiverMsisdn);

      const app = await getTestApp();
      await app.webhookWorker.runOnce();

      assert.equal(recv.requests.length, 1, "receiver should have got exactly one request");
      const req = recv.requests[0]!;

      // Headers contract
      assert.equal(req.method, "POST");
      assert.match(String(req.headers["content-type"]), /^application\/json/);
      const wid = String(req.headers["x-syrotp-webhook-id"] ?? "");
      const wts = String(req.headers["x-syrotp-webhook-timestamp"] ?? "");
      const wsig = String(req.headers["x-syrotp-webhook-signature"] ?? "");
      const wevt = String(req.headers["x-syrotp-webhook-event"] ?? "");
      const watt = String(req.headers["x-syrotp-webhook-attempt"] ?? "");
      assert.match(wid, /^wd_[A-Za-z0-9]+$/);
      assert.match(wts, /^\d+$/);
      assert.match(wsig, /^[a-f0-9]{64}$/);
      assert.equal(wevt, "verification.verified");
      assert.equal(watt, "1");

      // Signature check (verify against the secret we got from the
      // create response — receivers verify the same way).
      assert.ok(verifySignature(ep.secret, req.body, wts, wsig), "signature must verify");

      // Body shape sanity
      const env = JSON.parse(req.body);
      assert.equal(env.type, "verification.verified");
      assert.match(env.id, /^evt_[A-Za-z0-9]+$/);
      assert.equal(env.data.status, "verified");
      assert.equal(env.data.phone_masked, "+96399****567");

      // DB delivery row → delivered
      const deliveries = await dbq<DeliveryRow>(`SELECT id, status, attempt_count, last_status_code FROM webhook_deliveries`);
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0]!.status, "delivered");
      assert.equal(deliveries[0]!.attempt_count, 1);
      assert.equal(deliveries[0]!.last_status_code, 200);
    } finally {
      await recv.close();
    }
  });

  // ----- WD2: byte-flip breaks signature ------------------------------

  it("WD2: a flipped byte on the wire breaks receiver-side signature verification", async () => {
    const fx = await createTestApp();
    const recv = await startTestReceiver();
    try {
      const ep = await registerEndpoint(fx.secretKey, recv.url);
      await emitVerifiedEvent(fx.publicKey, fx.receiverId, fx.signingKey, fx.receiverMsisdn);

      const app = await getTestApp();
      await app.webhookWorker.runOnce();

      const req = recv.requests[0]!;
      const wts = String(req.headers["x-syrotp-webhook-timestamp"]);
      const wsig = String(req.headers["x-syrotp-webhook-signature"]);
      // Untouched body verifies.
      assert.ok(verifySignature(ep.secret, req.body, wts, wsig));
      // Flip one byte: the signature MUST NOT verify.
      const tampered = req.body.replace(/"verified"/, '"verifiex"');
      assert.notEqual(tampered, req.body, "tampered body must differ");
      assert.ok(!verifySignature(ep.secret, tampered, wts, wsig), "byte-flip must break signature");
    } finally {
      await recv.close();
    }
  });

  // ----- WD3: 5xx → retry --------------------------------------------

  it("WD3: 5xx response → status stays pending, attempt_count increments, next_attempt_at scheduled", async () => {
    const fx = await createTestApp();
    const recv = await startTestReceiver();
    try {
      recv.setHandler((_req, res) => {
        res.statusCode = 503;
        res.end("upstream unavailable");
      });
      await registerEndpoint(fx.secretKey, recv.url);
      await emitVerifiedEvent(fx.publicKey, fx.receiverId, fx.signingKey, fx.receiverMsisdn);

      const app = await getTestApp();
      await app.webhookWorker.runOnce();

      const deliveries = await dbq<DeliveryRow>(
        `SELECT id, status, attempt_count, next_attempt_at, last_status_code, last_error
         FROM webhook_deliveries`,
      );
      assert.equal(deliveries.length, 1);
      const d = deliveries[0]!;
      assert.equal(d.status, "pending");
      assert.equal(d.attempt_count, 1);
      assert.equal(d.last_status_code, 503);
      // After 1st failure, next attempt is 30s out per the schedule.
      const ms = new Date(d.next_attempt_at).getTime() - Date.now();
      assert.ok(ms > 20_000 && ms < 60_000, `expected ~30s ahead, got ${ms}ms`);
    } finally {
      await recv.close();
    }
  });

  // ----- WD4: 429 → retry --------------------------------------------

  it("WD4: 429 response → retry (same path as 5xx)", async () => {
    const fx = await createTestApp();
    const recv = await startTestReceiver();
    try {
      recv.setHandler((_req, res) => {
        res.statusCode = 429;
        res.end();
      });
      await registerEndpoint(fx.secretKey, recv.url);
      await emitVerifiedEvent(fx.publicKey, fx.receiverId, fx.signingKey, fx.receiverMsisdn);

      const app = await getTestApp();
      await app.webhookWorker.runOnce();

      const deliveries = await dbq<DeliveryRow>(`SELECT status, last_status_code FROM webhook_deliveries`);
      assert.equal(deliveries[0]!.status, "pending");
      assert.equal(deliveries[0]!.last_status_code, 429);
    } finally {
      await recv.close();
    }
  });

  // ----- WD5: 4xx (non-429) → fail -----------------------------------

  it("WD5: 4xx (non-429) → status=failed, no retry", async () => {
    const fx = await createTestApp();
    const recv = await startTestReceiver();
    try {
      recv.setHandler((_req, res) => {
        res.statusCode = 400;
        res.end();
      });
      await registerEndpoint(fx.secretKey, recv.url);
      await emitVerifiedEvent(fx.publicKey, fx.receiverId, fx.signingKey, fx.receiverMsisdn);

      const app = await getTestApp();
      await app.webhookWorker.runOnce();

      const deliveries = await dbq<DeliveryRow>(`SELECT status, last_status_code FROM webhook_deliveries`);
      assert.equal(deliveries[0]!.status, "failed");
      assert.equal(deliveries[0]!.last_status_code, 400);
    } finally {
      await recv.close();
    }
  });

  // ----- WD6: network error → retry ----------------------------------

  it("WD6: connection refused → retry", async () => {
    const fx = await createTestApp();
    // Start + immediately close the receiver — the URL still resolves
    // syntactically but no socket is listening.
    const recv = await startTestReceiver();
    const url = recv.url;
    await recv.close();

    await registerEndpoint(fx.secretKey, url);
    await emitVerifiedEvent(fx.publicKey, fx.receiverId, fx.signingKey, fx.receiverMsisdn);

    const app = await getTestApp();
    await app.webhookWorker.runOnce();

    const deliveries = await dbq<DeliveryRow>(`SELECT status, attempt_count, last_status_code, last_error FROM webhook_deliveries`);
    assert.equal(deliveries[0]!.status, "pending", "network error must retry");
    assert.equal(deliveries[0]!.attempt_count, 1);
    assert.equal(deliveries[0]!.last_status_code, null);
    assert.ok(deliveries[0]!.last_error && deliveries[0]!.last_error.length > 0);
  });

  // ----- WD7: budget exhausted → abandoned ---------------------------

  it("WD7: max attempts exhausted → status=abandoned", async () => {
    const fx = await createTestApp();
    const recv = await startTestReceiver();
    try {
      recv.setHandler((_req, res) => {
        res.statusCode = 503;
        res.end();
      });
      await registerEndpoint(fx.secretKey, recv.url);
      await emitVerifiedEvent(fx.publicKey, fx.receiverId, fx.signingKey, fx.receiverMsisdn);

      const app = await getTestApp();

      // Cycle: each runOnce sees the row as due (we force next_attempt_at <= now()
      // between ticks) so the worker processes it. After 6 attempts we expect
      // status=abandoned.
      for (let i = 0; i < 7; i++) {
        await dbq(
          `UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second'
           WHERE status = 'pending'`,
        );
        await app.webhookWorker.runOnce();
      }

      const deliveries = await dbq<DeliveryRow>(`SELECT status, attempt_count FROM webhook_deliveries`);
      assert.equal(deliveries[0]!.status, "abandoned");
      assert.equal(deliveries[0]!.attempt_count, 6);
    } finally {
      await recv.close();
    }
  });

  // ----- WD8: endpoint disabled → abandon, no HTTP -------------------

  it("WD8: endpoint disabled mid-queue → status=abandoned, NO outbound HTTP", async () => {
    const fx = await createTestApp();
    const recv = await startTestReceiver();
    try {
      const ep = await registerEndpoint(fx.secretKey, recv.url);
      await emitVerifiedEvent(fx.publicKey, fx.receiverId, fx.signingKey, fx.receiverMsisdn);

      // Disable the endpoint AFTER the delivery row was queued.
      await dbq(`UPDATE webhook_endpoints SET enabled = false WHERE id = $1`, [ep.id]);

      const app = await getTestApp();
      await app.webhookWorker.runOnce();

      assert.equal(recv.requests.length, 0, "no outbound request when endpoint disabled");
      const deliveries = await dbq<DeliveryRow>(`SELECT status, last_error FROM webhook_deliveries`);
      assert.equal(deliveries[0]!.status, "abandoned");
      assert.equal(deliveries[0]!.last_error, "endpoint_disabled");
    } finally {
      await recv.close();
    }
  });

  // ----- WD9: header contract ----------------------------------------

  it("WD9: required headers + content-type present on every outbound request", async () => {
    const fx = await createTestApp();
    const recv = await startTestReceiver();
    try {
      await registerEndpoint(fx.secretKey, recv.url);
      await emitVerifiedEvent(fx.publicKey, fx.receiverId, fx.signingKey, fx.receiverMsisdn);

      const app = await getTestApp();
      await app.webhookWorker.runOnce();

      const req = recv.requests[0]!;
      for (const h of [
        "x-syrotp-webhook-id",
        "x-syrotp-webhook-timestamp",
        "x-syrotp-webhook-signature",
        "x-syrotp-webhook-event",
        "x-syrotp-webhook-attempt",
        "content-type",
      ]) {
        const v = req.headers[h];
        assert.ok(v && String(v).length > 0, `missing header: ${h}`);
      }
    } finally {
      await recv.close();
    }
  });

  // ----- WD10: outbound body safety canaries -------------------------

  it("WD10: outbound body has NO raw E.164, OTP, api_key, receiver id, signing key", async () => {
    const fx = await createTestApp();
    const recv = await startTestReceiver();
    try {
      await registerEndpoint(fx.secretKey, recv.url);

      const appI = await getTestApp();
      const start = await appI.inject({
        method: "POST",
        url: "/v1/verifications",
        headers: { authorization: `Bearer ${fx.publicKey}` },
        payload: { phone: "0991234567", purpose: "login" },
      });
      const v = start.json();
      const code = v.message.split(" ").pop()!;

      const body = inboundBody({
        from: "+963991234567",
        to: fx.receiverMsisdn,
        body: v.message,
      });
      const headers = signGateway(fx.receiverId, fx.signingKey, body);
      await appI.inject({ method: "POST", url: "/v1/inbound/sms", headers, payload: body });

      const app = await getTestApp();
      await app.webhookWorker.runOnce();

      const raw = recv.requests[0]!.body;
      assert.ok(!raw.includes("+963991234567"), "raw E.164 must not appear in webhook body");
      assert.ok(!raw.includes(code), "OTP code must not appear");
      assert.ok(!raw.includes(fx.publicKey), "publicKey must not appear");
      assert.ok(!raw.includes(fx.secretKey), "secretKey must not appear");
      assert.ok(!raw.includes(fx.receiverId), "receiver id must not appear");
      assert.ok(!raw.includes(fx.signingKey), "gateway signing key must not appear");
    } finally {
      await recv.close();
    }
  });

  // ----- WD11: fan-out -----------------------------------------------

  it("WD11: one event → N endpoints → N HTTP requests", async () => {
    const fx = await createTestApp();
    const recvA = await startTestReceiver();
    const recvB = await startTestReceiver();
    const recvC = await startTestReceiver();
    try {
      await registerEndpoint(fx.secretKey, recvA.url);
      await registerEndpoint(fx.secretKey, recvB.url);
      await registerEndpoint(fx.secretKey, recvC.url);
      await emitVerifiedEvent(fx.publicKey, fx.receiverId, fx.signingKey, fx.receiverMsisdn);

      const app = await getTestApp();
      await app.webhookWorker.runOnce();

      assert.equal(recvA.requests.length, 1);
      assert.equal(recvB.requests.length, 1);
      assert.equal(recvC.requests.length, 1);
    } finally {
      await recvA.close();
      await recvB.close();
      await recvC.close();
    }
  });

  // ----- WD12: per-attempt diagnostics recorded ----------------------

  it("WD12: attempt_count increments, last_status_code + last_error written on retry", async () => {
    const fx = await createTestApp();
    const recv = await startTestReceiver();
    try {
      let nth = 0;
      recv.setHandler((_req, res) => {
        nth += 1;
        res.statusCode = nth === 1 ? 503 : 200;
        res.end();
      });
      await registerEndpoint(fx.secretKey, recv.url);
      await emitVerifiedEvent(fx.publicKey, fx.receiverId, fx.signingKey, fx.receiverMsisdn);

      const app = await getTestApp();

      await app.webhookWorker.runOnce();
      const after1 = await dbq<DeliveryRow>(
        `SELECT status, attempt_count, last_status_code, last_error FROM webhook_deliveries`,
      );
      assert.equal(after1[0]!.status, "pending");
      assert.equal(after1[0]!.attempt_count, 1);
      assert.equal(after1[0]!.last_status_code, 503);

      // Force re-due so the second tick processes it.
      await dbq(`UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second'`);
      await app.webhookWorker.runOnce();

      const after2 = await dbq<DeliveryRow>(
        `SELECT status, attempt_count, last_status_code, last_error FROM webhook_deliveries`,
      );
      assert.equal(after2[0]!.status, "delivered");
      assert.equal(after2[0]!.attempt_count, 2);
      assert.equal(after2[0]!.last_status_code, 200);
      assert.equal(after2[0]!.last_error, null);
    } finally {
      await recv.close();
    }
  });

  // ----- secret roundtrip via AAD ------------------------------------

  it("WD13: stored ciphertext unwraps with the same AAD the worker uses", async () => {
    // Defensive: the worker reads `webhook:<endpoint_id>` AAD; if a
    // future refactor tweaks either side, this catches the drift
    // before it surfaces as a delivery hang.
    const fx = await createTestApp();
    const recv = await startTestReceiver();
    try {
      const ep = await registerEndpoint(fx.secretKey, recv.url);
      const rows = await dbq<EndpointRow>(`SELECT id, secret_ciphertext FROM webhook_endpoints WHERE id = $1`, [ep.id]);
      const wrapped = rows[0]!.secret_ciphertext;
      const recovered = unwrap(config.MASTER_ENCRYPTION_KEY, wrapped, `webhook:${rows[0]!.id}`);
      assert.equal(recovered, ep.secret);
    } finally {
      await recv.close();
    }
  });
});
