#!/usr/bin/env node
/**
 * SYROTP load-test CLI.
 *
 *   pnpm loadtest <scenario> [options]
 *   pnpm loadtest suite <name> [options]
 *
 * Examples:
 *   pnpm loadtest scenario-a
 *   pnpm loadtest scenario-b --workers 100
 *   pnpm loadtest replay-storm --total 2000
 *   pnpm loadtest suite release-baseline
 *   pnpm loadtest suite release-baseline --continue-on-fail --csv
 */
import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultPolicy } from "./acceptance.js";
import { timestampSlug } from "./reporter.js";
import { type RunOneOutput, SCENARIOS, printScenarioSummary, runOne } from "./runner.js";
import { type PolicyOverrides, SUITES, printSuiteSummary, runSuite } from "./suites.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_OUT = resolve(__dirname, "..", "reports");

function usage(): never {
  console.error(`usage:
  syrotp-loadtest <scenario> [options]
  syrotp-loadtest suite <name> [options]

scenarios:
${Object.keys(SCENARIOS).map((s) => "  " + s).join("\n")}

suites:
${Object.entries(SUITES).map(([k, v]) => `  ${k.padEnd(20)} ${v.description}`).join("\n")}

options (all):
  --workers <N>        concurrency override
  --total <N>          total operations (single scenario only)
  --out <dir>          report root (default: tools/loadtest/reports)
  --csv                also emit ops.csv per step
  --no-acceptance      skip acceptance gating (always exit 0)
  --p95-start <ms>     override p95 acceptance for start
  --p95-inbound <ms>   override p95 acceptance for inbound
  --p95-status <ms>    override p95 acceptance for status

options (suite only):
  --continue-on-fail   keep running remaining steps after a failure

env:
  SYROTP_BASE_URL                                                 required
  SYROTP_PUBLIC_KEY/SECRET_KEY/RECEIVER_*                         BYO mode
  DATABASE_URL + MASTER_ENCRYPTION_KEY                           auto-prep mode
`);
  process.exit(2);
}

function parsePosInt(s: string, name: string): number {
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`bad value for --${name}: ${s}`);
    process.exit(2);
  }
  return n;
}

function policyOverrides(values: Record<string, unknown>): PolicyOverrides {
  const o: PolicyOverrides = {};
  if (values["p95-start"])   o.p95StartMs   = parsePosInt(String(values["p95-start"]),   "p95-start");
  if (values["p95-inbound"]) o.p95InboundMs = parsePosInt(String(values["p95-inbound"]), "p95-inbound");
  if (values["p95-status"])  o.p95StatusMs  = parsePosInt(String(values["p95-status"]),  "p95-status");
  return o;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const first = argv[0];
  if (!first || first === "--help" || first === "-h") usage();

  const isSuite = first === "suite";
  const remaining = isSuite ? argv.slice(2) : argv.slice(1);
  const targetName = isSuite ? argv[1] : first;
  if (!targetName) usage();

  const { values } = parseArgs({
    args: remaining,
    options: {
      total: { type: "string" },
      workers: { type: "string" },
      out: { type: "string" },
      csv: { type: "boolean", default: false },
      "no-acceptance": { type: "boolean", default: false },
      "continue-on-fail": { type: "boolean", default: false },
      "p95-start":   { type: "string" },
      "p95-inbound": { type: "string" },
      "p95-status":  { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  const outDir = values.out ?? DEFAULT_OUT;
  const command = "node " + process.argv.slice(1).join(" ");

  if (isSuite) {
    const def = SUITES[targetName!];
    if (!def) {
      console.error(`unknown suite: ${targetName}`);
      usage();
    }
    if (values.total !== undefined || values.workers !== undefined) {
      console.error("--total/--workers are not supported on suite runs (each step has its own defaults)");
      process.exit(2);
    }
    const suiteDir = resolve(outDir, `${timestampSlug()}-${def.name}`);
    console.log(`[loadtest] suite=${def.name} dir=${suiteDir} continueOnFail=${!!values["continue-on-fail"]}`);

    const result = await runSuite({
      suiteName: def.name,
      outDir,
      suiteDir,
      csv: !!values.csv,
      continueOnFail: !!values["continue-on-fail"],
      command,
      policyOverrides: policyOverrides(values),
    });

    printSuiteSummary(result);

    if (!values["no-acceptance"] && !result.pass) process.exit(1);
    process.exit(0);
  }

  // ----- single-scenario path -----
  const def = SCENARIOS[targetName!];
  if (!def) {
    console.error(`unknown scenario: ${targetName}`);
    usage();
  }

  const total = values.total ? parsePosInt(values.total, "total") : def.defaultTotal;
  const workers = values.workers ? parsePosInt(values.workers, "workers") : def.defaultWorkers;
  const reportDir = resolve(outDir, `${timestampSlug()}-${def.name}`);

  console.log(`[loadtest] scenario=${def.name} total=${total} workers=${workers}`);

  let result: RunOneOutput;
  try {
    result = await runOne({
      scenarioName: def.name,
      total,
      workers,
      csv: !!values.csv,
      reportDir,
      command,
      policy: { ...defaultPolicy(def.name), ...policyOverrides(values) },
    });
  } catch (err) {
    console.error("[loadtest] fatal:", err instanceof Error ? err.message : err);
    process.exit(3);
  }

  printScenarioSummary(result);
  console.log(`[loadtest] report: ${result.reportDir}`);

  if (!values["no-acceptance"] && (!result.acceptance.pass || result.threw)) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[loadtest] fatal:", err);
  process.exit(1);
});
