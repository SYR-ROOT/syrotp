/**
 * `syrotp doctor` — runs every reachability and config check and prints a
 * single readable report.
 *
 * Behavior:
 *   - All checks run, regardless of earlier failures.
 *   - Output is grouped: environment / configuration / reachability.
 *   - Exit code is the WORST category that produced a failure (see
 *     pickWorst in src/exit.ts).
 *
 * Output is plain text; structured callers (CI / scripts) should branch
 * on exit code, not parse stdout. A future PR can add `--json`.
 */
import { loadConfig } from "../config.js";
import {
  type CheckContext,
  type CheckResult,
  checkDocker,
  checkDockerCompose,
  checkEnvFile,
  checkEnvVar,
  checkNode,
  checkPnpm,
  checkPostgres,
  checkRedis,
  checkServerHealth,
} from "../checks/index.js";
import { EXIT, type ExitCode, pickWorst } from "../exit.js";
import { FAIL, PASS, SKIP, bold, cyan, dim, gray } from "../render.js";

export interface DoctorOptions {
  cwd?: string;
  envFile?: string;
  timeoutMs?: number;
  out?: NodeJS.WritableStream;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<ExitCode> {
  const out = opts.out ?? process.stdout;
  const config = await loadConfig({ cwd: opts.cwd, envFile: opts.envFile });
  const ctx: CheckContext = { config, timeoutMs: opts.timeoutMs };

  const env: CheckResult[] = await Promise.all([
    checkNode(),
    checkPnpm(),
    checkDocker(),
    checkDockerCompose(),
  ]);

  const cfg: CheckResult[] = [
    checkEnvFile(ctx),
    checkEnvVar("DATABASE_URL", ctx),
    checkEnvVar("REDIS_URL", ctx),
    checkEnvVar("SYROTP_BASE_URL", ctx),
  ];

  const reach: CheckResult[] = await Promise.all([
    checkPostgres(ctx),
    checkRedis(ctx),
    checkServerHealth(ctx),
  ]);

  printGroup(out, "Environment", env);
  printGroup(out, "Configuration", cfg);
  printGroup(out, "Reachability", reach);

  const all = [...env, ...cfg, ...reach];
  const failureCodes: ExitCode[] = [];
  for (const r of all) {
    if (r.status !== "fail") continue;
    if (r.category === "dep") failureCodes.push(EXIT.MISSING_DEP);
    else if (r.category === "config") failureCodes.push(EXIT.MISSING_CONFIG);
    else if (r.category === "reachability") failureCodes.push(EXIT.UNREACHABLE);
  }

  const passed = all.filter((r) => r.status === "pass").length;
  const failed = all.filter((r) => r.status === "fail").length;
  const skipped = all.filter((r) => r.status === "skip").length;

  out.write("\n");
  if (failed === 0) {
    out.write(`${PASS} ${bold(`all checks passed`)} ${dim(`(${passed} ok, ${skipped} skipped)`)}\n`);
    return EXIT.OK;
  }
  out.write(`${FAIL} ${bold(`${failed} check${failed === 1 ? "" : "s"} failed`)} ${dim(`(${passed} ok, ${skipped} skipped)`)}\n`);
  return pickWorst(failureCodes);
}

function printGroup(out: NodeJS.WritableStream, title: string, results: CheckResult[]): void {
  out.write(`\n${cyan(title)}\n`);
  const longestTitle = Math.max(...results.map((r) => r.title.length));
  for (const r of results) {
    const marker = r.status === "pass" ? PASS : r.status === "fail" ? FAIL : SKIP;
    const titleCol = r.title.padEnd(longestTitle);
    let line = `  ${marker} ${titleCol}`;
    if (r.detail) line += `  ${gray(r.detail)}`;
    out.write(line + "\n");
    if (r.status === "fail" && r.hint) {
      out.write(`     ${dim("hint:")} ${r.hint}\n`);
    }
  }
}
