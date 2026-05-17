/**
 * Named suites — orchestrate multiple scenarios, write per-step reports
 * into nested folders, and emit ONE aggregate report at the suite root.
 *
 * Why suites: a release gate should be one command. Running 5 scenarios
 * by hand and stitching the results together is exactly the kind of toil
 * that makes regressions slip through.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { hostname } from "node:os";
import { execSync } from "node:child_process";
import { type AcceptancePolicy, type AcceptanceResult, defaultPolicy } from "./acceptance.js";
import {
  type RunOneOutput,
  type ScenarioDef,
  SCENARIOS,
  printScenarioSummary,
  runOne,
} from "./runner.js";
import type { OpMetrics, RunMetrics } from "./metrics.js";

export interface SuiteStep {
  scenarioName: string;
  /** Override scenario default. */
  workers?: number;
  /** Override scenario default. */
  total?: number;
}

export interface SuiteDef {
  name: string;
  description: string;
  steps: SuiteStep[];
}

export const SUITES: Record<string, SuiteDef> = {
  "release-baseline": {
    name: "release-baseline",
    description:
      "The five-scenario release gate: full-flow A/B, replay & wrong-code storms, " +
      "and graceful receiver-disabled. Should be run before tagging any release.",
    steps: [
      { scenarioName: "scenario-a" },
      { scenarioName: "scenario-b", workers: 100 },
      { scenarioName: "replay-storm" },
      { scenarioName: "wrong-code-storm" },
      { scenarioName: "receiver-disabled" },
    ],
  },
  // v0.9 PR #45 — operational baseline. Opt-in (NOT run on tag push); use
  // it to characterise steady-state behaviour over a few minutes, not to
  // gate a release. Pair with the human-side checks in
  // docs/operational-baseline.md (manual RSS/log-growth observation).
  soak: {
    name: "soak",
    description:
      "Operational soak gate: sustained full-flow over ~3-5 minutes, " +
      "followed by replay-storm + wrong-code-storm to prove adversarial " +
      "paths stay graceful at the end of the soak window, and receiver- " +
      "disabled to prove mid-flight disable still surfaces a clean 503.",
    steps: [
      { scenarioName: "soak" },
      { scenarioName: "replay-storm" },
      { scenarioName: "wrong-code-storm" },
      { scenarioName: "receiver-disabled" },
    ],
  },
};

export interface RunSuiteInput {
  suiteName: string;
  outDir: string;
  /** Pre-resolved suite directory (`<outDir>/<ts>-<suite>`). */
  suiteDir: string;
  csv: boolean;
  continueOnFail: boolean;
  command: string;
  /** CLI-supplied policy overrides applied to every step. */
  policyOverrides: PolicyOverrides;
}

export interface PolicyOverrides {
  p95StartMs?: number;
  p95InboundMs?: number;
  p95StatusMs?: number;
}

export interface SuiteResult {
  suiteName: string;
  suiteDir: string;
  pass: boolean;
  steps: SuiteStepResult[];
  hardSafety: HardSafetyTotals;
  durationSeconds: number;
  startedAt: string;
  finishedAt: string;
  ranAll: boolean;
}

export interface SuiteStepResult {
  scenarioName: string;
  pass: boolean;
  ranTo: "completed" | "skipped" | "errored";
  reportDir: string | null;
  /** Snapshot of the step's metrics, retained so we don't keep heavy refs. */
  metricsSnapshot: ReturnType<RunMetrics["snapshot"]> | null;
  acceptance: AcceptanceResult | null;
  error?: string;
}

export interface HardSafetyTotals {
  double_verifications: number;
  unhandled_exceptions: number;
  err_5xx: number;
  network_err: number;
  timeout: number;
}

const ZERO_SAFETY: HardSafetyTotals = {
  double_verifications: 0,
  unhandled_exceptions: 0,
  err_5xx: 0,
  network_err: 0,
  timeout: 0,
};

export async function runSuite(input: RunSuiteInput): Promise<SuiteResult> {
  const def = SUITES[input.suiteName];
  if (!def) throw new Error(`unknown suite: ${input.suiteName}`);

  await mkdir(input.suiteDir, { recursive: true });

  const startedAt = new Date();
  const steps: SuiteStepResult[] = [];
  const safety: HardSafetyTotals = { ...ZERO_SAFETY };
  let stoppedEarly = false;

  for (let i = 0; i < def.steps.length; i++) {
    const step = def.steps[i]!;
    const scenarioDef: ScenarioDef | undefined = SCENARIOS[step.scenarioName];
    if (!scenarioDef) {
      steps.push({
        scenarioName: step.scenarioName,
        pass: false,
        ranTo: "errored",
        reportDir: null,
        metricsSnapshot: null,
        acceptance: null,
        error: `unknown scenario: ${step.scenarioName}`,
      });
      continue;
    }

    const total = step.total ?? scenarioDef.defaultTotal;
    const workers = step.workers ?? scenarioDef.defaultWorkers;
    // Per-step report goes into a stable subfolder name (no timestamp —
    // the suite folder already encodes that).
    const reportDir = join(input.suiteDir, step.scenarioName);

    console.log(
      `\n[suite:${def.name}] step ${i + 1}/${def.steps.length}: ${step.scenarioName} ` +
        `(total=${total}, workers=${workers})`,
    );

    const policy = applyOverrides(defaultPolicy(step.scenarioName), input.policyOverrides);
    let stepResult: SuiteStepResult;
    try {
      const out: RunOneOutput = await runOne({
        scenarioName: step.scenarioName,
        total,
        workers,
        csv: input.csv,
        reportDir,
        // Each per-step report records the equivalent standalone command
        // — handy when triaging.
        command: equivalentStandaloneCommand(step, scenarioDef, input.csv, input.policyOverrides),
        policy,
      });

      printScenarioSummary(out);
      addToSafety(safety, out.metrics);

      stepResult = {
        scenarioName: step.scenarioName,
        pass: out.acceptance.pass && !out.threw,
        ranTo: "completed",
        reportDir: out.reportDir,
        metricsSnapshot: out.metrics.snapshot(),
        acceptance: out.acceptance,
      };
    } catch (err) {
      // Health probe failure or fixture prep error counts as a step error.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[suite:${def.name}] step ${step.scenarioName} errored: ${message}`);
      stepResult = {
        scenarioName: step.scenarioName,
        pass: false,
        ranTo: "errored",
        reportDir: null,
        metricsSnapshot: null,
        acceptance: null,
        error: message,
      };
    }

    steps.push(stepResult);

    if (!stepResult.pass && !input.continueOnFail) {
      stoppedEarly = true;
      // Mark remaining steps as skipped — they appear in the aggregate so
      // it's obvious what didn't run.
      for (let j = i + 1; j < def.steps.length; j++) {
        steps.push({
          scenarioName: def.steps[j]!.scenarioName,
          pass: false,
          ranTo: "skipped",
          reportDir: null,
          metricsSnapshot: null,
          acceptance: null,
        });
      }
      break;
    }
  }

  const finishedAt = new Date();
  const stepsAllPass = steps.every((s) => s.pass);
  const safetyClean =
    safety.double_verifications === 0 &&
    safety.unhandled_exceptions === 0 &&
    safety.err_5xx === 0 &&
    safety.network_err === 0 &&
    safety.timeout === 0;
  const pass = stepsAllPass && safetyClean;

  const result: SuiteResult = {
    suiteName: def.name,
    suiteDir: input.suiteDir,
    pass,
    steps,
    hardSafety: safety,
    durationSeconds: (finishedAt.getTime() - startedAt.getTime()) / 1000,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    ranAll: !stoppedEarly,
  };

  await writeAggregate(result, def, input);
  return result;
}

function applyOverrides(p: AcceptancePolicy, o: PolicyOverrides): AcceptancePolicy {
  return {
    ...p,
    ...(o.p95StartMs !== undefined ? { p95StartMs: o.p95StartMs } : {}),
    ...(o.p95InboundMs !== undefined ? { p95InboundMs: o.p95InboundMs } : {}),
    ...(o.p95StatusMs !== undefined ? { p95StatusMs: o.p95StatusMs } : {}),
  };
}

function addToSafety(safety: HardSafetyTotals, m: RunMetrics): void {
  safety.double_verifications += m.double_verifications;
  safety.unhandled_exceptions += m.unhandled_exceptions;
  for (const op of [m.start, m.inbound, m.status, m.heartbeat] as OpMetrics[]) {
    safety.err_5xx += op.err_5xx;
    safety.network_err += op.network_err;
    safety.timeout += op.timeout;
  }
}

function equivalentStandaloneCommand(
  step: SuiteStep,
  def: ScenarioDef,
  csv: boolean,
  o: PolicyOverrides,
): string {
  const parts = ["pnpm", "loadtest", step.scenarioName];
  if (step.total !== undefined && step.total !== def.defaultTotal) parts.push("--total", String(step.total));
  if (step.workers !== undefined && step.workers !== def.defaultWorkers) parts.push("--workers", String(step.workers));
  if (csv) parts.push("--csv");
  if (o.p95StartMs)   parts.push("--p95-start",   String(o.p95StartMs));
  if (o.p95InboundMs) parts.push("--p95-inbound", String(o.p95InboundMs));
  if (o.p95StatusMs)  parts.push("--p95-status",  String(o.p95StatusMs));
  return parts.join(" ");
}

// ----- aggregate report -------------------------------------------------

async function writeAggregate(
  result: SuiteResult,
  def: SuiteDef,
  input: RunSuiteInput,
): Promise<void> {
  const aggregateJson = {
    suite: def.name,
    description: def.description,
    overall: result.pass ? "PASS" : "FAIL",
    started_at: result.startedAt,
    finished_at: result.finishedAt,
    duration_seconds: round(result.durationSeconds),
    target: process.env.SYROTP_BASE_URL ?? null,
    git_commit: gitCommit(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    host: hostname(),
    command: input.command,
    ran_all: result.ranAll,
    hard_safety: result.hardSafety,
    steps: result.steps.map((s) => ({
      scenario: s.scenarioName,
      pass: s.pass,
      ran_to: s.ranTo,
      report_dir: s.reportDir ? basename(s.reportDir) : null,
      error: s.error,
      metrics: s.metricsSnapshot,
      acceptance: s.acceptance,
    })),
  };

  await writeFile(join(input.suiteDir, "aggregate.json"), JSON.stringify(aggregateJson, null, 2));
  await writeFile(join(input.suiteDir, "summary.md"), renderSuiteMarkdown(result, def, input));
}

function renderSuiteMarkdown(
  result: SuiteResult,
  def: SuiteDef,
  input: RunSuiteInput,
): string {
  const lines: string[] = [];
  lines.push(`# SYROTP Loadtest — ${def.name}`);
  lines.push("");
  lines.push(`**Overall: ${result.pass ? "✅ PASS" : "❌ FAIL"}**`);
  lines.push("");
  lines.push(`- Description: ${def.description}`);
  lines.push(`- Git commit: \`${gitCommit() ?? "unknown"}\``);
  lines.push(`- Target: \`${process.env.SYROTP_BASE_URL ?? "unknown"}\``);
  lines.push(`- Started at: ${result.startedAt}`);
  lines.push(`- Finished at: ${result.finishedAt}`);
  lines.push(`- Duration: ${result.durationSeconds.toFixed(2)}s`);
  lines.push(`- Node: ${process.version} (${process.platform}/${process.arch})`);
  lines.push(`- Host: ${hostname()}`);
  if (!result.ranAll) {
    lines.push(`- ⚠️  Stopped early on first failure (re-run with \`--continue-on-fail\` to see all)`);
  }
  lines.push("");

  lines.push("## Scenarios");
  lines.push("");
  for (const s of result.steps) {
    lines.push(formatStep(s));
  }
  lines.push("");

  lines.push("## Hard Safety");
  lines.push("");
  lines.push("| Counter | Total |");
  lines.push("|---|---:|");
  lines.push(`| double_verifications | ${result.hardSafety.double_verifications} |`);
  lines.push(`| unhandled_exceptions | ${result.hardSafety.unhandled_exceptions} |`);
  lines.push(`| err_5xx | ${result.hardSafety.err_5xx} |`);
  lines.push(`| network_err | ${result.hardSafety.network_err} |`);
  lines.push(`| timeout | ${result.hardSafety.timeout} |`);
  lines.push("");

  const stepsAllPass = result.steps.every((s) => s.pass);
  const safetyClean =
    result.hardSafety.double_verifications === 0 &&
    result.hardSafety.unhandled_exceptions === 0 &&
    result.hardSafety.err_5xx === 0 &&
    result.hardSafety.network_err === 0 &&
    result.hardSafety.timeout === 0;
  lines.push("## Final verdict");
  lines.push("");
  lines.push(`- All scenarios pass: ${stepsAllPass ? "✅" : "❌"}`);
  lines.push(`- Hard safety counters zero: ${safetyClean ? "✅" : "❌"}`);
  lines.push("");
  lines.push(`**${result.pass ? "✅ PASS" : "❌ FAIL"}**`);
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("```");
  lines.push(input.command);
  lines.push("```");
  return lines.join("\n");
}

function formatStep(s: SuiteStepResult): string {
  if (s.ranTo === "skipped") {
    return `- **${s.scenarioName}**: ⏭️ skipped`;
  }
  if (s.ranTo === "errored" || !s.metricsSnapshot) {
    return `- **${s.scenarioName}**: ❌ ERROR${s.error ? ` — ${s.error}` : ""}`;
  }

  const m = s.metricsSnapshot;
  const verdict = s.pass ? "✅ PASS" : "❌ FAIL";
  const parts: string[] = [];

  // Tailor the per-line summary to the scenario kind so the most relevant
  // numbers show up first.
  switch (s.scenarioName) {
    case "scenario-a":
    case "scenario-b":
    case "scenario-c":
    case "full-flow":
    case "mixed":
      parts.push(`p95 start=${m.start.latency.p95_ms}ms`);
      parts.push(`inbound=${m.inbound.latency.p95_ms}ms`);
      parts.push(`status=${m.status.latency.p95_ms}ms`);
      parts.push(`success=${pct(combinedSuccess(m, ["start", "inbound", "status"]))}`);
      parts.push(`5xx=${m.start.err_5xx + m.inbound.err_5xx + m.status.err_5xx}`);
      break;
    case "soak":
      // v0.9 PR #45 — soak surfaces p99 alongside p95 (advisory only —
      // p99 is NOT gated in v0.9; we're collecting baseline numbers so
      // a future PR can pick a real threshold rather than guessing one).
      parts.push(`p95 start=${m.start.latency.p95_ms}ms`);
      parts.push(`inbound=${m.inbound.latency.p95_ms}ms`);
      parts.push(`status=${m.status.latency.p95_ms}ms`);
      parts.push(
        `p99 start=${m.start.latency.p99_ms}ms inbound=${m.inbound.latency.p99_ms}ms ` +
          `status=${m.status.latency.p99_ms}ms`,
      );
      parts.push(`success=${pct(combinedSuccess(m, ["start", "inbound", "status"]))}`);
      parts.push(`5xx=${m.start.err_5xx + m.inbound.err_5xx + m.status.err_5xx}`);
      break;
    case "start-only":
      parts.push(`p95 start=${m.start.latency.p95_ms}ms`);
      parts.push(`success=${pct(combinedSuccess(m, ["start"]))}`);
      parts.push(`5xx=${m.start.err_5xx}`);
      break;
    case "inbound-only":
      parts.push(`p95 inbound=${m.inbound.latency.p95_ms}ms`);
      parts.push(`success=${pct(combinedSuccess(m, ["inbound"]))}`);
      parts.push(`5xx=${m.inbound.err_5xx}`);
      break;
    case "status-polling":
      parts.push(`p95 status=${m.status.latency.p95_ms}ms`);
      parts.push(`200=${m.status.ok}`);
      parts.push(`429=${m.status.expected_4xx + (m.status.extras["rate_limited"] ?? 0)}`);
      parts.push(`5xx=${m.status.err_5xx}`);
      break;
    case "replay-storm":
      parts.push(`replay_rejected=${m.inbound.extras["replay_rejected"] ?? 0}`);
      parts.push(`5xx=${m.inbound.err_5xx}`);
      break;
    case "wrong-code-storm":
      parts.push(`no_match=${m.inbound.extras["no_match"] ?? 0}`);
      parts.push(`matched_unexpectedly=${m.inbound.extras["matched_unexpectedly"] ?? 0}`);
      parts.push(`5xx=${m.inbound.err_5xx}`);
      break;
    case "receiver-disabled":
      parts.push(`start ok=${m.start.ok}`);
      parts.push(`inbound ok=${m.inbound.ok}`);
      parts.push(`5xx total=${m.start.err_5xx + m.inbound.err_5xx + m.status.err_5xx}`);
      break;
    default:
      parts.push(`p95 start=${m.start.latency.p95_ms}ms`);
      parts.push(`5xx=${m.start.err_5xx + m.inbound.err_5xx + m.status.err_5xx}`);
  }

  return `- **${s.scenarioName}**: ${verdict} — ${parts.join(", ")}`;
}

function combinedSuccess(
  m: ReturnType<RunMetrics["snapshot"]>,
  ops: ReadonlyArray<"start" | "inbound" | "status" | "heartbeat">,
): number {
  let ok = 0;
  let denom = 0;
  for (const o of ops) {
    const x = m[o];
    if (!x) continue;
    ok += x.ok;
    denom += x.ok + x.unexpected_4xx + x.err_5xx + x.network_err + x.timeout;
  }
  return denom === 0 ? 1 : ok / denom;
}

function pct(n: number): string {
  return (n * 100).toFixed(2) + "%";
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function gitCommit(): string | null {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

export function printSuiteSummary(result: SuiteResult): void {
  console.log("");
  console.log(`========== SUITE: ${result.suiteName} ==========`);
  console.log(`  duration: ${result.durationSeconds.toFixed(2)}s`);
  console.log(`  steps:    ${result.steps.length}`);
  for (const s of result.steps) {
    const mark = s.pass ? "✅" : s.ranTo === "skipped" ? "⏭️" : "❌";
    console.log(`    ${mark}  ${s.scenarioName.padEnd(20)} (${s.ranTo})`);
  }
  console.log("");
  console.log("  hard safety:");
  console.log(`    double_verifications=${result.hardSafety.double_verifications}`);
  console.log(`    unhandled_exceptions=${result.hardSafety.unhandled_exceptions}`);
  console.log(`    err_5xx=${result.hardSafety.err_5xx}`);
  console.log(`    network_err=${result.hardSafety.network_err}`);
  console.log(`    timeout=${result.hardSafety.timeout}`);
  console.log("");
  console.log(`  ${result.pass ? "✅ SUITE PASS" : "❌ SUITE FAIL"}`);
  console.log("");
  console.log(`  report: ${result.suiteDir}`);
}
