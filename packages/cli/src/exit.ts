/**
 * Stable exit codes — the CLI's contract with shells, CI, and operators.
 *
 * These MUST NOT change across minor versions. CI scripts and Makefiles
 * branch on them; renumbering would silently break those callers.
 *
 *   0  OK              — every command's success path
 *   1  RUNTIME         — a check or operation failed at runtime
 *   2  USAGE           — bad CLI arguments / unknown command / unknown flag
 *   3  MISSING_CONFIG  — required config / env var / .env file not present
 *   4  MISSING_DEP     — Node too old / pnpm or docker not on PATH
 *   5  UNREACHABLE     — Postgres / Redis / SYROTP server didn't answer
 */
export const EXIT = Object.freeze({
  OK: 0,
  RUNTIME: 1,
  USAGE: 2,
  MISSING_CONFIG: 3,
  MISSING_DEP: 4,
  UNREACHABLE: 5,
} as const);

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Pick the most-severe code from a set of failures. We rank in the order
 * users tend to want to fix them: dependencies first, then config, then
 * reachability, then catch-all runtime. OK is always 0.
 */
const SEVERITY: ExitCode[] = [
  EXIT.MISSING_DEP,
  EXIT.MISSING_CONFIG,
  EXIT.UNREACHABLE,
  EXIT.RUNTIME,
  EXIT.USAGE,
];

export function pickWorst(codes: ReadonlyArray<ExitCode>): ExitCode {
  if (codes.length === 0) return EXIT.OK;
  for (const candidate of SEVERITY) {
    if (codes.includes(candidate)) return candidate;
  }
  return EXIT.OK;
}

export function nameOf(code: ExitCode): string {
  for (const [name, value] of Object.entries(EXIT)) {
    if (value === code) return name;
  }
  return String(code);
}
