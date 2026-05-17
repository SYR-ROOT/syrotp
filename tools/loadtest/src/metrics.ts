import { Latencies } from "./histogram.js";

/**
 * One metrics bucket per logical operation: "start", "status", "inbound",
 * "heartbeat". Each bucket records latency + classified outcomes.
 *
 * "expected_4xx" is a deliberate channel for scenarios where 4xx is the
 * desired outcome (replay storm, wrong-code storm). It does NOT count
 * against success rate.
 */
export class OpMetrics {
  readonly latency = new Latencies();
  ok = 0;
  expected_4xx = 0;
  unexpected_4xx = 0;
  err_5xx = 0;
  network_err = 0;
  timeout = 0;
  total = 0;
  // Free-form counters for protocol-specific outcomes (matched, no_match,
  // duplicate, replay, expired, ...). Always present in the report so
  // dashboards can chart consistently.
  readonly extras: Record<string, number> = Object.create(null);

  bumpExtra(key: string): void {
    this.extras[key] = (this.extras[key] ?? 0) + 1;
  }

  successRate(): number {
    const denom = this.ok + this.unexpected_4xx + this.err_5xx + this.network_err + this.timeout;
    if (denom === 0) return 1;
    return this.ok / denom;
  }

  snapshot() {
    return {
      total: this.total,
      ok: this.ok,
      expected_4xx: this.expected_4xx,
      unexpected_4xx: this.unexpected_4xx,
      err_5xx: this.err_5xx,
      network_err: this.network_err,
      timeout: this.timeout,
      success_rate: round4(this.successRate()),
      latency: this.latency.snapshot(),
      extras: { ...this.extras },
    };
  }
}

export class RunMetrics {
  readonly start = new OpMetrics();
  readonly status = new OpMetrics();
  readonly inbound = new OpMetrics();
  readonly heartbeat = new OpMetrics();

  // Cross-cutting counts used for acceptance:
  double_verifications = 0;          // exactly-once invariant violated
  unhandled_exceptions = 0;          // anything that escaped the worker

  startedAt = Date.now();
  finishedAt = 0;

  durationSeconds(): number {
    const end = this.finishedAt > 0 ? this.finishedAt : Date.now();
    return Math.max(0, (end - this.startedAt) / 1000);
  }

  snapshot() {
    return {
      duration_seconds: round4(this.durationSeconds()),
      double_verifications: this.double_verifications,
      unhandled_exceptions: this.unhandled_exceptions,
      start: this.start.snapshot(),
      status: this.status.snapshot(),
      inbound: this.inbound.snapshot(),
      heartbeat: this.heartbeat.snapshot(),
    };
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
