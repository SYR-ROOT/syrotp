/**
 * `syrotp bootstrap` — wrapper around the admin module's `bootstrapApp` +
 * `addReceiver`. Same code path the legacy `dist/scripts/bootstrap.js`
 * runs, formatted for CLI use.
 *
 * Output is friendly but safe:
 *   - secrets are printed exactly once on the success path (with a clear
 *     "save these now" footer)
 *   - on ANY error path, no secrets are emitted to stdout / stderr
 *   - the underlying admin error code is exposed via the EXIT contract
 */
// IMPORTANT: do NOT statically import @syrotp/server/admin. That module
// transitively loads server/config.ts which validates env at import
// time and process.exits if anything is missing — that would kill any
// test that imports this command without a real DB env. We dynamic-
// import inside runBootstrap *after* the missing-config check has run.
import type * as Admin from "@syrotp/server/admin";
import { parseFlags } from "../argv.js";
import { CliError, missingConfig, runtime, unreachable, usage } from "../errors.js";
import { EXIT, type ExitCode } from "../exit.js";
import { bold, cyan, dim, green, yellow } from "../render.js";

export interface BootstrapCommandOptions {
  args: ReadonlyArray<string>;
  out: NodeJS.WritableStream;
}

export async function runBootstrap(opts: BootstrapCommandOptions): Promise<ExitCode> {
  const flags = parseFlags(opts.args, {
    flags: {
      "app-name": { value: true },
      "receiver-name": { value: true },
      msisdn: { value: true },
      operator: { value: true },
      "simulate-heartbeat": { value: false },
      help: { value: false, alias: "h" },
    },
  });
  if (flags.unknown) {
    throw usage(`unknown flag: ${flags.unknown}`, "run `syrotp help bootstrap` for usage");
  }
  if (flags.values.help) {
    opts.out.write(helpText());
    return EXIT.OK;
  }

  // Required args. We deliberately list every missing field at once
  // instead of stopping on the first — saves operators a round-trip when
  // they typo two flags.
  const missing: string[] = [];
  const appName = strOrNull(flags.values["app-name"]);
  const msisdn = strOrNull(flags.values["msisdn"]);
  if (!appName) missing.push("--app-name");
  if (!msisdn) missing.push("--msisdn");
  if (missing.length > 0) {
    throw usage(
      `missing required arg${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
      "example: syrotp bootstrap --app-name \"My App\" --msisdn +963991234567",
    );
  }

  const receiverName = strOrNull(flags.values["receiver-name"]) ?? "Receiver-1";
  const operator = strOrNull(flags.values["operator"]);
  const simulateHeartbeat = flags.values["simulate-heartbeat"] === true;

  // The admin module imports config.ts at module load. config validates
  // env via Zod; if anything's missing we get a process.exit(1) before
  // we can render a friendly message. We rescue that path by checking
  // the obvious required vars BEFORE invoking admin functions.
  if (!process.env.DATABASE_URL) {
    throw missingConfig(
      "DATABASE_URL is not set",
      "bootstrap writes directly to Postgres — set DATABASE_URL in .env or your shell",
    );
  }
  if (!process.env.MASTER_ENCRYPTION_KEY) {
    throw missingConfig(
      "MASTER_ENCRYPTION_KEY is not set",
      "needed to wrap the gateway signing key at rest — see SECURITY.md",
    );
  }

  // Dynamic import — only AFTER required-env checks above passed.
  const admin: typeof Admin = await import("@syrotp/server/admin");

  let app, receiver;
  try {
    app = await admin.bootstrapApp({ name: appName! });
  } catch (err) {
    throw mapAdminError(err, admin.AdminError, "bootstrapApp failed");
  }
  try {
    receiver = await admin.addReceiver({
      appId: app.appId,
      name: receiverName,
      msisdn: msisdn!,
      operator: operator ?? undefined,
      simulateHeartbeat,
    });
  } catch (err) {
    // Even partial failure: app + keys exist but receiver didn't. Don't
    // leave the operator with a half-baked record — surface the error
    // and tell them how to clean up. We don't roll back the app insert
    // because that requires explicit operator consent (a future
    // `syrotp app delete` command).
    throw mapAdminError(
      err,
      admin.AdminError,
      `bootstrapApp succeeded (app=${app.appId}) but addReceiver failed`,
    );
  }

  renderSuccess(opts.out, app, receiver, simulateHeartbeat);
  await admin.closeDb().catch(() => {});
  return EXIT.OK;
}

function strOrNull(v: string | true | undefined): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function mapAdminError(
  err: unknown,
  AdminErrorClass: typeof Admin.AdminError,
  prefix: string,
): CliError {
  if (err instanceof AdminErrorClass) {
    // Common admin error codes → CLI exit codes.
    switch (err.code) {
      case "invalid_msisdn":
      case "invalid_app_id":
      case "invalid_name":
      case "invalid_receiver_id":
        return usage(`${prefix}: ${err.message}`);
      case "app_not_found":
      case "receiver_not_found":
        return runtime(`${prefix}: ${err.message}`);
      case "app_disabled":
        return runtime(`${prefix}: ${err.message}`);
      default:
        return runtime(`${prefix}: ${err.message}`);
    }
  }
  if (err instanceof Error) {
    // Likely DB connection / network. Don't echo the raw message
    // verbatim — postgres errors include hostnames and sometimes
    // (rarely) credentials. Trim to a known-safe prefix.
    if (/ECONN|getaddrinfo|ETIMEDOUT|ENOTFOUND/i.test(err.message)) {
      return unreachable(
        `${prefix}: cannot reach Postgres`,
        `check DATABASE_URL and that the postgres container is running`,
      );
    }
    return runtime(`${prefix}: ${err.constructor.name}`);
  }
  return runtime(`${prefix}: unknown error`);
}

function renderSuccess(
  out: NodeJS.WritableStream,
  app: Admin.BootstrapAppResult,
  receiver: Admin.AddReceiverResult,
  simulateHeartbeat: boolean,
): void {
  const lines: string[] = [];
  lines.push("");
  lines.push(green("✓ ") + bold("SYROTP bootstrap complete"));
  lines.push("");
  lines.push(`${cyan("App")}`);
  lines.push(`  id      ${app.appId}`);
  lines.push(`  name    ${app.appName}`);
  lines.push("");
  lines.push(`${cyan("API keys")} ${dim("(shown once — save them now)")}`);
  lines.push(`  public  ${app.publicKey}`);
  lines.push(`  secret  ${app.secretKey}`);
  lines.push("");
  lines.push(`${cyan("Receiver")}`);
  lines.push(`  id      ${receiver.receiverId}`);
  lines.push(`  msisdn  ${receiver.msisdn}`);
  lines.push(`  name    ${receiver.name}`);
  if (receiver.operator) lines.push(`  operator ${receiver.operator}`);
  lines.push(`  signing ${receiver.signingKey}  ${dim("(paste into the Android gateway)")}`);
  lines.push("");
  if (simulateHeartbeat) {
    lines.push(
      yellow("note: ") +
        dim("--simulate-heartbeat is set — receiver shows healthy without a real gateway. Use only for tests."),
    );
  } else {
    lines.push(dim("Pair a gateway and let it heartbeat before starting verifications."));
  }
  out.write(lines.join("\n") + "\n");
}

export function helpText(): string {
  return `${bold("syrotp bootstrap")} — create a fresh app + API keys + receiver in one go

${cyan("usage")}
  syrotp bootstrap --app-name <name> --msisdn <e164-or-local> [options]

${cyan("required")}
  --app-name <name>       human-readable app name (stored in DB)
  --msisdn <phone>        receiver phone number, E.164 or local form

${cyan("optional")}
  --receiver-name <s>     receiver display name (default: "Receiver-1")
  --operator <s>          carrier name, e.g. syriatel / mtn / claro
  --simulate-heartbeat    set last_heartbeat_at = now() so the receiver
                          looks healthy without a real gateway. ONLY use
                          this for smoke/integration tests.
  -h, --help              show this help

${cyan("output")}
  Public key (pk_live_*), Secret key (sk_live_*), and gateway signing
  key are printed ${bold("exactly once")} — save them in your secret
  manager. The DB only ever holds the HMAC-derived hashes.

${cyan("exit codes")}
  0  ok
  2  bad arguments
  3  missing config (DATABASE_URL / MASTER_ENCRYPTION_KEY)
  5  Postgres unreachable
  1  any other admin error

${dim("env: DATABASE_URL, MASTER_ENCRYPTION_KEY (and helpers from .env are auto-loaded)")}
`;
}
