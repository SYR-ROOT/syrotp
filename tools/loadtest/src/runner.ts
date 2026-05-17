/**
 * runOne — execute a single scenario and write a per-scenario report.
 *
 * This is the building block for both the standalone CLI form
 *   `pnpm loadtest scenario-a`
 * and the suite form
 *   `pnpm loadtest suite release-baseline`.
 *
 * The caller is responsible for:
 *   - resolving the report directory (so suites can nest reports cleanly)
 *   - constructing the policy (with any CLI overrides applied)
 *   - producing a human-readable command string for the report meta
 *
 * runOne does:
 *   - load fixtures (BYO env or auto-prep via DB)
 *   - probe /v1/health (fail fast if the server is down)
 *   - run the scenario
 *   - evaluate acceptance
 *   - write the report
 *   - clean up ephemeral fixtures
 */
import { Client } from "./client.js";
import type { Fixtures } from "./env.js";
import { loadFixtures } from "./env.js";
import { RunMetrics } from "./metrics.js";
import { type AcceptancePolicy, type AcceptanceResult, evaluate } from "./acceptance.js";
import { type WrittenReport, writeReport } from "./reporter.js";
import {
  type ScenarioContext,
  disableReceiverMidpoint,
  fullFlow,
  inboundOnly,
  mixed,
  replayStorm,
  startOnly,
  statusPolling,
  wrongCodeStorm,
} from "./scenarios/index.js";

export interface ScenarioDef {
  name: string;
  defaultTotal: number;
  defaultWorkers: number;
  receivers: 1 | 2;
  run: (ctx: ScenarioContext) => Promise<void>;
}

export const SCENARIOS: Record<string, ScenarioDef> = {
  "scenario-a":        { name: "scenario-a",        defaultTotal: 1_000,  defaultWorkers: 50,  receivers: 1, run: fullFlow },
  "scenario-b":        { name: "scenario-b",        defaultTotal: 10_000, defaultWorkers: 100, receivers: 1, run: fullFlow },
  "scenario-c":        { name: "scenario-c",        defaultTotal: 2_000,  defaultWorkers: 50,  receivers: 2, run: fullFlow },
  "start-only":        { name: "start-only",        defaultTotal: 1_000,  defaultWorkers: 50,  receivers: 1, run: startOnly },
  "inbound-only":      { name: "inbound-only",      defaultTotal: 1_000,  defaultWorkers: 50,  receivers: 1, run: inboundOnly },
  "full-flow":         { name: "full-flow",         defaultTotal: 1_000,  defaultWorkers: 50,  receivers: 1, run: fullFlow },
  "status-polling":    { name: "status-polling",    defaultTotal: 5_000,  defaultWorkers: 50,  receivers: 1, run: statusPolling },
  "mixed":             { name: "mixed",             defaultTotal: 1_000,  defaultWorkers: 50,  receivers: 1, run: mixed },
  "replay-storm":      { name: "replay-storm",      defaultTotal: 1_000,  defaultWorkers: 50,  receivers: 1, run: replayStorm },
  "wrong-code-storm":  { name: "wrong-code-storm",  defaultTotal: 1_000,  defaultWorkers: 50,  receivers: 1, run: wrongCodeStorm },
  "receiver-disabled": { name: "receiver-disabled", defaultTotal: 1_000,  defaultWorkers: 50,  receivers: 2, run: fullFlow },
  // v0.9 PR #45 — sustained-load shape for the operational baseline.
  // Same fullFlow runner as scenario-b; different defaults push wall-clock
  // duration into the 3-5 minute range so steady-state behaviour (lease
  // churn, log growth, abuse-signal drift, webhook-worker tick stability)
  // shows up. Not part of the release-baseline suite — soak is opt-in via
  // `pnpm loadtest suite soak`.
  "soak":              { name: "soak",              defaultTotal: 50_000, defaultWorkers: 100, receivers: 1, run: fullFlow },
};

export interface RunOneInput {
  scenarioName: keyof typeof SCENARIOS | string;
  total: number;
  workers: number;
  csv: boolean;
  reportDir: string;
  command: string;
  policy: AcceptancePolicy;
}

export interface RunOneOutput {
  scenarioName: string;
  total: number;
  workers: number;
  reportDir: string;
  metrics: RunMetrics;
  acceptance: AcceptanceResult;
  written: WrittenReport;
  /**
   * Distinguishes a thrown error inside the scenario from a clean run that
   * happened to fail acceptance. Both produce a non-zero exit code at the
   * top level, but the report will note an unhandled exception when true.
   */
  threw: boolean;
}

export class HealthFailedError extends Error {
  constructor(public readonly status: string) {
    super(`/v1/health probe failed (${status})`);
    this.name = "HealthFailedError";
  }
}

export async function runOne(input: RunOneInput): Promise<RunOneOutput> {
  const def = SCENARIOS[input.scenarioName];
  if (!def) throw new Error(`unknown scenario: ${input.scenarioName}`);

  const fixtures = await loadFixtures({ neededReceivers: def.receivers });
  let cleanupFn: (() => Promise<void>) | undefined = fixtures.cleanup;
  try {
    const client = new Client({ baseUrl: fixtures.baseUrl });

    // Probe before doing the expensive prep / scenario work.
    const health = await client.request({ method: "GET", path: "/v1/health" });
    if (health.kind !== "ok") {
      throw new HealthFailedError(health.kind);
    }

    const metrics = new RunMetrics();
    const ctx: ScenarioContext = {
      scenario: def.name,
      total: input.total,
      workers: input.workers,
      client,
      fixtures,
      metrics,
    };
    if (def.name === "receiver-disabled") {
      const target = fixtures.receivers[0]!;
      ctx.onMidpoint = disableReceiverMidpoint(target.id);
    }

    // v0.8 PR #37 — startVerification rejects unbound phones.
    // The loadtest synthesizes phones via `phoneFromIndex(i)` for
    // `i in 0..total` (and some scenarios offset, e.g.
    // replay-storm uses `i + 1_000_000`). Pre-seed verified
    // bindings for the full range a scenario could touch so the
    // runner doesn't 403 on the first start. Production-realistic
    // direct-DB seeding mirrors what the binding ceremony would
    // do — running the full SMS round-trip for thousands of
    // synthetic phones isn't a useful loadtest of either path.
    if (fixtures.seedBindings) {
      const { phoneFromIndex } = await import("./phone.js");
      // Cover both base and offset patterns the scenarios use.
      const phones = new Set<string>();
      for (let i = 0; i < input.total; i++) phones.add(phoneFromIndex(i));
      for (let i = 0; i < input.total; i++) phones.add(phoneFromIndex(i + 1_000_000));
      await fixtures.seedBindings([...phones]);
    }

    let threw = false;
    const memBefore = process.memoryUsage();
    try {
      await def.run(ctx);
    } catch (err) {
      console.error(`[loadtest] scenario "${def.name}" threw:`, err);
      metrics.unhandled_exceptions++;
      threw = true;
    } finally {
      metrics.finishedAt = Date.now();
    }
    const memAfter = process.memoryUsage();

    const acceptance = evaluate(metrics, input.policy);

    const written = await writeReport({
      scenario: def.name,
      command: input.command,
      workers: input.workers,
      total: input.total,
      baseUrl: fixtures.baseUrl,
      csv: input.csv,
      reportDir: input.reportDir,
      metrics,
      acceptance,
      resources: {
        mem_rss_before_mb: round(memBefore.rss / 1024 / 1024),
        mem_rss_after_mb: round(memAfter.rss / 1024 / 1024),
        mem_heap_used_after_mb: round(memAfter.heapUsed / 1024 / 1024),
      },
    });

    return {
      scenarioName: def.name,
      total: input.total,
      workers: input.workers,
      reportDir: written.dir,
      metrics,
      acceptance,
      written,
      threw,
    };
  } finally {
    if (cleanupFn) {
      try {
        await cleanupFn();
      } catch (err) {
        console.warn(`[loadtest] cleanup for ${def.name} failed:`, err);
      }
    }
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function printScenarioSummary(out: RunOneOutput): void {
  const m = out.metrics.snapshot();
  console.log("");
  console.log(`  scenario:  ${out.scenarioName}`);
  console.log(`  duration:  ${m.duration_seconds.toFixed(2)}s`);
  for (const op of ["start", "inbound", "status"] as const) {
    const x = m[op];
    if (x.total === 0) continue;
    console.log(
      `  ${op.padEnd(8)} total=${x.total} ok=${x.ok} 5xx=${x.err_5xx} timeout=${x.timeout} ` +
        `p50=${x.latency.p50_ms}ms p95=${x.latency.p95_ms}ms p99=${x.latency.p99_ms}ms`,
    );
  }
  console.log("");
  for (const c of out.acceptance.checks) {
    console.log(
      `  ${c.pass ? "✅" : "❌"}  ${c.name.padEnd(40)} threshold=${c.threshold.padEnd(10)} actual=${c.actual}`,
    );
  }
  console.log("");
  console.log(`  ${out.acceptance.pass ? "✅ ACCEPTANCE PASS" : "❌ ACCEPTANCE FAIL"}`);
}
