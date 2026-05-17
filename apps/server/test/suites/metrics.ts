/**
 * Suite 9: Prometheus /metrics endpoint.
 *
 * Verifies:
 *   - GET /metrics returns 200 + the prom-client content-type
 *   - exposition format includes the SYROTP-prefixed metric families
 *     (`syrotp_verifications_started_total`, `syrotp_inbound_received_total`,
 *      `syrotp_hmac_rejected_total`, etc.)
 *   - traffic flowing through the server actually moves the counters
 *     (drive a verification + inbound, then re-scrape and compare)
 *   - no high-cardinality leak: phone numbers and verification ids
 *     do NOT appear in label values
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { resetDatabase } from "../helpers/db.js";
import { resetRedis } from "../helpers/redis.js";
import { createTestApp } from "../helpers/fixtures.js";
import { getTestApp } from "../helpers/app.js";
import { inboundBody, signGateway } from "../helpers/sign.js";

async function fetchMetrics(app: Awaited<ReturnType<typeof getTestApp>>): Promise<{
  status: number;
  contentType: string;
  body: string;
}> {
  const r = await app.inject({ method: "GET", url: "/metrics" });
  return { status: r.statusCode, contentType: String(r.headers["content-type"] ?? ""), body: r.body };
}

/**
 * Sum every series for `metric` whose labels match ALL of the given
 * key/value constraints. With no constraints, sums every series — that's
 * what we want for "did this counter move at all" assertions across
 * dynamically-labeled metrics like `app_id`.
 */
function counterValue(body: string, metric: string, labels: Record<string, string> = {}): number {
  // Each line: `metric{k1="v1",k2="v2",...} <value>` (or `metric <value>`
  // if no labels). prom-client always renders one line per series.
  const escapedMetric = metric.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escapedMetric}(?:\\{([^}]*)\\})?\\s+(\\d+(?:\\.\\d+)?)$`, "gm");
  let total = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const lineLabels = parseLabelString(m[1] ?? "");
    if (matchesAll(lineLabels, labels)) {
      total += Number.parseFloat(m[2]!);
    }
  }
  return total;
}

function parseLabelString(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Format: k1="v1",k2="v2"
  const re = /([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out[m[1]!] = m[2]!.replace(/\\(.)/g, "$1");
  }
  return out;
}

function matchesAll(actual: Record<string, string>, expected: Record<string, string>): boolean {
  for (const [k, v] of Object.entries(expected)) {
    if (actual[k] !== v) return false;
  }
  return true;
}

describe("metrics endpoint", () => {
  beforeEach(async () => {
    await resetDatabase();
    await resetRedis();
  });

  it("GET /metrics returns Prometheus exposition format", async () => {
    const app = await getTestApp();
    const res = await fetchMetrics(app);
    assert.equal(res.status, 200);
    assert.match(res.contentType, /text\/plain/);
    assert.match(res.contentType, /version=/);
    // Every SYROTP metric family is registered at boot — even with zero
    // traffic, the names appear with the metadata HELP / TYPE lines.
    assert.match(res.body, /# HELP syrotp_verifications_started_total/);
    assert.match(res.body, /# HELP syrotp_inbound_received_total/);
    assert.match(res.body, /# HELP syrotp_hmac_rejected_total/);
    assert.match(res.body, /# HELP syrotp_api_key_rejected_total/);
    assert.match(res.body, /# HELP syrotp_rate_limited_total/);
    assert.match(res.body, /# HELP syrotp_receivers_total/);
    assert.match(res.body, /# HELP syrotp_verification_start_duration_seconds/);
    assert.match(res.body, /# HELP syrotp_inbound_match_duration_seconds/);
  });

  it("default service label is set on every metric", async () => {
    const app = await getTestApp();
    const res = await fetchMetrics(app);
    // prom-client renders `service="syrotp-server"` on every series
    // because we called registry.setDefaultLabels.
    assert.match(res.body, /service="syrotp-server"/);
  });

  it("traffic moves the verification + inbound counters", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();

    const before = await fetchMetrics(app);
    const startedBefore = counterValue(before.body, "syrotp_verifications_started_total");
    const inboundBefore = counterValue(before.body, "syrotp_inbound_received_total");

    // 1. start a verification
    const start = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    assert.equal(start.statusCode, 201);
    const v = start.json();

    // 2. push a matching inbound
    const body = inboundBody({
      from: "+963991234567",
      to: fx.receiverMsisdn,
      body: v.message,
    });
    const headers = signGateway(fx.receiverId, fx.signingKey, body);
    const inb = await app.inject({
      method: "POST",
      url: "/v1/inbound/sms",
      headers,
      payload: body,
    });
    assert.equal(inb.statusCode, 202);
    assert.equal(inb.json().matched, true);

    const after = await fetchMetrics(app);
    const startedAfter = counterValue(after.body, "syrotp_verifications_started_total");
    const inboundAfter = counterValue(after.body, "syrotp_inbound_received_total");

    assert.equal(startedAfter, startedBefore + 1, "verifications_started_total should bump by 1");
    assert.equal(inboundAfter, inboundBefore + 1, "inbound_received_total should bump by 1");

    // The matched=true series specifically should appear.
    assert.match(after.body, /syrotp_inbound_received_total\{[^}]*matched="true"[^}]*\}/);
  });

  it("hmac_rejected counter bumps on bad-signature inbound", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();

    const body = inboundBody({
      from: "+963991234567",
      to: fx.receiverMsisdn,
      body: "VERIFY ABCDEF",
    });
    // Sign with the WRONG key.
    const wrongKey = "f".repeat(64);
    const headers = signGateway(fx.receiverId, wrongKey, body);
    const r = await app.inject({ method: "POST", url: "/v1/inbound/sms", headers, payload: body });
    assert.equal(r.statusCode, 401);

    const m = await fetchMetrics(app);
    // Bad signature is the labeled reason.
    const badSig = counterValue(m.body, "syrotp_hmac_rejected_total", { reason: "bad_signature" });
    assert.ok(badSig >= 1, "hmac_rejected_total{reason=bad_signature} should be ≥ 1");
  });

  it("api_key_rejected counter bumps on unknown bearer", async () => {
    const app = await getTestApp();
    const r = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: "Bearer pk_live_doesnotexist0000000000000000000" },
      payload: { phone: "0991234567", purpose: "login" },
    });
    assert.equal(r.statusCode, 401);

    const m = await fetchMetrics(app);
    const unknown = counterValue(m.body, "syrotp_api_key_rejected_total", { reason: "unknown" });
    assert.ok(unknown >= 1);
  });

  it("no high-cardinality leak: phone numbers and vrf ids do not appear as labels", async () => {
    const fx = await createTestApp();
    const app = await getTestApp();

    const start = await app.inject({
      method: "POST",
      url: "/v1/verifications",
      headers: { authorization: `Bearer ${fx.publicKey}` },
      payload: { phone: "0991234567", purpose: "login" },
    });
    assert.equal(start.statusCode, 201);
    const v = start.json();

    const m = await fetchMetrics(app);
    // Raw E.164 must never appear in any series.
    assert.doesNotMatch(m.body, /\+963991234567/);
    // Verification ids are user-data-shaped — they must not be labels.
    assert.doesNotMatch(m.body, new RegExp(v.id));
    // Receiver ids ARE allowed as labels (low cardinality), but the
    // *signing key* and any HMAC must never appear.
    assert.doesNotMatch(m.body, new RegExp(fx.signingKey));
    assert.doesNotMatch(m.body, new RegExp(fx.publicKey));
    assert.doesNotMatch(m.body, new RegExp(fx.secretKey));
  });
});
