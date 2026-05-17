import { EXIT, type ExitCode } from "./exit.js";

/**
 * Typed CLI error. Anything thrown that isn't a CliError gets reported as
 * an internal/runtime error with code=1 and a redacted stack trace — we
 * never want unhandled exceptions to print a JS stack to the operator's
 * terminal.
 */
export class CliError extends Error {
  constructor(
    public readonly code: ExitCode,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export const usage = (message: string, hint?: string) =>
  new CliError(EXIT.USAGE, message, hint);

export const missingConfig = (message: string, hint?: string) =>
  new CliError(EXIT.MISSING_CONFIG, message, hint);

export const missingDep = (message: string, hint?: string) =>
  new CliError(EXIT.MISSING_DEP, message, hint);

export const unreachable = (message: string, hint?: string) =>
  new CliError(EXIT.UNREACHABLE, message, hint);

export const runtime = (message: string, hint?: string) =>
  new CliError(EXIT.RUNTIME, message, hint);
