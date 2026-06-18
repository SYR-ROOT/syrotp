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

// receiverId shape: `rcv_<base62>`. Anchored on both ends so junk like
// `rcv_<newline>` can't slip through and pollute a Redis key. Mirrors
// the check in services/hmac.ts (defense in depth — we want to reject
// malformed ids BEFORE we ever touch Redis).
const RECEIVER_ID_RE = /^rcv_[A-Za-z0-9]+$/;

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

    // v1.0.1 — validate the receiverId shape IMMEDIATELY. The header
    // is attacker-controlled; if we keyed a Redis bucket on it before
    // a shape check, an attacker could inject arbitrary key fragments
    // (commas, colons, newlines) and either pollute the key namespace
    // or evade per-receiver buckets via id rotation. Rejecting with
    // 400 before any I/O also short-circuits the cheapest possible
    // garbage traffic.
    if (!RECEIVER_ID_RE.test(headers.receiverId)) {
      throw badRequest("bad_receiver_id", "malformed receiver id");
    }

    if (!req.rawBody) throw badRequest("bad_body", "raw body unavailable");

    // v1.0.1 — pre-HMAC per-source-IP shedding. Keyed on req.ip (which
    // Fastify resolves through our `trustProxy` allowlist — see
    // config.ts:TRUSTED_PROXIES), NOT on any attacker-controlled
    // header. This is the only rate-limit bucket that runs before HMAC
    // verify; the per-receiver + per-app buckets below run only after
    // we know the request is authentic. Default 600/min is wide enough
    // for legitimate batched gateways behind a NAT but narrow enough
    // that a single attacker IP gets shut down before it can saturate
    // the HMAC verify path or flood the nonce-tracking Redis keys.
    const rlIp = await rateCheck(
      `inbound:ip:${req.ip}`,
      config.RATE_LIMIT_INBOUND_PER_IP_PER_MIN,
      60,
    );
    if (!rlIp.allowed) {
      metrics.rateLimited("inbound_per_ip");
      throw rateLimited(rlIp.resetSeconds);
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

    // v1.0.1 — per-receiver bucket MOVED to post-HMAC and re-keyed on
    // the VERIFIED receiver id (verified.receiver.id), not the raw
    // header. Pre-HMAC keying let an attacker DoS a specific receiver
    // by sending bogus signed requests under that receiver's id, or
    // rotate ids to bypass the bucket entirely. Now this bucket only
    // counts traffic that already produced a valid HMAC.
    const rlRcv = await rateCheck(
      `inbound:rcv:${verified.receiver.id}`,
      config.RATE_LIMIT_INBOUND_PER_RECEIVER_PER_MIN,
      60,
    );
    if (!rlRcv.allowed) {
      metrics.rateLimited("inbound");
      throw rateLimited(rlRcv.resetSeconds);
    }

    // v0.8 PR #38 — per-app bucket stacked on top of the per-receiver
    // bucket above. Both must pass; the cheap per-receiver guard runs
    // first, the broader per-app bucket second so a single app with
    // many receivers can't fan out around the per-receiver ceiling.
    // We only know the app_id after HMAC verification (the receiver
    // row carries app_id).
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
    // v1.0.1 — symmetry with /v1/inbound/sms: validate the receiverId
    // regex IMMEDIATELY, then a pre-HMAC per-IP bucket, then HMAC, then
    // a post-HMAC per-receiver bucket keyed on the VERIFIED id. The
    // path param is just as attacker-controllable as the header on the
    // inbound route — same threat model, same defense ordering.
    const params = z
      .object({ id: z.string().regex(RECEIVER_ID_RE) })
      .safeParse(req.params);
    // Malformed id → 400 (consistent with /v1/inbound/sms). Was 401
    // before, but a shape failure is a client bug, not an auth failure,
    // and we want to short-circuit before any Redis I/O.
    if (!params.success) throw badRequest("bad_receiver_id", "malformed receiver id");

    const headers = readGatewayHeaders(req);
    if (!headers.timestamp || !headers.nonce || !headers.signature) throw unauthorized();
    if (!req.rawBody) throw badRequest("bad_body", "raw body unavailable");

    // Pre-HMAC per-source-IP shedding. Same default budget as /v1/inbound/sms
    // since heartbeats and inbound SMS share the same gateway fleet at
    // the network edge — one budget per IP is simpler to reason about
    // than two and still gives plenty of room for both traffic shapes.
    const rlIp = await rateCheck(
      `inbound:ip:${req.ip}`,
      config.RATE_LIMIT_INBOUND_PER_IP_PER_MIN,
      60,
    );
    if (!rlIp.allowed) {
      metrics.rateLimited("heartbeat_per_ip");
      throw rateLimited(rlIp.resetSeconds);
    }

    const verified = await verifyGatewayHmac({
      receiverId: params.data.id,
      timestampHeader: headers.timestamp,
      nonceHeader: headers.nonce,
      signatureHeader: headers.signature,
      rawBody: req.rawBody,
    });
    if (!verified.ok) {
      req.log.warn({ reason: verified.reason, receiverId: params.data.id }, "hmac reject");
      metrics.hmacRejected(verified.reason);
      throw unauthorized();
    }

    // Post-HMAC per-receiver bucket, keyed on the VERIFIED id. Default
    // 6/min is ~10x the design rate of 1/min (heartbeat clients send
    // every RECEIVER_HEARTBEAT_TIMEOUT_SECONDS/2 ≈ 60s) — enough
    // headroom for clock skew + retries but tight enough that a runaway
    // client gets clamped instead of pounding the receivers table.
    const rlRcv = await rateCheck(
      `heartbeat:rcv:${verified.receiver.id}`,
      config.RATE_LIMIT_HEARTBEAT_PER_RECEIVER_PER_MIN,
      60,
    );
    if (!rlRcv.allowed) {
      metrics.rateLimited("heartbeat_per_receiver");
      throw rateLimited(rlRcv.resetSeconds);
    }

    const parsed = heartbeatBody.safeParse(req.body);
    if (!parsed.success) throw badRequest("validation_error", "invalid heartbeat body");

    // v1.0.1 — coalesce DB writes. The receiver gauge only resolves at
    // RECEIVER_HEARTBEAT_TIMEOUT_SECONDS granularity, so updating the
    // `last_heartbeat_at` column on every single 60-second ping just
    // hammers the row with writes that don't change any decision.
    // Skip the UPDATE when the last write is fresher than TIMEOUT/4
    // (≈ 30s on defaults). The route still returns 200 in that case —
    // the heartbeat itself is acknowledged; we just didn't need to
    // write to the database to keep the receiver "healthy".
    const coalesceThresholdSec = Math.floor(config.RECEIVER_HEARTBEAT_TIMEOUT_SECONDS / 4);
    const now = new Date();

    const rows = await db
      .select({ lastHeartbeatAt: schema.receivers.lastHeartbeatAt })
      .from(schema.receivers)
      .where(eq(schema.receivers.id, verified.receiver.id))
      .limit(1);
    const lastHb = rows[0]?.lastHeartbeatAt ?? null;
    const ageSec = lastHb
      ? (now.getTime() - lastHb.getTime()) / 1000
      : Number.POSITIVE_INFINITY;

    if (ageSec > coalesceThresholdSec) {
      await db
        .update(schema.receivers)
        .set({ lastHeartbeatAt: now })
        .where(eq(schema.receivers.id, verified.receiver.id));
      metrics.heartbeatDbUpdate("applied");
    } else {
      metrics.heartbeatDbUpdate("skipped");
    }

    reply.code(200);
    return {
      ok: true,
      server_time: now.toISOString(),
      next_heartbeat_seconds: Math.floor(config.RECEIVER_HEARTBEAT_TIMEOUT_SECONDS / 2),
    };
  });
}
