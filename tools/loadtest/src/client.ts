/**
 * HTTP client for the load tool. Mirrors what a real developer integration +
 * gateway would do — same auth, same HMAC scheme, same headers — so the
 * scenarios actually exercise production paths.
 *
 * Each call returns a structured result so the caller can classify outcomes
 * without scraping error strings.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";

export type Outcome =
  | { kind: "ok"; status: number; body: unknown; latencyMs: number }
  | { kind: "expected_4xx"; status: number; body: unknown; latencyMs: number }
  | { kind: "unexpected_4xx"; status: number; body: unknown; latencyMs: number }
  | { kind: "err_5xx"; status: number; body: unknown; latencyMs: number }
  | { kind: "network_err"; latencyMs: number; message: string }
  | { kind: "timeout"; latencyMs: number };

export interface ClientOptions {
  baseUrl: string;
  /** ms */
  timeoutMs?: number;
}

export class Client {
  readonly baseUrl: string;
  readonly timeoutMs: number;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /**
   * `expected4xx` — for scenarios that *want* 4xx (replay storm, wrong code).
   * The client classifies the outcome accordingly so the metrics layer can
   * keep the success/failure account honest.
   */
  async request(opts: {
    method: "GET" | "POST";
    path: string;
    headers?: Record<string, string>;
    body?: string;
    expected4xx?: ReadonlyArray<number>;
  }): Promise<Outcome> {
    const url = this.baseUrl + opts.path;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    const t0 = performance.now();
    try {
      const res = await fetch(url, {
        method: opts.method,
        headers: {
          ...(opts.headers ?? {}),
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          "User-Agent": "syrotp-loadtest/0.1.1",
        },
        body: opts.body,
        signal: ctrl.signal,
      });
      const text = await res.text();
      const latency = performance.now() - t0;
      let body: unknown;
      try {
        body = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        body = { _raw: text };
      }
      if (res.status >= 200 && res.status < 300) {
        return { kind: "ok", status: res.status, body, latencyMs: latency };
      }
      if (res.status >= 500) {
        return { kind: "err_5xx", status: res.status, body, latencyMs: latency };
      }
      if (opts.expected4xx?.includes(res.status)) {
        return { kind: "expected_4xx", status: res.status, body, latencyMs: latency };
      }
      return { kind: "unexpected_4xx", status: res.status, body, latencyMs: latency };
    } catch (err) {
      const latency = performance.now() - t0;
      if (err instanceof Error && err.name === "AbortError") {
        return { kind: "timeout", latencyMs: latency };
      }
      return {
        kind: "network_err",
        latencyMs: latency,
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

// -- HMAC signing for inbound / heartbeat -----------------------------------

export function signGateway(
  receiverId: string,
  signingKey: string,
  rawBody: string,
  opts: { timestamp?: number; nonce?: string } = {},
): Record<string, string> {
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? randomBytes(16).toString("hex");
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const sig = createHmac("sha256", signingKey).update(`${ts}.${nonce}.${bodyHash}`).digest("hex");
  return {
    "X-SYROTP-Receiver": receiverId,
    "X-SYROTP-Timestamp": ts,
    "X-SYROTP-Nonce": nonce,
    "X-SYROTP-Signature": sig,
  };
}

export interface InboundPayload {
  from: string;
  to: string;
  body: string;
  receivedAt?: Date;
  idempotencyKey?: string;
  simSlot?: number;
}

export function inboundBody(p: InboundPayload): string {
  return JSON.stringify({
    from: p.from,
    to: p.to,
    body: p.body,
    received_at: (p.receivedAt ?? new Date()).toISOString(),
    idempotency_key: p.idempotencyKey ?? "lt_" + randomBytes(10).toString("hex"),
    ...(p.simSlot !== undefined ? { sim_slot: p.simSlot } : {}),
  });
}
