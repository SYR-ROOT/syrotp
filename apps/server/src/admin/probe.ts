/**
 * Pure HTTP probe — no DB, no Redis, no Postgres-js. Imports here are
 * deliberately limited to node:crypto + the lib/crypto helpers (which
 * themselves don't pull in db/redis).
 *
 * Why a separate file from admin/receivers.ts: that module imports
 * services/hmac.ts which imports lib/redis.ts which immediately opens a
 * Redis connection (lazyConnect: false). Loading admin/receivers.ts in
 * a test process where Redis isn't running means a never-draining event
 * loop. Splitting `testReceiver` here lets `syrotp receiver test` work
 * without touching the DB/Redis layer at all.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";

export interface ProbeReceiverOptions {
  receiverId: string;
  signingKey: string;
  baseUrl: string;
  /** ms */
  timeoutMs?: number;
}

export interface ProbeReceiverResult {
  status: number;
  ok: boolean;
  matched: boolean;
  reason?: string;
  body: unknown;
  /** ms */
  latencyMs: number;
}

/**
 * Sign a sample inbound payload and POST it to the SYROTP server.
 *
 * The payload uses a fake (random) verification code, so the server
 * stores the inbound row but does not match any pending verification.
 * Successful 202 + matched=false proves end-to-end:
 *   - server is reachable
 *   - HMAC signature verifies
 *   - replay/timestamp guards accept the request
 *   - DB write to inbound_sms succeeds
 */
export async function testReceiver(opts: ProbeReceiverOptions): Promise<ProbeReceiverResult> {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const body = JSON.stringify({
    from: "+963999000000",
    to: "self",
    body: "VERIFY " + sampleCode(),
    received_at: new Date().toISOString(),
    idempotency_key: "probe_" + randomBytes(8).toString("hex"),
  });

  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString("hex");
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const sig = createHmac("sha256", opts.signingKey).update(`${ts}.${nonce}.${bodyHash}`).digest("hex");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5000);
  const t0 = performance.now();
  try {
    const res = await fetch(`${baseUrl}/v1/inbound/sms`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-SYROTP-Receiver": opts.receiverId,
        "X-SYROTP-Timestamp": ts,
        "X-SYROTP-Nonce": nonce,
        "X-SYROTP-Signature": sig,
        "User-Agent": "syrotp-cli/0.2 (testReceiver)",
      },
      body,
      signal: ctrl.signal,
    });
    const latencyMs = performance.now() - t0;
    const text = await res.text();
    let parsed: unknown = {};
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      parsed = { _raw: text };
    }
    const matched = (parsed as { matched?: boolean }).matched === true;
    const reason = (parsed as { reason?: string }).reason;
    return { status: res.status, ok: res.status >= 200 && res.status < 300, matched, reason, body: parsed, latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

const SAMPLE_ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function sampleCode(): string {
  const buf = randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i++) out += SAMPLE_ALPHA[buf[i]! % SAMPLE_ALPHA.length];
  return out;
}
