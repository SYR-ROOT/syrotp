/**
 * Config loader. Single source of truth for "what env do we have, where
 * did it come from."
 *
 * Order of precedence:
 *   1. process.env (already set by the shell or systemd)
 *   2. .env in the configured cwd (loaded if present, never overwrites)
 *
 * We only know about the variables doctor / future commands actually
 * read. Adding a new var means listing it in `KNOWN_VARS` so help text
 * and doctor checks stay in sync.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const KNOWN_VARS = [
  "SYROTP_BASE_URL",
  "DATABASE_URL",
  "REDIS_URL",
  "MASTER_ENCRYPTION_KEY",
  "COOKIE_SECRET",
  "PUBLIC_BASE_URL",
  "NODE_ENV",
  "LOG_LEVEL",
  "PORT",
  "HOST",
] as const;

export type KnownVar = (typeof KNOWN_VARS)[number];

export interface LoadedConfig {
  /** Absolute path to the .env file we loaded, or null if none. */
  envFilePath: string | null;
  /** True if .env was found and read successfully. */
  envFileLoaded: boolean;
  /** Vars actually present (after .env merge), values not redacted here. */
  vars: Partial<Record<KnownVar, string>>;
  /** Raw process.env after merge, for child commands that need to inspect. */
  env: NodeJS.ProcessEnv;
}

export async function loadConfig(opts: { cwd?: string; envFile?: string } = {}): Promise<LoadedConfig> {
  // INIT_CWD is set by pnpm/npm to the directory the user ran `pnpm` from,
  // before package-script `cwd` rewrites kick in. With `pnpm --filter
  // @syrotp/cli start`, pnpm chdirs into packages/cli/ but exposes the
  // original repo root via INIT_CWD. Without this, `pnpm syrotp doctor`
  // would look for .env inside packages/cli/ and never find it.
  const fallback = process.env.INIT_CWD ?? process.cwd();
  const cwd = opts.cwd ?? fallback;
  const target = opts.envFile ? opts.envFile : join(cwd, ".env");

  let envFileLoaded = false;
  if (existsSync(target)) {
    const content = await readFile(target, "utf8");
    for (const [key, value] of parseDotenv(content)) {
      // Don't overwrite values already in the environment — explicit shell
      // exports beat .env, like docker-compose / direnv / pnpm-env behavior.
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    envFileLoaded = true;
  }

  const vars: Partial<Record<KnownVar, string>> = {};
  for (const k of KNOWN_VARS) {
    const v = process.env[k];
    if (v !== undefined && v !== "") vars[k] = v;
  }

  return {
    envFilePath: existsSync(target) ? target : null,
    envFileLoaded,
    vars,
    env: process.env,
  };
}

/**
 * Tiny .env parser. Intentionally minimal — supports `KEY=value`,
 * `# comments`, blank lines, optional surrounding quotes. No expansion,
 * no variable interpolation: a config file should not have hidden side
 * effects.
 */
export function parseDotenv(content: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    // Strip a single matching pair of surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out.push([key, value]);
  }
  return out;
}

/** Mask credential-shaped values for display. */
export function redactValue(name: string, value: string): string {
  if (/SECRET|PASSWORD|TOKEN|KEY/i.test(name)) {
    if (value.length <= 8) return "[REDACTED]";
    return value.slice(0, 4) + "***" + value.slice(-2);
  }
  if (/^postgres(ql)?:\/\//i.test(value) || /^redis:\/\//i.test(value)) {
    return value.replace(/(:\/\/)[^@/]+(@)/, "$1***$2");
  }
  return value;
}
