import { Client, type Outcome, signGateway, inboundBody } from "../client.js";
import type { Fixtures, Receiver } from "../env.js";
import type { OpMetrics } from "../metrics.js";

/** Classify a request outcome into the corresponding metrics bucket. */
export function record(op: OpMetrics, out: Outcome): void {
  op.total++;
  switch (out.kind) {
    case "ok":
      op.ok++;
      op.latency.add(out.latencyMs);
      break;
    case "expected_4xx":
      op.expected_4xx++;
      op.latency.add(out.latencyMs);
      break;
    case "unexpected_4xx":
      op.unexpected_4xx++;
      op.latency.add(out.latencyMs);
      break;
    case "err_5xx":
      op.err_5xx++;
      op.latency.add(out.latencyMs);
      break;
    case "network_err":
      op.network_err++;
      break;
    case "timeout":
      op.timeout++;
      break;
  }
}

/** POST /v1/verifications and record latency. */
export async function startVerification(
  client: Client,
  fx: Fixtures,
  phone: string,
  purpose = "loadtest",
): Promise<Outcome> {
  return client.request({
    method: "POST",
    path: "/v1/verifications",
    headers: { Authorization: `Bearer ${fx.publicKey}` },
    body: JSON.stringify({ phone, purpose }),
  });
}

/** GET /v1/verifications/{id}. */
export async function getVerification(client: Client, fx: Fixtures, id: string): Promise<Outcome> {
  return client.request({
    method: "GET",
    path: `/v1/verifications/${encodeURIComponent(id)}`,
    headers: { Authorization: `Bearer ${fx.secretKey}` },
  });
}

/** Look up the receiver that matches a `send_to` MSISDN. */
export function pickReceiver(fx: Fixtures, sendTo: string): Receiver {
  const r = fx.receivers.find((x) => x.msisdn === sendTo);
  if (!r) {
    // Should never happen if fixtures and server agree. Surface loudly.
    throw new Error(
      `server returned send_to=${sendTo} but no fixture receiver matches; ` +
        `known receivers: ${fx.receivers.map((x) => x.msisdn).join(", ")}`,
    );
  }
  return r;
}

/** Sign + POST an inbound SMS. Caller controls `from`, `body`, etc. */
export async function postInbound(
  client: Client,
  receiver: Receiver,
  payload: { from: string; body: string; idempotencyKey?: string; nonce?: string },
  expected4xx?: ReadonlyArray<number>,
): Promise<Outcome> {
  const raw = inboundBody({
    from: payload.from,
    to: receiver.msisdn,
    body: payload.body,
    idempotencyKey: payload.idempotencyKey,
  });
  const headers = signGateway(receiver.id, receiver.signingKey, raw, { nonce: payload.nonce });
  return client.request({
    method: "POST",
    path: "/v1/inbound/sms",
    headers,
    body: raw,
    expected4xx,
  });
}
