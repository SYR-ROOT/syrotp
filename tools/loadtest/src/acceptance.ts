import type { RunMetrics } from "./metrics.js";

export interface AcceptanceCheck {
  name: string;
  pass: boolean;
  threshold: string;
  actual: string;
}

export interface AcceptanceResult {
  pass: boolean;
  checks: AcceptanceCheck[];
}

export interface AcceptancePolicy {
  /** Operations whose success rate is meaningful for this scenario. */
  successFor: ReadonlyArray<"start" | "inbound" | "status">;
  /** ms — local-machine target. CI may override via env. */
  p95StartMs?: number;
  p95InboundMs?: number;
  p95StatusMs?: number;
  /** Minimum success rate over the operations in `successFor`. */
  minSuccessRate?: number;
  /** Whether double-verifications must be 0 (almost always yes). */
  noDoubleVerifications?: boolean;
  /** Whether 5xx must be 0 (yes for happy-path; relaxed for storms). */
  noServerErrors?: boolean;
}

export function defaultPolicy(scenario: string): AcceptancePolicy {
  // The 400ms p95 default is a cross-platform "local" target — comfortably
  // hit on Linux native (typically ≤200ms), realistic on Windows + Docker
  // Desktop where bridging across the WSL2/Hyper-V VM adds ~5-15ms per DB
  // round-trip and a full-flow op makes ~4 of them. CI runners are slower
  // still and should pass `--p95-* 500` explicitly.
  switch (scenario) {
    case "scenario-a":
    case "scenario-b":
    case "full-flow":
      return {
        successFor: ["start", "inbound", "status"],
        p95StartMs: 400,
        p95InboundMs: 400,
        p95StatusMs: 400,
        minSuccessRate: 0.999,
        noDoubleVerifications: true,
        noServerErrors: true,
      };
    case "soak":
      // v0.9 PR #45 — sustained-load shape. Same shape as scenario-b but
      // a much larger total drives wall-clock into the 3-5 minute range,
      // exercising lease churn, abuse-signal drift, and webhook-worker
      // tick stability over time. p95 thresholds are relaxed (500ms) vs
      // scenario-b (400ms) because steady-state under sustained load
      // legitimately runs warmer than a 1k-burst. p99 is captured but
      // NOT gated in v0.9 — see docs/operational-baseline.md for why.
      return {
        successFor: ["start", "inbound", "status"],
        p95StartMs: 500,
        p95InboundMs: 500,
        p95StatusMs: 500,
        minSuccessRate: 0.999,
        noDoubleVerifications: true,
        noServerErrors: true,
      };
    case "scenario-c":
      return {
        successFor: ["start", "inbound"],
        p95StartMs: 400,
        p95InboundMs: 400,
        minSuccessRate: 0.999,
        noDoubleVerifications: true,
        noServerErrors: true,
      };
    case "start-only":
      return {
        successFor: ["start"],
        p95StartMs: 400,
        minSuccessRate: 0.999,
        noServerErrors: true,
      };
    case "inbound-only":
      return {
        successFor: ["start", "inbound"],
        p95InboundMs: 400,
        minSuccessRate: 0.999,
        noDoubleVerifications: true,
        noServerErrors: true,
      };
    case "status-polling":
      // Polling storm — 200 OR 429 is acceptable; 5xx is not.
      return {
        successFor: [],
        noServerErrors: true,
      };
    case "replay-storm":
    case "wrong-code-storm":
      // We *want* 4xx here. Just require the server doesn't melt.
      return {
        successFor: [],
        noServerErrors: true,
      };
    case "receiver-disabled":
      // Mid-flight disable causes a graceful 503 for new starts; ongoing
      // matches still complete. We only require no 5xx-on-start (503 is 5xx
      // and IS expected — relax this).
      return {
        successFor: [],
      };
    case "mixed":
      return {
        successFor: ["start", "inbound"],
        p95StartMs: 400,
        p95InboundMs: 400,
        minSuccessRate: 0.99,
        noDoubleVerifications: true,
        noServerErrors: true,
      };
    default:
      return { successFor: ["start"] };
  }
}

export function evaluate(metrics: RunMetrics, policy: AcceptancePolicy): AcceptanceResult {
  const checks: AcceptanceCheck[] = [];
  const ms = (n: number) => `${n.toFixed(2)}ms`;

  const opSnapshots = {
    start: metrics.start.snapshot(),
    inbound: metrics.inbound.snapshot(),
    status: metrics.status.snapshot(),
  };

  if (policy.p95StartMs !== undefined && metrics.start.total > 0) {
    const v = opSnapshots.start.latency.p95_ms;
    checks.push({
      name: "p95 start ≤ threshold",
      pass: v <= policy.p95StartMs,
      threshold: ms(policy.p95StartMs),
      actual: ms(v),
    });
  }
  if (policy.p95InboundMs !== undefined && metrics.inbound.total > 0) {
    const v = opSnapshots.inbound.latency.p95_ms;
    checks.push({
      name: "p95 inbound ≤ threshold",
      pass: v <= policy.p95InboundMs,
      threshold: ms(policy.p95InboundMs),
      actual: ms(v),
    });
  }
  if (policy.p95StatusMs !== undefined && metrics.status.total > 0) {
    const v = opSnapshots.status.latency.p95_ms;
    checks.push({
      name: "p95 status ≤ threshold",
      pass: v <= policy.p95StatusMs,
      threshold: ms(policy.p95StatusMs),
      actual: ms(v),
    });
  }

  if (policy.minSuccessRate !== undefined && policy.successFor.length > 0) {
    let ok = 0;
    let denom = 0;
    for (const which of policy.successFor) {
      const m = which === "start" ? metrics.start : which === "inbound" ? metrics.inbound : metrics.status;
      ok += m.ok;
      denom += m.ok + m.unexpected_4xx + m.err_5xx + m.network_err + m.timeout;
    }
    const rate = denom === 0 ? 1 : ok / denom;
    checks.push({
      name: `success rate ≥ ${pct(policy.minSuccessRate)}`,
      pass: rate >= policy.minSuccessRate,
      threshold: pct(policy.minSuccessRate),
      actual: pct(rate),
    });
  }

  if (policy.noDoubleVerifications) {
    checks.push({
      name: "no double-verifications",
      pass: metrics.double_verifications === 0,
      threshold: "0",
      actual: String(metrics.double_verifications),
    });
  }

  if (policy.noServerErrors) {
    const total5xx =
      metrics.start.err_5xx +
      metrics.inbound.err_5xx +
      metrics.status.err_5xx +
      metrics.heartbeat.err_5xx;
    checks.push({
      name: "no 5xx responses",
      pass: total5xx === 0,
      threshold: "0",
      actual: String(total5xx),
    });
  }

  // Always-on safety: any unhandled exception in the worker pool fails the run.
  checks.push({
    name: "no unhandled worker exceptions",
    pass: metrics.unhandled_exceptions === 0,
    threshold: "0",
    actual: String(metrics.unhandled_exceptions),
  });

  return { pass: checks.every((c) => c.pass), checks };
}

function pct(n: number): string {
  return (n * 100).toFixed(2) + "%";
}
