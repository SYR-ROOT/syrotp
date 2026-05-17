/**
 * `syrotp loadtest <quick | release-baseline>` — thin wrappers around the
 * existing pnpm scripts:
 *
 *   loadtest quick             → pnpm loadtest:quick
 *   loadtest release-baseline  → pnpm --filter @syrotp/loadtest start
 *                                  suite release-baseline [flags]
 *
 * The CLI does no scenario logic of its own. It validates the args,
 * checks env, probes /v1/health, spawns the underlying tool, and maps
 * the exit code.
 *
 * `--continue-on-fail` is only valid for `release-baseline` (the suite
 * runner is the only thing that knows how to keep going after a step
 * fails).
 *
 * `--csv` is only valid for `release-baseline` (the suite emits one
 * ops.csv per step; `quick` is a two-scenario chain that doesn't take
 * the flag through pnpm's && link).
 */
import { parseFlags } from "../argv.js";
import { missingConfig, runtime, unreachable, usage } from "../errors.js";
import { EXIT, type ExitCode } from "../exit.js";
import { bold, cyan, dim, green, red } from "../render.js";
import { type Spawner, realSpawner } from "../spawn.js";
import { type HealthProbe } from "./smoke.js";

const SUBCOMMANDS = ["quick", "release-baseline"] as const;
type Sub = (typeof SUBCOMMANDS)[number];

export interface LoadtestOptions {
  args: ReadonlyArray<string>;
  out: NodeJS.WritableStream;
  /** Injectable for tests. */
  spawner?: Spawner;
  /** Injectable for tests. */
  healthProbe?: HealthProbe;
}

export async function runLoadtest(opts: LoadtestOptions): Promise<ExitCode> {
  const [first, ...rest] = opts.args;
  if (!first || first === "--help" || first === "-h" || first === "help") {
    opts.out.write(helpText());
    return EXIT.OK;
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(first)) {
    throw usage(
      `unknown loadtest subcommand: ${first}`,
      `available: ${SUBCOMMANDS.join(" | ")}`,
    );
  }

  switch (first as Sub) {
    case "quick":
      return runQuick(rest, opts);
    case "release-baseline":
      return runReleaseBaseline(rest, opts);
  }
}

async function runQuick(args: ReadonlyArray<string>, opts: LoadtestOptions): Promise<ExitCode> {
  const flags = parseFlags(args, {
    flags: {
      help: { value: false, alias: "h" },
      // Defensively list flags that are valid for release-baseline so
      // we can give a precise error instead of a generic "unknown flag".
      "continue-on-fail": { value: false },
      csv: { value: false },
    },
  });
  if (flags.unknown) {
    throw usage(`unknown flag: ${flags.unknown}`);
  }
  if (flags.values.help) {
    opts.out.write(quickHelp());
    return EXIT.OK;
  }
  if (flags.values["continue-on-fail"]) {
    throw usage(
      "--continue-on-fail is only valid for `loadtest release-baseline`",
      "the quick path runs two scenarios via pnpm && — there's no suite to continue",
    );
  }
  if (flags.values.csv) {
    throw usage(
      "--csv is only valid for `loadtest release-baseline`",
      "the quick path doesn't pass flags through to its scenarios",
    );
  }
  if (flags.positionals.length > 0) {
    throw usage(`unexpected argument: ${flags.positionals[0]}`);
  }

  await preflightOrThrow(opts);

  opts.out.write(
    `${cyan("loadtest:quick")} → ${dim("scenario-a (50 workers) + replay-storm")}\n`,
  );
  const spawner = opts.spawner ?? realSpawner;
  const code = await spawner.run({
    cmd: "pnpm",
    args: ["loadtest:quick"],
  });
  return mapLoadtestExit(code, opts.out, "quick");
}

async function runReleaseBaseline(
  args: ReadonlyArray<string>,
  opts: LoadtestOptions,
): Promise<ExitCode> {
  const flags = parseFlags(args, {
    flags: {
      help: { value: false, alias: "h" },
      "continue-on-fail": { value: false },
      csv: { value: false },
    },
  });
  if (flags.unknown) {
    throw usage(`unknown flag: ${flags.unknown}`);
  }
  if (flags.values.help) {
    opts.out.write(releaseBaselineHelp());
    return EXIT.OK;
  }
  if (flags.positionals.length > 0) {
    throw usage(`unexpected argument: ${flags.positionals[0]}`);
  }

  await preflightOrThrow(opts);

  // Build the underlying command. We bypass the `loadtest:all` script
  // alias and call the loadtest tool's CLI directly, so we can forward
  // flags without going through an extra shell layer.
  const passthrough: string[] = ["suite", "release-baseline"];
  if (flags.values["continue-on-fail"]) passthrough.push("--continue-on-fail");
  if (flags.values.csv) passthrough.push("--csv");

  const flagSummary = [
    flags.values["continue-on-fail"] ? "continue-on-fail" : null,
    flags.values.csv ? "csv" : null,
  ].filter((s): s is string => s !== null);

  opts.out.write(
    `${cyan("loadtest:release-baseline")} → 5-step suite ` +
      (flagSummary.length > 0 ? `${dim(`[${flagSummary.join(", ")}]`)}\n` : "\n"),
  );

  const spawner = opts.spawner ?? realSpawner;
  const code = await spawner.run({
    cmd: "pnpm",
    args: ["--filter", "@syrotp/loadtest", "start", ...passthrough],
  });

  // The suite tool prints `[loadtest] suite=... dir=<path>` early in
  // its run, so the operator already saw the report directory by the
  // time we get here. We add a final pointer for readability.
  opts.out.write(
    dim("Reports: tools/loadtest/reports/<latest>-release-baseline/aggregate.json + summary.md\n"),
  );

  return mapLoadtestExit(code, opts.out, "release-baseline");
}

// -- pre-flight -------------------------------------------------------

async function preflightOrThrow(opts: LoadtestOptions): Promise<void> {
  const baseUrl = process.env.SYROTP_BASE_URL;
  if (!baseUrl) {
    throw missingConfig(
      "SYROTP_BASE_URL is not set",
      "loadtest needs to know where to drive traffic — set SYROTP_BASE_URL or run `syrotp doctor`",
    );
  }
  // The loadtest tool also accepts BYO env (SYROTP_PUBLIC_KEY etc.) OR
  // auto-prep (DATABASE_URL + MASTER_ENCRYPTION_KEY). Don't enforce a
  // specific path here — the underlying tool emits a precise error if
  // its own contract isn't met, and the CLI maps that to exit 3 below.

  const probe = opts.healthProbe ?? defaultHealthProbe;
  const health = await probe(baseUrl);
  if (!health.ok) {
    throw unreachable(
      `cannot reach ${baseUrl}/v1/health: ${health.reason}`,
      "is the SYROTP server running? check `syrotp doctor`",
    );
  }
  opts.out.write(
    `${dim(`pre-flight: server reachable (${baseUrl}, version=${health.version})`)}\n`,
  );
}

async function defaultHealthProbe(baseUrl: string) {
  const url = baseUrl.replace(/\/+$/, "") + "/v1/health";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return { ok: false as const, reason: `HTTP ${res.status}` };
    const body = (await res.json()) as { status?: string; version?: string };
    return { ok: true as const, status: body.status ?? "?", version: body.version ?? "?" };
  } catch (err) {
    return { ok: false as const, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// -- exit mapping -----------------------------------------------------

function mapLoadtestExit(
  code: number,
  out: NodeJS.WritableStream,
  variant: string,
): ExitCode {
  // The loadtest tool's own codes (see tools/loadtest/src/index.ts):
  //   0 = OK
  //   1 = acceptance failed
  //   2 = bad CLI args
  //   3 = /v1/health probe failed
  if (code === 0) {
    out.write(`${green("✓")} ${bold(`loadtest:${variant} PASS`)}\n`);
    return EXIT.OK;
  }
  out.write(`${red("✗")} ${bold(`loadtest:${variant} FAIL (tool exit ${code})`)}\n`);
  if (code === 3) throw unreachable("loadtest tool reported server unreachable");
  if (code === 2) throw runtime("loadtest tool reported bad arguments (CLI bug)");
  // 1 (acceptance failed) and any other code → RUNTIME
  throw runtime(`loadtest:${variant} acceptance failed`);
}

// -- help -------------------------------------------------------------

export function helpText(): string {
  return `${bold("syrotp loadtest")} — run the load and reliability suite

${cyan("usage")}
  syrotp loadtest <subcommand> [options]

${cyan("subcommands")}
  quick                 fast CI gate: scenario-a (50 workers) + replay-storm
  release-baseline      full 5-step suite: scenario-a, scenario-b, replay-storm,
                        wrong-code-storm, receiver-disabled

${cyan("options (release-baseline only)")}
  --continue-on-fail    keep running remaining steps after a failure
  --csv                 also emit ops.csv per step

${dim("Run `syrotp loadtest <subcommand> --help` for details.")}
`;
}

function quickHelp(): string {
  return `${bold("syrotp loadtest quick")} — fast CI gate

${cyan("usage")}
  syrotp loadtest quick

Wraps \`pnpm loadtest:quick\` — runs scenario-a (50 workers) and replay-storm
sequentially via pnpm's && link. Total time on a developer machine: a few
seconds.

${cyan("env")}
  SYROTP_BASE_URL              required (server target)
  DATABASE_URL + MASTER_ENCRYPTION_KEY   for auto-prep mode
  SYROTP_PUBLIC_KEY etc.       for BYO mode (see tools/loadtest/README.md)

${cyan("exit codes")}
  0  ok
  1  acceptance failed
  3  missing env
  5  server unreachable
`;
}

function releaseBaselineHelp(): string {
  return `${bold("syrotp loadtest release-baseline")} — the v0.x release gate

${cyan("usage")}
  syrotp loadtest release-baseline [--continue-on-fail] [--csv]

Wraps \`pnpm --filter @syrotp/loadtest start suite release-baseline\` — runs
the five-step suite that backs the published baseline numbers.

${cyan("options")}
  --continue-on-fail    don't stop on the first failed step (useful for triage)
  --csv                 emit ops.csv per step alongside report.json

${cyan("output")}
  Reports land at tools/loadtest/reports/<timestamp>-release-baseline/
  with aggregate.json + summary.md plus per-step subdirectories.

${cyan("exit codes")}
  0  every step passed AND every hard-safety counter zero
  1  acceptance failed somewhere
  3  missing env
  5  server unreachable
`;
}
