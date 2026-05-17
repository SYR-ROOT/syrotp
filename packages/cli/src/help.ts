/**
 * Help text. Adding a command means updating BOTH the TOP_LEVEL block
 * here (so it shows up in `syrotp --help`) and the per-command branch in
 * `helpText()` so `syrotp help <name>` lands on the right detail page.
 */
import { bold, cyan, dim } from "./render.js";
import { helpText as bootstrapHelp } from "./commands/bootstrap.js";
import { helpText as receiverHelp } from "./commands/receiver.js";
import { helpText as smokeHelp } from "./commands/smoke.js";
import { helpText as loadtestHelp } from "./commands/loadtest.js";

const TOP_LEVEL = `${bold("syrotp")} — command-line interface for the Syrian Reverse OTP Protocol

${cyan("usage")}
  syrotp <command> [options]

${cyan("commands")}
  doctor                   check Node, pnpm, docker, .env, and reachability of postgres/redis/server
  bootstrap                create a fresh app + API keys + receiver
  receiver <sub>           manage receivers (add | list | disable | test)
  smoke                    run the end-to-end smoke test against a live server
  loadtest <sub>           run load suites (quick | release-baseline)
  version                  print the CLI version and exit
  help [<command>]         show help for a command

${cyan("global options")}
  -h, --help               show help and exit
  -v, --version            print version and exit

${cyan("environment")}
  SYROTP_BASE_URL           required for server-reachability + receiver test
  DATABASE_URL             required for postgres reachability + bootstrap + receiver
  REDIS_URL                required for redis reachability check
  MASTER_ENCRYPTION_KEY    required for bootstrap + receiver add (wraps signing key)
  SYROTP_GATEWAY_KEY        signing key for \`syrotp receiver test\` (or use --signing-key)
  NO_COLOR=1               disable ANSI color output
  DEBUG=1                  print stack traces on unexpected errors

${cyan("exit codes")}
  0  ok
  1  runtime / check failed
  2  bad arguments
  3  missing config / env
  4  missing dependency (Node, pnpm, docker)
  5  service unreachable (postgres, redis, server)

${dim("docs: see packages/cli/README.md or run `syrotp help <command>`")}
`;

const DOCTOR = `${bold("syrotp doctor")} — verify the local environment is wired up

${cyan("usage")}
  syrotp doctor [options]

${cyan("options")}
  --env-file <path>        load env from this file instead of ./.env
  --timeout <ms>           per-reachability-probe timeout (default: 3000)
  -h, --help               show this help

${cyan("checks")}
  Environment              Node ≥ 20.10, pnpm, docker, docker compose
  Configuration            .env file, DATABASE_URL, REDIS_URL, SYROTP_BASE_URL
  Reachability             postgres TCP, redis TCP, SYROTP /v1/health

${cyan("exit codes")}
  0  every check passed (skipped checks don't count as failures)
  3  a required config/env var is missing
  4  a system dependency (Node/pnpm/docker) is missing
  5  a service (postgres/redis/server) didn't answer

${dim("doctor never modifies anything — it's safe to run on a stranger's box.")}
`;

export function helpText(topic?: string): string {
  switch (topic) {
    case "doctor":
      return DOCTOR;
    case "bootstrap":
      return bootstrapHelp();
    case "receiver":
      return receiverHelp();
    case "smoke":
      return smokeHelp();
    case "loadtest":
      return loadtestHelp();
    case undefined:
    case "help":
      return TOP_LEVEL;
    default:
      return TOP_LEVEL;
  }
}
