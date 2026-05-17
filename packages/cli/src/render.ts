/**
 * Terminal rendering helpers. We honor:
 *   - NO_COLOR=1 (https://no-color.org/)
 *   - non-TTY stdout (CI, piping) → no color, no fancy markers
 *
 * Everything stays plain text on dumb terminals; the CLI is still readable
 * when piped to a file or grep.
 */
import { CliError } from "./errors.js";
import { nameOf } from "./exit.js";

const useColor =
  !process.env.NO_COLOR &&
  process.stdout.isTTY === true &&
  process.env.TERM !== "dumb";

const ESC = "\x1b";
const ANSI = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[2m`,
  bold: `${ESC}[1m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  cyan: `${ESC}[36m`,
  gray: `${ESC}[90m`,
};

const c = (color: keyof typeof ANSI, s: string): string =>
  useColor ? `${ANSI[color]}${s}${ANSI.reset}` : s;

export const dim = (s: string) => c("dim", s);
export const bold = (s: string) => c("bold", s);
export const red = (s: string) => c("red", s);
export const green = (s: string) => c("green", s);
export const yellow = (s: string) => c("yellow", s);
export const cyan = (s: string) => c("cyan", s);
export const gray = (s: string) => c("gray", s);

export const PASS = green("✓");
export const FAIL = red("✗");
export const SKIP = gray("·");
export const WARN = yellow("!");

/**
 * Render a CliError to stderr in a consistent shape. The hint, when
 * present, is the operator's most actionable next step.
 */
export function reportError(err: CliError): void {
  process.stderr.write(`${red("error")} ${err.message}\n`);
  if (err.hint) {
    process.stderr.write(`  ${dim("hint:")} ${err.hint}\n`);
  }
  process.stderr.write(`  ${dim("exit:")} ${err.code} (${nameOf(err.code)})\n`);
}

/**
 * Render an unexpected exception. Stack is printed only when DEBUG=1 so a
 * normal terminal never shows internal paths.
 */
export function reportUnexpected(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${red("error")} unexpected: ${message}\n`);
  if (process.env.DEBUG && err instanceof Error && err.stack) {
    process.stderr.write(dim(err.stack) + "\n");
  } else {
    process.stderr.write(`  ${dim("hint:")} re-run with DEBUG=1 for stack trace\n`);
  }
}
