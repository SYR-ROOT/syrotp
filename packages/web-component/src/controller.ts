import type {
  SyrotpVerificationCallbacks,
  Verification,
  VerificationStatus,
} from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 2500;

interface StatusResponse {
  status: VerificationStatus;
  expires_at: string;
  verified_at: string | null;
}

function isTerminal(s: VerificationStatus): boolean {
  return s !== "pending";
}

function computeSecondsLeft(expiresAt: string): number {
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.floor(ms / 1000));
}

export interface VerificationControllerOptions extends SyrotpVerificationCallbacks {
  baseUrl: string;
  verification: Verification;
  pollIntervalMs?: number;
}

/**
 * Framework-agnostic state machine for the SYROTP verification
 * lifecycle. Polls `${baseUrl}/v/:id/status` (the public,
 * IP-rate-limited endpoint shipped in v0.5.0), maintains a 1Hz
 * countdown, fires `onChange` on every visible state update, and
 * fires the appropriate transition callback exactly once per
 * `pending → terminal` change.
 *
 * The contract is intentionally identical to `useSyrotpVerification`
 * in `@syrotp/react`: same URL shape, same merge rules, same local
 * TTL fallback, same call order. The duplication keeps each UI
 * package self-contained until consolidation is justified.
 */
export class VerificationController {
  private opts: VerificationControllerOptions;
  private state: Verification;
  private secondsLeft: number;
  private prevStatus: VerificationStatus;
  private pollId: ReturnType<typeof setInterval> | null = null;
  private tickId: ReturnType<typeof setInterval> | null = null;
  private inflight: AbortController | null = null;
  private stopped = false;
  private started = false;

  constructor(opts: VerificationControllerOptions) {
    this.opts = opts;
    this.state = opts.verification;
    this.prevStatus = this.state.status;
    this.secondsLeft = computeSecondsLeft(this.state.expires_at);
  }

  getState(): Verification {
    return this.state;
  }

  getSecondsLeft(): number {
    return this.secondsLeft;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;

    this.opts.onChange?.(this.state, this.secondsLeft);

    if (isTerminal(this.state.status)) return;

    this.tickId = setInterval(() => this.onCountdownTick(), 1000);
    void this.poll();
    this.pollId = setInterval(
      () => void this.poll(),
      this.opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    );
  }

  stop(): void {
    this.stopped = true;
    this.inflight?.abort();
    this.inflight = null;
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.pollId !== null) {
      clearInterval(this.pollId);
      this.pollId = null;
    }
    if (this.tickId !== null) {
      clearInterval(this.tickId);
      this.tickId = null;
    }
  }

  private onCountdownTick(): void {
    if (this.state.status !== "pending") return;
    this.secondsLeft = computeSecondsLeft(this.state.expires_at);
    if (this.secondsLeft <= 0) {
      this.transition({
        ...this.state,
        status: "expired",
        send_to: null,
        message: null,
      });
    } else {
      this.opts.onChange?.(this.state, this.secondsLeft);
    }
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    if (isTerminal(this.state.status)) return;

    this.inflight = new AbortController();
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/v/${encodeURIComponent(this.state.id)}/status`;
    try {
      const res = await fetch(url, {
        signal: this.inflight.signal,
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`status poll failed: HTTP ${res.status}`);
      }
      const body = (await res.json()) as StatusResponse;
      if (this.stopped) return;

      if (body.status === this.state.status) {
        if (body.expires_at !== this.state.expires_at) {
          this.state = { ...this.state, expires_at: body.expires_at };
          this.secondsLeft = computeSecondsLeft(this.state.expires_at);
          this.opts.onChange?.(this.state, this.secondsLeft);
        }
        return;
      }

      this.transition({
        ...this.state,
        status: body.status,
        expires_at: body.expires_at,
        verified_at: body.verified_at,
        send_to: body.status === "pending" ? this.state.send_to : null,
        message: body.status === "pending" ? this.state.message : null,
      });
    } catch (err) {
      if (this.stopped) return;
      if (err instanceof Error && err.name === "AbortError") return;
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private transition(next: Verification): void {
    const prev = this.prevStatus;
    this.state = next;
    this.prevStatus = next.status;
    this.secondsLeft = computeSecondsLeft(next.expires_at);
    this.opts.onChange?.(next, this.secondsLeft);
    if (prev !== next.status && prev === "pending") {
      if (next.status === "verified") this.opts.onVerified?.(next);
      else if (next.status === "expired") this.opts.onExpired?.(next);
      else if (next.status === "cancelled") this.opts.onCancelled?.(next);
    }
    if (isTerminal(next.status)) {
      this.clearTimers();
    }
  }
}
