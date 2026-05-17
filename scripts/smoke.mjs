#!/usr/bin/env node
/**
 * SYROTP smoke test — proves the full protocol works end-to-end against a
 * running server in under a second.
 *
 * What it does:
 *   1. GET /v1/health
 *   2. POST /v1/verifications (developer side)
 *   3. Build & HMAC-sign a fake inbound SMS (gateway side)
 *   4. POST /v1/inbound/sms
 *   5. GET /v1/verifications/<id> until status="verified"
 *   6. Print PASS or FAIL with details
 *
 * Usage:
 *   pnpm smoke
 *
 * Required env:
 *   SYROTP_BASE_URL            e.g. http://localhost:3000
 *   SYROTP_PUBLIC_KEY          pk_live_*
 *   SYROTP_SECRET_KEY          sk_live_*       (for status reads)
 *   SYROTP_RECEIVER_ID         rcv_*
 *   SYROTP_GATEWAY_KEY         the raw signing key shown by bootstrap
 *   SYROTP_PHONE               phone to verify (E.164 or local)
 *
 * If you don't have these yet, run:
 *   docker compose exec server node dist/scripts/bootstrap.js \
 *     --app-name "smoke" --msisdn "+963998887777"
 * then export the printed values.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const REQUIRED = [
  "SYROTP_BASE_URL",
  "SYROTP_PUBLIC_KEY",
  "SYROTP_SECRET_KEY",
  "SYROTP_RECEIVER_ID",
  "SYROTP_GATEWAY_KEY",
  "SYROTP_PHONE",
];

const env = (k) => process.env[k];

function die(msg, code = 1) {
  console.error(`[smoke] FAIL: ${msg}`);
  process.exit(code);
}

function check(cond, msg) {
  if (!cond) die(msg);
}

function step(n, name) {
  console.log(`[smoke] ${n}. ${name}`);
}

const missing = REQUIRED.filter((k) => !env(k));
if (missing.length > 0) {
  console.error("[smoke] missing required env: " + missing.join(", "));
  console.error("[smoke] run: docker compose exec server node dist/scripts/bootstrap.js --app-name smoke --msisdn +963998887777");
  console.error("[smoke] then export the printed values and re-run pnpm smoke");
  process.exit(2);
}

const BASE = env("SYROTP_BASE_URL").replace(/\/+$/, "");
const PK = env("SYROTP_PUBLIC_KEY");
const SK = env("SYROTP_SECRET_KEY");
const RECEIVER = env("SYROTP_RECEIVER_ID");
const GW_KEY = env("SYROTP_GATEWAY_KEY");
const PHONE = env("SYROTP_PHONE");

async function jsonFetch(method, path, { body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...headers,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      "User-Agent": "syrotp-smoke/0.1",
    },
    body: body !== undefined ? body : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch {
    json = { _raw: text };
  }
  return { status: res.status, json, headers: res.headers };
}

function sign(receiverId, key, rawBody) {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString("hex");
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const sig = createHmac("sha256", key).update(`${ts}.${nonce}.${bodyHash}`).digest("hex");
  return {
    "X-SYROTP-Receiver": receiverId,
    "X-SYROTP-Timestamp": ts,
    "X-SYROTP-Nonce": nonce,
    "X-SYROTP-Signature": sig,
  };
}

const t0 = Date.now();

// 1. health
step(1, "GET /v1/health");
{
  const r = await jsonFetch("GET", "/v1/health");
  check(r.status === 200 && r.json.status === "ok", `health bad: ${r.status} ${JSON.stringify(r.json)}`);
}

// 1b. heartbeat — bootstrap.js does not set last_heartbeat_at on the
// receiver row. Without this, pickReceiver() treats the receiver as
// "not healthy" and start verifications return 503 no_receiver. A real
// gateway sends heartbeats every ~7-15 minutes; the smoke flow simulates
// one explicitly so a fresh bootstrap is immediately usable.
step(1, "POST /v1/receivers/{id}/heartbeat (simulate gateway)");
{
  const hbBody = JSON.stringify({ received_at: new Date().toISOString() });
  const hbHeaders = sign(RECEIVER, GW_KEY, hbBody);
  const r = await jsonFetch("POST", `/v1/receivers/${encodeURIComponent(RECEIVER)}/heartbeat`, {
    headers: hbHeaders,
    body: hbBody,
  });
  check(r.status === 200, `heartbeat failed: ${r.status} ${JSON.stringify(r.json)}`);
}

// 1c. phone-binding ceremony (v0.8 PR #37)
// startVerification now requires a verified phone-binding for
// (app_id, phone_e164). The smoke flow exercises the full
// ceremony so it stays a real end-to-end test.
const PHONE_E164 = PHONE.startsWith("+")
  ? PHONE
  : PHONE.startsWith("0")
    ? "+963" + PHONE.slice(1)
    : "+" + PHONE;

step(1, "POST /v1/phone-bindings/start (v0.8 PR #37 ceremony)");
let bindMsg;
{
  const r = await jsonFetch("POST", "/v1/phone-bindings/start", {
    headers: { Authorization: `Bearer ${SK}` },
    body: JSON.stringify({ phone: PHONE, receiver_id: RECEIVER }),
  });
  if (r.status === 409 && r.json?.error?.code === "already_bound") {
    // Re-runs against the same dev DB find an existing verified
    // binding — that's fine for smoke; we proceed straight to
    // startVerification.
    console.log(`[smoke]    binding already verified — skipping ceremony`);
    bindMsg = null;
  } else {
    check(r.status === 201, `binding-start failed: ${r.status} ${JSON.stringify(r.json)}`);
    check(
      typeof r.json.bind_message === "string" && r.json.bind_message.startsWith("BIND "),
      `no BIND message in response: ${JSON.stringify(r.json)}`,
    );
    bindMsg = r.json.bind_message;
    console.log(`[smoke]    binding_id=${r.json.binding_id} status=${r.json.status}`);
  }
}

if (bindMsg) {
  step(1, "POST /v1/inbound/sms with BIND <nonce> (simulate gateway)");
  const bindBody = JSON.stringify({
    from: PHONE_E164,
    to: PHONE_E164, // any value — matcher routes via receiverId from HMAC headers
    body: bindMsg,
    received_at: new Date().toISOString(),
    idempotency_key: "smoke_bind_" + randomBytes(8).toString("hex"),
  });
  const sigHeaders = sign(RECEIVER, GW_KEY, bindBody);
  const r = await jsonFetch("POST", "/v1/inbound/sms", { headers: sigHeaders, body: bindBody });
  check(r.status === 202, `bind-inbound failed: ${r.status} ${JSON.stringify(r.json)}`);
  check(r.json.matched === true, `bind-inbound did not match: ${JSON.stringify(r.json)}`);
  console.log(`[smoke]    bind matched=${r.json.matched}`);
}

// 2. start verification
step(2, "POST /v1/verifications");
let v;
{
  const r = await jsonFetch("POST", "/v1/verifications", {
    headers: { Authorization: `Bearer ${PK}` },
    body: JSON.stringify({ phone: PHONE, purpose: "smoke" }),
  });
  check(r.status === 201, `start failed: ${r.status} ${JSON.stringify(r.json)}`);
  v = r.json;
  check(typeof v.message === "string" && v.message.startsWith("VERIFY "), "no VERIFY message");
  check(typeof v.send_to === "string", "no send_to in response");
  console.log(`[smoke]    id=${v.id}`);
  console.log(`[smoke]    msg="${v.message}"`);
  console.log(`[smoke]    to=${v.send_to}`);
}

// 3. build inbound body — we have to send the *exact* phone the dev asked
// to verify, in E.164. The phone the dev sent might be local; we don't
// know the canonical E.164 from outside, so we use what the server told
// us via phone_masked? No — phone_masked is masked. Trust the user input
// here since we control the test phone. Real gateways use the carrier-
// reported sender number directly.
step(3, "build & sign inbound");
const inboundJson = JSON.stringify({
  from: PHONE.startsWith("+") ? PHONE : (PHONE.startsWith("0") ? "+963" + PHONE.slice(1) : "+" + PHONE),
  to: v.send_to,
  body: v.message,
  received_at: new Date().toISOString(),
  idempotency_key: "smoke_" + randomBytes(8).toString("hex"),
});
const sigHeaders = sign(RECEIVER, GW_KEY, inboundJson);

// 4. post inbound
step(4, "POST /v1/inbound/sms");
{
  const r = await jsonFetch("POST", "/v1/inbound/sms", {
    headers: sigHeaders,
    body: inboundJson,
  });
  check(r.status === 202, `inbound failed: ${r.status} ${JSON.stringify(r.json)}`);
  check(r.json.matched === true, `inbound did not match: ${JSON.stringify(r.json)}`);
  console.log(`[smoke]    matched=${r.json.matched} verification_id=${r.json.verification_id}`);
}

// 5. poll status (should already be verified, but allow a moment for any
// async cleanup paths to settle).
step(5, "GET /v1/verifications/{id} until verified");
let final;
for (let i = 0; i < 5; i++) {
  const r = await jsonFetch("GET", `/v1/verifications/${encodeURIComponent(v.id)}`, {
    headers: { Authorization: `Bearer ${SK}` },
  });
  check(r.status === 200, `status failed: ${r.status}`);
  if (r.json.status === "verified") { final = r.json; break; }
  await sleep(200);
}
check(final && final.status === "verified", `verification did not reach verified: ${JSON.stringify(final)}`);

const elapsed = Date.now() - t0;
console.log(`[smoke] PASS  (${elapsed}ms)`);
process.exit(0);
