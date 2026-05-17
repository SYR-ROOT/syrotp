/**
 * HMAC signing helper for tests. Mirrors what a real gateway (Android /
 * GSM modem) does so tests fail if the protocol drifts.
 *
 * Signature input: "<unix-seconds>.<nonce>.<sha256(rawBody)>"
 */
import { createHash, createHmac, randomBytes } from "node:crypto";

export interface SignedHeaders {
  "x-syrotp-receiver": string;
  "x-syrotp-timestamp": string;
  "x-syrotp-nonce": string;
  "x-syrotp-signature": string;
  "content-type": string;
}

export function signGateway(
  receiverId: string,
  signingKey: string,
  rawBody: string | Buffer,
  opts: { timestamp?: number; nonce?: string } = {},
): SignedHeaders {
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? randomBytes(16).toString("hex");
  const bodyHash = createHash("sha256").update(buf).digest("hex");
  const payload = `${ts}.${nonce}.${bodyHash}`;
  const sig = createHmac("sha256", signingKey).update(payload).digest("hex");
  return {
    "x-syrotp-receiver": receiverId,
    "x-syrotp-timestamp": ts,
    "x-syrotp-nonce": nonce,
    "x-syrotp-signature": sig,
    "content-type": "application/json",
  };
}

/**
 * Build a canonical inbound SMS body. Returns the exact bytes we sign,
 * so tests can swap the body and prove the signature is bound to bytes.
 */
export function inboundBody(input: {
  from: string;
  to: string;
  body: string;
  receivedAt?: Date;
  idempotencyKey?: string;
  simSlot?: number;
}): string {
  return JSON.stringify({
    from: input.from,
    to: input.to,
    body: input.body,
    received_at: (input.receivedAt ?? new Date()).toISOString(),
    idempotency_key: input.idempotencyKey ?? "test_" + randomBytes(8).toString("hex"),
    ...(input.simSlot !== undefined ? { sim_slot: input.simSlot } : {}),
  });
}
