/**
 * @syrotp/sdk
 *
 * Universal client for the Syrian Reverse OTP Protocol. Works in Node 18+,
 * modern browsers, Bun, Deno, and edge runtimes via fetch.
 *
 * Two modes:
 *   - Public key (frontend): startVerification + getStatus only.
 *   - Secret key (backend):  full access, including cancel.
 *
 * SECURITY: Never embed a secret key (`sk_live_*`) in browser bundles. The
 * SDK does NOT enforce this at runtime — it cannot tell where it's running
 * — but the server WILL accept either type. Treat secret keys like
 * passwords.
 */

export type VerificationStatus =
  | "pending"
  | "verified"
  | "expired"
  | "cancelled"
  | "failed";

export interface Verification {
  id: string;
  status: VerificationStatus;
  phone_masked: string;
  send_to?: string;
  message?: string;
  client_ref?: string | null;
  purpose?: string;
  verified_at?: string;
  expires_at: string;
  created_at: string;
  attempts?: number;
}

export interface StartVerificationInput {
  phone: string;
  purpose: string;
  clientRef?: string;
  locale?: string;
}

export interface SyrotpClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Optional fetch override (e.g. for testing or polyfilled environments). */
  fetch?: typeof fetch;
  /** Default request timeout in milliseconds. */
  timeoutMs?: number;
  /** Optional User-Agent suffix appended to the SDK identifier. */
  userAgent?: string;
}

export class SyrotpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "SyrotpError";
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const SDK_VERSION = "0.1.0";

export class SyrotpClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(opts: SyrotpClientOptions) {
    if (!opts.baseUrl || !/^https?:\/\//.test(opts.baseUrl)) {
      throw new TypeError("baseUrl must be an http(s) URL");
    }
    if (!opts.apiKey || typeof opts.apiKey !== "string") {
      throw new TypeError("apiKey is required");
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== "function") {
      throw new TypeError(
        "global fetch is not available; pass `fetch` in options or use Node 18+",
      );
    }
    this.fetchImpl = f.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = `syrotp-sdk-js/${SDK_VERSION}${opts.userAgent ? ` ${opts.userAgent}` : ""}`;
  }

  async startVerification(input: StartVerificationInput): Promise<Verification> {
    return this.request<Verification>("POST", "/v1/verifications", {
      phone: input.phone,
      purpose: input.purpose,
      client_ref: input.clientRef,
      locale: input.locale,
    });
  }

  async getVerification(id: string): Promise<Verification> {
    if (!/^vrf_[A-Za-z0-9]+$/.test(id)) {
      throw new TypeError("invalid verification id");
    }
    return this.request<Verification>("GET", `/v1/verifications/${encodeURIComponent(id)}`);
  }

  async cancelVerification(id: string): Promise<Verification> {
    if (!/^vrf_[A-Za-z0-9]+$/.test(id)) {
      throw new TypeError("invalid verification id");
    }
    return this.request<Verification>(
      "POST",
      `/v1/verifications/${encodeURIComponent(id)}/cancel`,
    );
  }

  /**
   * Poll status until terminal or timeout. Useful for simple flows.
   * The server already enforces per-IP rate limits — keep `intervalMs >= 2000`.
   */
  async waitForVerification(
    id: string,
    opts: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Verification> {
    const interval = Math.max(2000, opts.intervalMs ?? 2500);
    const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);

    while (Date.now() < deadline) {
      if (opts.signal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      const v = await this.getVerification(id);
      if (v.status !== "pending") return v;
      await sleep(interval, opts.signal);
    }
    throw new SyrotpError("timeout", "waitForVerification timed out", 408);
  }

  // -- internals --------------------------------------------------------

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "User-Agent": this.userAgent,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(stripUndefined(body)) : undefined,
        signal: ctrl.signal,
      });

      const text = await res.text();
      let json: unknown;
      try {
        json = text.length > 0 ? JSON.parse(text) : {};
      } catch {
        throw new SyrotpError(
          "bad_response",
          `non-JSON response (status ${res.status})`,
          res.status,
        );
      }

      if (!res.ok) {
        const e = (json as { error?: { code?: string; message?: string; request_id?: string } })
          .error;
        throw new SyrotpError(
          e?.code ?? `http_${res.status}`,
          e?.message ?? `request failed with status ${res.status}`,
          res.status,
          e?.request_id,
        );
      }

      return json as T;
    } catch (err) {
      if (err instanceof SyrotpError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new SyrotpError("timeout", "request timed out", 408);
      }
      throw new SyrotpError(
        "network_error",
        err instanceof Error ? err.message : "network error",
        0,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function stripUndefined<T>(o: T): T {
  if (o == null || typeof o !== "object") return o;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
