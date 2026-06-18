/**
 * Prometheus metrics — single source of truth for every counter,
 * histogram, and gauge the server exposes. Hooks across the codebase
 * (routes/, services/) bump them via the helpers in this file.
 *
 * Why one module:
 *   - Adding a metric should NOT require touching the route or service
 *     code. Hooks call `metrics.observe(...)` / `metrics.inc(...)`;
 *     this file is the only place the prom-client API is touched.
 *   - Label names and value cardinality are reviewed in one diff. A
 *     leaked high-cardinality label (e.g. raw phone number) blows up
 *     the time-series store; keeping definitions centralized makes
 *     review tractable.
 *
 * Cardinality discipline:
 *   - NEVER label by phone number, verification id, receiver id, IP,
 *     or anything user-controlled. Use stable enums only.
 *   - The full label set per metric is documented in docs/monitoring.md
 *     so dashboard authors don't have to grep.
 */
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";

// One process-wide registry. Hooks share it; the /metrics route reads
// from it via `renderMetrics()`.
export const registry = new Registry();
registry.setDefaultLabels({ service: "syrotp-server" });

// Process-level metrics: heap, gc, event loop, etc. Cheap and
// extremely useful when correlating latency to GC pauses.
collectDefaultMetrics({ register: registry });

// ----- verification lifecycle ---------------------------------------

const verificationsStarted = new Counter({
  name: "syrotp_verifications_started_total",
  help: "Verifications created via POST /v1/verifications.",
  labelNames: ["app_id"] as const,
  registers: [registry],
});

const verificationsTerminal = new Counter({
  name: "syrotp_verifications_terminal_total",
  help: "Verifications that reached a terminal state.",
  labelNames: ["app_id", "status"] as const,
  registers: [registry],
});

const verificationStartDuration = new Histogram({
  name: "syrotp_verification_start_duration_seconds",
  help: "Latency of POST /v1/verifications, end-to-end.",
  // Buckets aimed at the v0.1.1 baseline (p50 ~120ms, p95 ~190ms,
  // p99 ~330ms). Add slow buckets so spikes show up.
  buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6, 3.2],
  labelNames: ["status"] as const,
  registers: [registry],
});

// ----- inbound SMS --------------------------------------------------

const inboundReceived = new Counter({
  name: "syrotp_inbound_received_total",
  help: "Inbound SMS bodies accepted by the server (post-HMAC, post-replay).",
  labelNames: ["receiver_id", "matched", "reason"] as const,
  registers: [registry],
});

const inboundMatchDuration = new Histogram({
  name: "syrotp_inbound_match_duration_seconds",
  help: "Latency of POST /v1/inbound/sms — signature verify + match attempt.",
  buckets: [0.01, 0.025, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6, 3.2],
  labelNames: ["matched"] as const,
  registers: [registry],
});

// ----- HMAC / auth rejects -----------------------------------------

const hmacRejected = new Counter({
  name: "syrotp_hmac_rejected_total",
  help: "Inbound or heartbeat requests rejected at the HMAC layer.",
  // Reasons map 1:1 to verifyGatewayHmac return codes — see services/hmac.ts.
  // Bounded enum: bad_receiver_id, bad_nonce, bad_signature_format, bad_timestamp,
  // timestamp_skew, unknown_receiver, key_unavailable, bad_signature, replay.
  labelNames: ["reason"] as const,
  registers: [registry],
});

const apiKeyRejected = new Counter({
  name: "syrotp_api_key_rejected_total",
  help: "Bearer-token auth rejected on developer endpoints.",
  // Reasons: missing, malformed, unknown, revoked, wrong_kind, app_disabled.
  labelNames: ["reason"] as const,
  registers: [registry],
});

// ----- rate limiting -----------------------------------------------

const rateLimited = new Counter({
  name: "syrotp_rate_limited_total",
  help: "Requests rejected by a per-IP, per-receiver, or per-app rate limit.",
  // "start" | "status" | "inbound" — the original per-IP / per-receiver
  //                                  buckets shipped pre-v0.8.
  // "verification_start_per_app" | "inbound_sms_per_app"
  // | "phone_binding_start_per_app" — v0.8 PR #38 per-app buckets.
  // "inbound_per_ip" | "heartbeat_per_ip" | "heartbeat_per_receiver"
  //   — v1.0.1: pre-HMAC per-IP shedding + post-HMAC per-receiver
  //   heartbeat cap. See routes/inbound.ts.
  // "verification_cancel_per_app" | "webhook_crud_per_app"
  // | "phone_binding_read_per_app" | "phone_binding_revoke_per_app"
  // | "webauthn_per_app" — v1.0.1: per-app caps on the remaining
  //   sk_live_*-gated surface. A leaked secret key without these
  //   could amplify destructive ops at unlimited rates.
  labelNames: ["bucket"] as const,
  registers: [registry],
});

// ----- receivers ---------------------------------------------------

const receiversTotal = new Gauge({
  name: "syrotp_receivers_total",
  help: "Number of receivers in the database.",
  labelNames: ["enabled"] as const,
  registers: [registry],
});

const receiversHealthy = new Gauge({
  name: "syrotp_receivers_healthy_total",
  help: "Receivers with last_heartbeat_at within the heartbeat window.",
  registers: [registry],
});

const receiverHeartbeatAge = new Gauge({
  name: "syrotp_receiver_heartbeat_age_seconds",
  help: "Seconds since the most recent heartbeat per receiver.",
  // Receiver ID is in our control (we minted it), bounded by deployment
  // size — typically 1-10 per app, dozens per fleet. Acceptable cardinality.
  labelNames: ["receiver_id"] as const,
  registers: [registry],
});

// v1.0.1 — heartbeat handler coalesces DB writes. We only UPDATE the
// `last_heartbeat_at` column when the last write is older than
// RECEIVER_HEARTBEAT_TIMEOUT_SECONDS/4 (≈ 30s on defaults); otherwise
// we acknowledge the heartbeat but skip the write. This counter
// tracks the applied vs skipped split so operators can confirm the
// optimization is doing its job (skip rate ≈ 75% on a well-behaved
// fleet sending every 60s with the default 120s timeout).
const heartbeatDbUpdates = new Counter({
  name: "syrotp_receiver_heartbeat_db_updates_total",
  help: "Heartbeats accepted, split by whether the DB row was UPDATEd or coalesced.",
  // Bounded enum: applied | skipped. No receiver_id label — keep cardinality flat.
  labelNames: ["outcome"] as const,
  registers: [registry],
});

// ----- abuse signals (v0.8 PR #39) --------------------------------
//
// Project-wide rollups only — no high-cardinality `app_id` /
// `receiver_id` labels here. Per-app / per-receiver detail lives
// behind the basic-auth-gated /admin/abuse-signals JSON endpoint.

const abuseFailedVerificationRate = new Gauge({
  name: "syrotp_abuse_failed_verification_rate",
  help: "Fraction of verifications in the last hour that ended in `failed`. [0, 1].",
  registers: [registry],
});

const abuseUnmatchedInboundRate = new Gauge({
  name: "syrotp_abuse_unmatched_inbound_rate",
  help: "Fraction of inbound SMS in the last hour that didn't match a pending verification. [0, 1].",
  registers: [registry],
});

const abuseBindingFailureRate = new Gauge({
  name: "syrotp_abuse_binding_failure_rate",
  help: "Fraction of phone-binding rows created in the last hour that expired in `pending`. [0, 1].",
  registers: [registry],
});

const abuseMinAppHealthScore = new Gauge({
  name: "syrotp_abuse_min_app_health_score",
  help: "Lowest per-app health score across all apps in the last hour. [0, 100], higher is healthier.",
  registers: [registry],
});

// ----- matching invariants (v1.x FIX 6) ----------------------------
//
// The matching UPDATE is structured so it can claim at most one row
// (single-row sub-SELECT + LIMIT 1 + FOR UPDATE SKIP LOCKED), and the
// partial unique index `verifications_pending_uniq` makes a 2-row
// claim impossible at the schema layer anyway. This counter exists
// so that during the transition period (and forever after, as a
// canary) we get a Prometheus signal the moment either guarantee is
// violated. A non-zero value here means somebody has bypassed the
// partial-unique index (e.g. by skipping migration 0006) or a future
// refactor reintroduced the unbounded UPDATE.
//
// No high-cardinality labels — this is a screaming alert, not a
// diagnostic dashboard.
const matchingInvariantViolations = new Counter({
  name: "syrotp_matching_invariant_violations_total",
  help: "Matching UPDATE returned more than one row — invariant violation. Should be permanently zero.",
  registers: [registry],
});

// Collision retries on the partial unique index during
// startVerification — every retry costs a fresh `generateCode` and
// another insert attempt. Non-zero counts here mean the code-space
// is starting to feel crowded; alert if it grows.
const verificationCodeCollisions = new Counter({
  name: "syrotp_verification_code_collisions_total",
  help: "startVerification code-generation collided with an existing pending row (caught by verifications_pending_uniq).",
  // outcome: "retried" — collision was retried within budget.
  //          "exhausted" — caller hit MAX_CODE_COLLISION_RETRIES and surfaced an error.
  labelNames: ["outcome"] as const,
  registers: [registry],
});

// ----- multi-receiver routing (v0.5) --------------------------------

const receiverSelectedCounter = new Counter({
  name: "syrotp_receiver_selected_total",
  help: "Receiver picks at start_verification, by operator-match outcome.",
  // Bounded enum:
  //   preferred — caller passed an operator AND a healthy match was found
  //   fallback  — caller passed an operator but had to fall back to any healthy
  //   none      — caller did not pass an operator preference
  // No labels with receiver_id / operator name — keeps cardinality bounded.
  labelNames: ["match"] as const,
  registers: [registry],
});

// ----- webhooks (v0.5 PR 20B) ---------------------------------------

const webhookEventsEmitted = new Counter({
  name: "syrotp_webhook_events_total",
  help: "Webhook events emitted (one per state change, regardless of subscribers).",
  // Bounded enum: verification.verified | .expired | .cancelled.
  labelNames: ["event_type"] as const,
  registers: [registry],
});

const webhookDeliveriesTerminal = new Counter({
  name: "syrotp_webhook_deliveries_total",
  help: "Webhook delivery attempts that reached a terminal status.",
  // status enum from schema: delivered | failed | abandoned. We also
  // emit `retried` after a non-terminal attempt so dashboards can plot
  // the in-flight churn. Cardinality bounded.
  labelNames: ["status"] as const,
  registers: [registry],
});

const webhookDeliveryFailures = new Counter({
  name: "syrotp_webhook_delivery_failures_total",
  help: "Webhook delivery attempts that did not reach 2xx.",
  // Bounded reason enum: network_error | timeout | client_4xx |
  // server_5xx | rate_limited | endpoint_disabled | bad_response.
  labelNames: ["reason"] as const,
  registers: [registry],
});

const webhookDeliveryDuration = new Histogram({
  name: "syrotp_webhook_delivery_duration_seconds",
  help: "Outbound webhook attempt latency, end-to-end.",
  // Sub-second buckets so dashboards can spot subtle receiver
  // slowdowns; long-tail buckets to catch the 5s timeout.
  buckets: [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10],
  labelNames: ["status"] as const, // 2xx | 4xx | 5xx | network | timeout
  registers: [registry],
});

// -------------------------------------------------------------------

export const metrics = {
  registry,

  // verification lifecycle
  verificationStarted(appId: string): void {
    verificationsStarted.inc({ app_id: appId });
  },
  verificationTerminal(appId: string, status: "verified" | "expired" | "cancelled" | "failed"): void {
    verificationsTerminal.inc({ app_id: appId, status });
  },
  verificationStartObserved(seconds: number, status: number): void {
    verificationStartDuration.observe({ status: classifyStatus(status) }, seconds);
  },

  // inbound
  inboundReceived(
    receiverId: string,
    matched: boolean,
    reason: "matched" | "no_match" | "duplicate" | "expired",
  ): void {
    inboundReceived.inc({ receiver_id: receiverId, matched: String(matched), reason });
  },
  inboundMatchObserved(seconds: number, matched: boolean): void {
    inboundMatchDuration.observe({ matched: String(matched) }, seconds);
  },

  // hmac / auth
  hmacRejected(reason: string): void {
    hmacRejected.inc({ reason });
  },
  apiKeyRejected(reason: "missing" | "malformed" | "unknown" | "revoked" | "wrong_kind" | "app_disabled"): void {
    apiKeyRejected.inc({ reason });
  },

  // rate limit
  rateLimited(
    bucket:
      | "start"
      | "status"
      | "inbound"
      | "verification_start_per_app"
      | "inbound_sms_per_app"
      | "phone_binding_start_per_app"
      | "inbound_per_ip"
      | "heartbeat_per_ip"
      | "heartbeat_per_receiver"
      // v1.0.1 — per-app buckets on the remaining sk_live_*-gated
      // surface (cancel, webhook CRUD, binding read/revoke, WebAuthn).
      // Operators disambiguate via the {bucket=...} label; the public
      // API response stays uniform `rate_limited`.
      | "verification_cancel_per_app"
      | "webhook_crud_per_app"
      | "phone_binding_read_per_app"
      | "phone_binding_revoke_per_app"
      | "webauthn_per_app",
  ): void {
    rateLimited.inc({ bucket });
  },

  // heartbeat DB-write coalescing (v1.0.1) — see counter definition above.
  heartbeatDbUpdate(outcome: "applied" | "skipped"): void {
    heartbeatDbUpdates.inc({ outcome });
  },

  // multi-receiver routing
  receiverSelected(match: "preferred" | "fallback" | "none"): void {
    receiverSelectedCounter.inc({ match });
  },

  // matching invariants (v1.x FIX 6)
  matchingInvariantViolated(): void {
    matchingInvariantViolations.inc();
  },
  verificationCodeCollision(outcome: "retried" | "exhausted"): void {
    verificationCodeCollisions.inc({ outcome });
  },

  // abuse signals (v0.8 PR #39) — project-wide rollups
  setAbuseSignals(signals: {
    failed_verification_rate: number;
    unmatched_inbound_rate: number;
    binding_failure_rate: number;
    min_app_health_score: number;
  }): void {
    abuseFailedVerificationRate.set(signals.failed_verification_rate);
    abuseUnmatchedInboundRate.set(signals.unmatched_inbound_rate);
    abuseBindingFailureRate.set(signals.binding_failure_rate);
    abuseMinAppHealthScore.set(signals.min_app_health_score);
  },

  // webhooks
  webhookEventEmitted(eventType: string): void {
    webhookEventsEmitted.inc({ event_type: eventType });
  },
  webhookDeliveryTerminal(status: "delivered" | "failed" | "abandoned" | "retried"): void {
    webhookDeliveriesTerminal.inc({ status });
  },
  webhookDeliveryFailure(
    reason:
      | "network_error"
      | "timeout"
      | "client_4xx"
      | "server_5xx"
      | "rate_limited"
      | "endpoint_disabled"
      | "bad_response",
  ): void {
    webhookDeliveryFailures.inc({ reason });
  },
  webhookDeliveryObserved(seconds: number, status: "2xx" | "4xx" | "5xx" | "network" | "timeout"): void {
    webhookDeliveryDuration.observe({ status }, seconds);
  },

  // receivers (set by a periodic refresh, see services/receiverGauges.ts)
  setReceiverGauges(values: {
    enabledTotal: number;
    disabledTotal: number;
    healthyTotal: number;
    perReceiverHeartbeatAge: ReadonlyArray<{ receiverId: string; ageSeconds: number }>;
  }): void {
    receiversTotal.set({ enabled: "true" }, values.enabledTotal);
    receiversTotal.set({ enabled: "false" }, values.disabledTotal);
    receiversHealthy.set(values.healthyTotal);
    // Reset to drop receivers that no longer exist.
    receiverHeartbeatAge.reset();
    for (const r of values.perReceiverHeartbeatAge) {
      receiverHeartbeatAge.set({ receiver_id: r.receiverId }, r.ageSeconds);
    }
  },
};

/** Bucket HTTP status into a fixed enum for histogram labels. */
function classifyStatus(s: number): "2xx" | "4xx" | "5xx" | "other" {
  if (s >= 200 && s < 300) return "2xx";
  if (s >= 400 && s < 500) return "4xx";
  if (s >= 500 && s < 600) return "5xx";
  return "other";
}

/** Render the Prometheus exposition format for the /metrics route. */
export async function renderMetrics(): Promise<{ contentType: string; body: string }> {
  return {
    contentType: registry.contentType,
    body: await registry.metrics(),
  };
}
