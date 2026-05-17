import type { FastifyInstance, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { config } from "../config.js";
import { badRequest, rateLimited, unauthorized } from "../lib/errors.js";
import { rateCheck } from "../services/rateLimit.js";
import { processInbound } from "../services/matching.js";
import { verifyGatewayHmac } from "../services/hmac.js";
import { audit } from "../services/audit.js";
import { metrics } from "../services/metrics.js";

const inboundBody = z.object({
  from: z.string().min(3).max(32),
  to: z.string().min(3).max(32),
  body: z.string().min(1).max(1600),
  received_at: z.string().datetime(),
  idempotency_key: z.string().min(8).max(128),
  sim_slot: z.number().int().min(0).max(7).optional(),
});

const heartbeatBody = z.object({
  received_at: z.string().datetime(),
  queue_depth: z.number().int().min(0).optional(),
  sim_signal_dbm: z.number().int().optional(),
  battery_percent: z.number().int().min(0).max(100).optional(),
  app_version: z.string().max(32).optional(),
});

function readGatewayHeaders(req: FastifyRequest) {
  const get = (n: string) => {
    const v = req.headers[n.toLowerCase()];
    return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined;
  };
  return {
    receiverId: get("x-syrotp-receiver"),
    timestamp: get("x-syrotp-timestamp"),
    nonce: get("x-syrotp-nonce"),
    signature: get("x-syrotp-signature"),
  };
}

export async function inboundRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/inbound/sms", async (req, reply) => {
    const t0 = performance.now();

    const headers = readGatewayHeaders(req);
    if (!headers.receiverId || !headers.timestamp || !headers.nonce || !headers.signature) {
      throw unauthorized("missing gateway headers");
    }

    if (!req.rawBody) throw badRequest("bad_body", "raw body unavailable");

    // Per-receiver rate limit (defense in depth — HMAC is the primary auth).
    const rl = await rateCheck(
      `inbound:rcv:${headers.receiverId}`,
      config.RATE_LIMIT_INBOUND_PER_RECEIVER_PER_MIN,
      60,
    );
    if (!rl.allowed) {
      metrics.rateLimited("inbound");
      throw rateLimited(rl.resetSeconds);
    }

    const verified = await verifyGatewayHmac({
      receiverId: headers.receiverId,
      timestampHeader: headers.timestamp,
      nonceHeader: headers.nonce,
      signatureHeader: headers.signature,
      rawBody: req.rawBody,
    });
    if (!verified.ok) {
      // Always log the failure reason server-side; never tell the client.
      req.log.warn({ reason: verified.reason, receiverId: headers.receiverId }, "hmac reject");
      metrics.hmacRejected(verified.reason);
      throw unauthorized();
    }

    // v0.8 PR #38 — per-app bucket stacked on top of the
    // per-receiver bucket above. Both must pass; the cheap
    // per-receiver guard runs first, the broader per-app bucket
    // second so a single app with many receivers can't fan out
    // around the per-receiver ceiling. We only know the app_id
    // after HMAC verification (the receiver row carries app_id),
    // hence the placement here rather than next to the
    // per-receiver check.
    const rlApp = await rateCheck(
      `inbound:app:${verified.receiver.appId}`,
      config.RATE_LIMIT_INBOUND_PER_APP_PER_MIN,
      60,
    );
    if (!rlApp.allowed) {
      metrics.rateLimited("inbound_sms_per_app");
      throw rateLimited(rlApp.resetSeconds);
    }

    const parsed = inboundBody.safeParse(req.body);
    if (!parsed.success) throw badRequest("validation_error", "invalid inbound body");
    const body = parsed.data;

    const outcome = await processInbound({
      receiverId: verified.receiver.id,
      receiverMsisdn: verified.receiver.msisdn,
      from: body.from,
      to: body.to,
      body: body.body,
      receivedAt: new Date(body.received_at),
      idempotencyKey: body.idempotency_key,
    });

    // Metrics: outcome bucket + latency. Reason is normalized to a
    // bounded enum: "matched" (matched=true), "no_match" / "duplicate"
    // / "expired" (matched=false). The DB-write itself happened inside
    // processInbound, so latency includes everything user-observable.
    const reasonLabel = outcome.matched
      ? "matched"
      : outcome.reason === "duplicate"
        ? "duplicate"
        : outcome.reason === "expired"
          ? "expired"
          : "no_match";
    metrics.inboundReceived(verified.receiver.id, outcome.matched, reasonLabel);
    metrics.inboundMatchObserved((performance.now() - t0) / 1000, outcome.matched);
    if (outcome.matched) {
      metrics.verificationTerminal(verified.receiver.appId, "verified");
    }

    // The matcher's `matched: true` outcome can carry either a
    // verification id (existing flow) or a phone-binding id (v0.8
    // PR #36). Audit + the response disambiguate so downstream
    // consumers see which one this inbound resolved.
    if (outcome.matched) {
      const isBinding = "kind" in outcome && outcome.kind === "binding";
      const matchedId = isBinding ? outcome.bindingId : outcome.verificationId;
      await audit({
        appId: verified.receiver.appId,
        actor: `receiver:${verified.receiver.id}`,
        action: "inbound.matched",
        resourceType: "inbound_sms",
        resourceId: outcome.inboundId,
        ip: req.ip,
        requestId: req.id,
        meta: isBinding ? { phone_binding_id: matchedId } : { verification_id: matchedId },
      });
      reply.code(202);
      return isBinding
        ? { accepted: true, matched: true, kind: "binding", phone_binding_id: matchedId }
        : { accepted: true, matched: true, verification_id: matchedId };
    }

    await audit({
      appId: verified.receiver.appId,
      actor: `receiver:${verified.receiver.id}`,
      action: "inbound.received",
      resourceType: "inbound_sms",
      resourceId: outcome.inboundId,
      ip: req.ip,
      requestId: req.id,
      meta: { reason: outcome.reason },
    });

    if (outcome.reason === "duplicate") {
      reply.code(409);
      return { accepted: true, matched: false, reason: "duplicate" };
    }
    reply.code(202);
    return { accepted: true, matched: false, reason: outcome.reason };
  });

  app.post("/v1/receivers/:id/heartbeat", async (req, reply) => {
    const params = z.object({ id: z.string().regex(/^rcv_[A-Za-z0-9]+$/) }).safeParse(req.params);
    if (!params.success) throw unauthorized();

    const headers = readGatewayHeaders(req);
    if (!headers.timestamp || !headers.nonce || !headers.signature) throw unauthorized();
    if (!req.rawBody) throw badRequest("bad_body", "raw body unavailable");

    const verified = await verifyGatewayHmac({
      receiverId: params.data.id,
      timestampHeader: headers.timestamp,
      nonceHeader: headers.nonce,
      signatureHeader: headers.signature,
      rawBody: req.rawBody,
    });
    if (!verified.ok) throw unauthorized();

    const parsed = heartbeatBody.safeParse(req.body);
    if (!parsed.success) throw badRequest("validation_error", "invalid heartbeat body");

    await db
      .update(schema.receivers)
      .set({ lastHeartbeatAt: new Date() })
      .where(eq(schema.receivers.id, verified.receiver.id));

    reply.code(200);
    return {
      ok: true,
      server_time: new Date().toISOString(),
      next_heartbeat_seconds: Math.floor(config.RECEIVER_HEARTBEAT_TIMEOUT_SECONDS / 2),
    };
  });
}
