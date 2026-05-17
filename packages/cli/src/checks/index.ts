/**
 * Doctor checks. Each check is a small async function that returns a
 * structured result so the doctor command can render them uniformly and
 * pick a suitable exit code.
 *
 * "category" maps a failure to one of the documented exit codes:
 *   - "dep"          → EXIT.MISSING_DEP    (4)
 *   - "config"       → EXIT.MISSING_CONFIG (3)
 *   - "reachability" → EXIT.UNREACHABLE    (5)
 *
 * "skip" exists so a check can opt out cleanly when its preconditions
 * aren't met (e.g. don't try to ping postgres if DATABASE_URL is unset —
 * that's already a different check's failure).
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { Socket } from "node:net";
import type { LoadedConfig } from "../config.js";

const exec = promisify(execFile);

export type Category = "dep" | "config" | "reachability";

export interface CheckResult {
  title: string;
  status: "pass" | "fail" | "skip";
  category: Category;
  detail?: string;
  hint?: string;
}

export interface CheckContext {
  config: LoadedConfig;
  /** ms — caps each per-check timeout. */
  timeoutMs?: number;
}

// -- environment / dependency checks -------------------------------------

export async function checkNode(): Promise<CheckResult> {
  const v = process.versions.node;
  const [maj, min] = v.split(".").map((n) => Number.parseInt(n, 10));
  const ok = maj !== undefined && (maj > 20 || (maj === 20 && (min ?? 0) >= 10));
  return {
    title: "node ≥ 20.10",
    status: ok ? "pass" : "fail",
    category: "dep",
    detail: `v${v}`,
    hint: ok ? undefined : "install Node 20.10+ from https://nodejs.org",
  };
}

export async function checkOnPath(
  cmd: string,
  args: string[],
  title: string,
  hint: string,
): Promise<CheckResult> {
  // On Windows, npm-style binaries (pnpm, npx, ...) are `.cmd` shims, not
  // real `.exe` files. execFile won't follow them without a shell, which
  // makes them appear "not installed" even when they are. Enable the
  // shell only on Windows; args are hard-coded so there's no injection.
  try {
    const { stdout } = await exec(cmd, args, {
      timeout: 5000,
      windowsHide: true,
      shell: process.platform === "win32",
    });
    const detail = stdout.toString().split(/\r?\n/)[0]?.trim() ?? cmd;
    return { title, status: "pass", category: "dep", detail };
  } catch {
    return { title, status: "fail", category: "dep", hint };
  }
}

export const checkPnpm = () =>
  checkOnPath("pnpm", ["--version"], "pnpm", "install via `npm install -g pnpm` or `corepack enable`");

export const checkDocker = () =>
  checkOnPath("docker", ["--version"], "docker", "install Docker Desktop or Docker Engine");

export const checkDockerCompose = () =>
  checkOnPath("docker", ["compose", "version"], "docker compose", "update Docker — compose v2+ is bundled");

// -- config / file presence ---------------------------------------------

export function checkEnvFile(ctx: CheckContext): CheckResult {
  if (!ctx.config.envFilePath) {
    return {
      title: ".env",
      status: "fail",
      category: "config",
      hint: "copy .env.example → .env and fill in MASTER_ENCRYPTION_KEY + COOKIE_SECRET",
    };
  }
  if (!existsSync(ctx.config.envFilePath)) {
    return {
      title: ".env",
      status: "fail",
      category: "config",
      detail: ctx.config.envFilePath,
      hint: "copy .env.example → .env and fill secrets",
    };
  }
  const count = Object.keys(ctx.config.vars).length;
  return {
    title: ".env",
    status: "pass",
    category: "config",
    detail: `${ctx.config.envFilePath} (${count} known vars)`,
  };
}

export function checkEnvVar(name: string, ctx: CheckContext): CheckResult {
  const v = ctx.config.env[name];
  if (!v) {
    return {
      title: name,
      status: "fail",
      category: "config",
      hint: `set ${name} in .env or your shell`,
    };
  }
  return { title: name, status: "pass", category: "config", detail: maskForDisplay(name, v) };
}

function maskForDisplay(name: string, value: string): string {
  if (/SECRET|PASSWORD|TOKEN|KEY/i.test(name)) {
    return value.length <= 8 ? "[REDACTED]" : `${value.slice(0, 4)}***${value.slice(-2)}`;
  }
  if (/^postgres(ql)?:\/\//i.test(value) || /^redis:\/\//i.test(value)) {
    return value.replace(/(:\/\/)[^@/]+(@)/, "$1***$2");
  }
  return value;
}

// -- reachability checks ------------------------------------------------

/**
 * TCP probe: open a socket and let it connect or time out. We don't speak
 * the actual protocol — that would require pulling pg / ioredis into the
 * CLI bundle. Operators usually want to know "is anything listening" first.
 */
async function tcpProbe(host: string, port: number, timeoutMs: number): Promise<{ ok: true } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (result: { ok: true } | { ok: false; reason: string }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, reason: `connect timeout after ${timeoutMs}ms` }));
    socket.once("error", (err: Error) => finish({ ok: false, reason: err.message }));
    socket.once("connect", () => finish({ ok: true }));
    socket.connect(port, host);
  });
}

export async function checkPostgres(ctx: CheckContext): Promise<CheckResult> {
  const url = ctx.config.env.DATABASE_URL;
  if (!url) return { title: "postgres reachable", status: "skip", category: "reachability", detail: "DATABASE_URL not set" };
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { return { title: "postgres reachable", status: "fail", category: "reachability", hint: "DATABASE_URL is not a valid URL" }; }
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : 5432;
  const result = await tcpProbe(parsed.hostname, port, ctx.timeoutMs ?? 3000);
  if (result.ok) {
    return { title: "postgres reachable", status: "pass", category: "reachability", detail: `${parsed.hostname}:${port}` };
  }
  return {
    title: "postgres reachable",
    status: "fail",
    category: "reachability",
    detail: `${parsed.hostname}:${port}: ${result.reason}`,
    hint: "is the postgres container running? check with `docker compose ps`",
  };
}

export async function checkRedis(ctx: CheckContext): Promise<CheckResult> {
  const url = ctx.config.env.REDIS_URL;
  if (!url) return { title: "redis reachable", status: "skip", category: "reachability", detail: "REDIS_URL not set" };
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { return { title: "redis reachable", status: "fail", category: "reachability", hint: "REDIS_URL is not a valid URL" }; }
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : 6379;
  const result = await tcpProbe(parsed.hostname, port, ctx.timeoutMs ?? 3000);
  if (result.ok) {
    return { title: "redis reachable", status: "pass", category: "reachability", detail: `${parsed.hostname}:${port}` };
  }
  return {
    title: "redis reachable",
    status: "fail",
    category: "reachability",
    detail: `${parsed.hostname}:${port}: ${result.reason}`,
    hint: "is the redis container running? check with `docker compose ps`",
  };
}

export async function checkServerHealth(ctx: CheckContext): Promise<CheckResult> {
  const base = ctx.config.env.SYROTP_BASE_URL;
  if (!base) {
    return { title: "server /v1/health", status: "skip", category: "reachability", detail: "SYROTP_BASE_URL not set" };
  }
  const url = base.replace(/\/+$/, "") + "/v1/health";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ctx.timeoutMs ?? 3000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      return {
        title: "server /v1/health",
        status: "fail",
        category: "reachability",
        detail: `${url}: HTTP ${res.status}`,
        hint: "is the SYROTP server running? `docker compose up -d server` or `node apps/server/dist/index.js`",
      };
    }
    const body = (await res.json()) as { status?: string; version?: string };
    return {
      title: "server /v1/health",
      status: "pass",
      category: "reachability",
      detail: `${url} → status=${body.status ?? "?"}, version=${body.version ?? "?"}`,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      title: "server /v1/health",
      status: "fail",
      category: "reachability",
      detail: `${url}: ${reason}`,
      hint: "is the SYROTP server running? check with `curl ${SYROTP_BASE_URL}/v1/health`",
    };
  } finally {
    clearTimeout(timer);
  }
}
