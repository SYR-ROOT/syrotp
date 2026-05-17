/**
 * `syrotp smoke` — thin wrapper around `node scripts/smoke.mjs`.
 *
 * The CLI does NOT re-implement the smoke flow. It only:
 *   1. Validates the env contract the smoke script expects.
 *   2. Probes /v1/health so the user gets UNREACHABLE up-front rather
 *      than a confusing failure deep in the script.
 *   3. Spawns the smoke script and forwards stdout/stderr.
 *   4. Maps the script's exit code to the stable CLI EXIT contract.
 *
 * Pass-through env contract (matches scripts/smoke.mjs):
 *   SYROTP_BASE_URL, SYROTP_PUBLIC_KEY, SYROTP_SECRET_KEY,
 *   SYROTP_RECEIVER_ID, SYROTP_GATEWAY_KEY, SYROTP_PHONE
 */
import { parseFlags } from "../argv.js";
import { missingConfig, runtime, unreachable, usage } from "../errors.js";
import { EXIT, type ExitCode } from "../exit.js";
import { bold, cyan, dim, green, red } from "../render.js";
import { type Spawner, realSpawner } from "../spawn.js";

const REQUIRED_ENV = [
  "SYROTP_BASE_URL",
  "SYROTP_PUBLIC_KEY",
  "SYROTP_SECRET_KEY",
  "SYROTP_RECEIVER_ID",
  "SYROTP_GATEWAY_KEY",
  "SYROTP_PHONE",
] as const;

export interface SmokeOptions {
  args: ReadonlyArray<string>;
  out: NodeJS.WritableStream;
  /** Injectable for tests. Production path uses realSpawner. */
  spawner?: Spawner;
  /** Injectable for tests. Default uses fetch() against /v1/health. */
  healthProbe?: HealthProbe;
}

export type HealthProbe = (baseUrl: string) => Promise<HealthResult>;
export type HealthResult =
  | { ok: true; status: string; version: string }
  | { ok: false; reason: string };

export async function runSmoke(opts: SmokeOptions): Promise<ExitCode> {
  const flags = parseFlags(opts.args, {
    flags: { help: { value: false, alias: "h" } },
  });
  if (flags.unknown) {
    throw usage(`unknown flag: ${flags.unknown}`, "run `syrotp help smoke` for usage");
  }
  if (flags.values.help) {
    opts.out.write(helpText());
    return EXIT.OK;
  }
  if (flags.positionals.length > 0) {
    throw usage(
      `unexpected argument: ${flags.positionals[0]}`,
      "smoke takes no positional args; configure via env (see `syrotp help smoke`)",
    );
  }

  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw missingConfig(
      `smoke needs env: ${missing.join(", ")}`,
      "run `syrotp bootstrap` to mint keys, then export them and SYROTP_PHONE",
    );
  }

  // Probe /v1/health first — gives the operator a clear UNREACHABLE
  // before they wade through smoke.mjs' own failure output.
  const baseUrl = process.env.SYROTP_BASE_URL!;
  const probe = opts.healthProbe ?? defaultHealthProbe;
  const health = await probe(baseUrl);
  if (!health.ok) {
    throw unreachable(
      `cannot reach ${baseUrl}/v1/health: ${health.reason}`,
      "is the SYROTP server running? check `syrotp doctor`",
    );
  }

  opts.out.write(
    `${cyan("smoke")} → target ${dim(baseUrl)} ` +
      `${dim(`(server ok, version=${health.version})`)}\n`,
  );

  // Spawn the existing script. We pass cwd=process.cwd() so the
  // operator's repo-relative `scripts/smoke.mjs` resolves; the CLI
  // assumes you're at the repo root (documented).
  const spawner = opts.spawner ?? realSpawner;
  const code = await spawner.run({
    cmd: process.execPath,
    args: ["scripts/smoke.mjs"],
  });

  if (code === 0) {
    opts.out.write(`${green("✓")} ${bold("smoke PASS")}\n`);
    return EXIT.OK;
  }
  // smoke.mjs's own codes:
  //   1 = assertion failure   → CLI 1 (RUNTIME)
  //   2 = missing env         → CLI 3 (we already checked, but defensive)
  //   3 = /v1/health failure  → CLI 5 (we already probed, but defensive)
  opts.out.write(`${red("✗")} ${bold(`smoke FAIL (script exit ${code})`)}\n`);
  if (code === 3) throw unreachable("smoke probe said server didn't respond");
  if (code === 2) throw missingConfig("smoke reported missing env (CLI pre-check missed it)");
  throw runtime(`smoke script exited ${code}`);
}

async function defaultHealthProbe(baseUrl: string): Promise<HealthResult> {
  const url = baseUrl.replace(/\/+$/, "") + "/v1/health";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = (await res.json()) as { status?: string; version?: string };
    return {
      ok: true,
      status: body.status ?? "?",
      version: body.version ?? "?",
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function helpText(): string {
  return `${bold("syrotp smoke")} — run the end-to-end smoke test against a live server

${cyan("usage")}
  syrotp smoke

${cyan("env (all required)")}
  SYROTP_BASE_URL          e.g. http://localhost:3000
  SYROTP_PUBLIC_KEY        pk_live_*
  SYROTP_SECRET_KEY        sk_live_*
  SYROTP_RECEIVER_ID       rcv_*
  SYROTP_GATEWAY_KEY       64-hex signing key
  SYROTP_PHONE             phone to verify (E.164 or local)

${cyan("what it does")}
  Wraps \`pnpm smoke\` (i.e. \`node scripts/smoke.mjs\`). The CLI checks
  required env, probes /v1/health, then spawns the script. The script's
  output goes straight to your terminal; the CLI just maps its exit code:

    script 0 → ok                 (CLI 0)
    script 1 → assertion failed   (CLI 1, RUNTIME)
    script 2 → missing env        (CLI 3, MISSING_CONFIG — defensive)
    script 3 → server not healthy (CLI 5, UNREACHABLE — defensive)

${dim("Run from the repo root — scripts/smoke.mjs is repo-relative.")}
`;
}
