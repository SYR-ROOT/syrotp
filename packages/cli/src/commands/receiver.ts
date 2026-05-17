/**
 * `syrotp receiver <add|list|disable|test>` — wrappers around the admin
 * module's receiver functions. Same DB writes the production server
 * uses (no parallel implementation).
 *
 * Each subcommand:
 *   - validates its own args and renders friendly usage on bad input
 *   - maps AdminError codes to stable CLI exit codes (see exit.ts)
 *   - never echoes raw error stacks to stdout/stderr
 */
// Dynamic-import @syrotp/server/admin from inside each subcommand AFTER
// the missing-config check passes. See commands/bootstrap.ts for the
// rationale (config.ts validates env at import time and process.exits).
import type * as Admin from "@syrotp/server/admin";
import type { ReceiverRecord } from "@syrotp/server/admin";
import { parseFlags } from "../argv.js";
import { CliError, missingConfig, runtime, unreachable, usage } from "../errors.js";
import { EXIT, type ExitCode } from "../exit.js";
import { bold, cyan, dim, gray, green, red, yellow } from "../render.js";

export interface ReceiverCommandOptions {
  args: ReadonlyArray<string>;
  out: NodeJS.WritableStream;
}

const SUBCOMMANDS = ["add", "list", "disable", "enable", "test"] as const;
type Sub = (typeof SUBCOMMANDS)[number];

export async function runReceiver(opts: ReceiverCommandOptions): Promise<ExitCode> {
  const [first, ...rest] = opts.args;
  if (!first || first === "--help" || first === "-h") {
    opts.out.write(helpText());
    return EXIT.OK;
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(first)) {
    throw usage(
      `unknown receiver subcommand: ${first}`,
      `available: ${SUBCOMMANDS.join(" | ")}`,
    );
  }

  switch (first as Sub) {
    case "add":     return runAdd(rest, opts.out);
    case "list":    return runList(rest, opts.out);
    case "disable": return runDisable(rest, opts.out);
    case "enable":  return runEnable(rest, opts.out);
    case "test":    return runTest(rest, opts.out);
  }
}

// ----- receiver add ------------------------------------------------

async function runAdd(args: ReadonlyArray<string>, out: NodeJS.WritableStream): Promise<ExitCode> {
  const flags = parseFlags(args, {
    flags: {
      "app-id": { value: true },
      name: { value: true },
      msisdn: { value: true },
      operator: { value: true },
      "simulate-heartbeat": { value: false },
      help: { value: false, alias: "h" },
    },
  });
  if (flags.unknown) throw usage(`unknown flag: ${flags.unknown}`);
  if (flags.values.help) {
    out.write(addHelp());
    return EXIT.OK;
  }

  const missing: string[] = [];
  const appId = strOrNull(flags.values["app-id"]);
  const name = strOrNull(flags.values.name);
  const msisdn = strOrNull(flags.values.msisdn);
  if (!appId) missing.push("--app-id");
  if (!name) missing.push("--name");
  if (!msisdn) missing.push("--msisdn");
  if (missing.length > 0) {
    throw usage(
      `missing required arg${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
      "example: syrotp receiver add --app-id app_... --name syriatel-01 --msisdn +963998887777",
    );
  }

  requireDbEnv();
  const admin: typeof Admin = await import("@syrotp/server/admin");

  let receiver;
  try {
    receiver = await admin.addReceiver({
      appId: appId!,
      name: name!,
      msisdn: msisdn!,
      operator: strOrNull(flags.values.operator) ?? undefined,
      simulateHeartbeat: flags.values["simulate-heartbeat"] === true,
    });
  } catch (err) {
    throw mapAdminError(err, admin.AdminError, "addReceiver");
  }

  const lines: string[] = [];
  lines.push("");
  lines.push(green("✓ ") + bold("Receiver added"));
  lines.push("");
  lines.push(`  id      ${receiver.receiverId}`);
  lines.push(`  app     ${receiver.appId}  ${dim(receiver.appName)}`);
  lines.push(`  name    ${receiver.name}`);
  lines.push(`  msisdn  ${receiver.msisdn}`);
  if (receiver.operator) lines.push(`  operator ${receiver.operator}`);
  lines.push("");
  lines.push(`${cyan("Signing key")} ${dim("(shown once — paste into the gateway)")}`);
  lines.push(`  ${receiver.signingKey}`);
  lines.push("");
  out.write(lines.join("\n") + "\n");
  await admin.closeDb().catch(() => {});
  return EXIT.OK;
}

// ----- receiver list -----------------------------------------------

async function runList(args: ReadonlyArray<string>, out: NodeJS.WritableStream): Promise<ExitCode> {
  const flags = parseFlags(args, {
    flags: {
      "app-id": { value: true },
      "include-disabled": { value: false },
      json: { value: false },
      help: { value: false, alias: "h" },
    },
  });
  if (flags.unknown) throw usage(`unknown flag: ${flags.unknown}`);
  if (flags.values.help) {
    out.write(listHelp());
    return EXIT.OK;
  }

  requireDbEnv();
  const admin: typeof Admin = await import("@syrotp/server/admin");

  let rows: ReceiverRecord[];
  try {
    rows = await admin.listReceivers({
      appId: strOrNull(flags.values["app-id"]) ?? undefined,
      includeDisabled: flags.values["include-disabled"] === true || true, // include by default
    });
  } catch (err) {
    throw mapAdminError(err, admin.AdminError, "listReceivers");
  }

  if (flags.values.json === true) {
    out.write(JSON.stringify(rows.map(serializeRecord), null, 2) + "\n");
  } else {
    renderTable(out, rows);
  }
  await admin.closeDb().catch(() => {});
  return EXIT.OK;
}

function serializeRecord(r: ReceiverRecord) {
  return {
    id: r.id,
    app_id: r.appId,
    app_name: r.appName,
    name: r.name,
    operator: r.operator,
    msisdn: r.msisdn,
    enabled: r.enabled,
    healthy: r.healthy,
    last_heartbeat_at: r.lastHeartbeatAt?.toISOString() ?? null,
    last_heartbeat_ago_seconds: r.lastHeartbeatAgoSeconds,
    created_at: r.createdAt.toISOString(),
  };
}

function renderTable(out: NodeJS.WritableStream, rows: ReceiverRecord[]): void {
  if (rows.length === 0) {
    out.write(dim("no receivers\n"));
    return;
  }
  const headers = ["ID", "MSISDN", "NAME", "OPERATOR", "STATE", "HEARTBEAT"];
  const data = rows.map((r) => [
    r.id,
    r.msisdn,
    r.name,
    r.operator ?? "",
    r.enabled ? (r.healthy ? green("healthy") : yellow("stale")) : red("disabled"),
    r.lastHeartbeatAgoSeconds === null
      ? dim("never")
      : r.lastHeartbeatAgoSeconds < 60
        ? `${r.lastHeartbeatAgoSeconds}s ago`
        : `${Math.floor(r.lastHeartbeatAgoSeconds / 60)}m ago`,
  ]);
  // Compute column widths from raw lengths (strip ANSI for width).
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((row) => stripAnsi(row[i] ?? "").length)),
  );
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - stripAnsi(s).length));
  out.write(headers.map((h, i) => bold(pad(h, widths[i]!))).join("  ") + "\n");
  out.write(headers.map((_, i) => "─".repeat(widths[i]!)).join("  ") + "\n");
  for (const row of data) {
    out.write(row.map((c, i) => pad(c, widths[i]!)).join("  ") + "\n");
  }
}

// ----- receiver disable --------------------------------------------

async function runDisable(args: ReadonlyArray<string>, out: NodeJS.WritableStream): Promise<ExitCode> {
  const flags = parseFlags(args, {
    flags: {
      id: { value: true },
      help: { value: false, alias: "h" },
    },
  });
  if (flags.unknown) throw usage(`unknown flag: ${flags.unknown}`);
  if (flags.values.help) {
    out.write(disableHelp());
    return EXIT.OK;
  }

  // Accept --id <rcv_xxx> OR a positional argument for ergonomics.
  const idFromFlag = strOrNull(flags.values.id);
  const idFromPos = flags.positionals[0];
  const id = idFromFlag ?? idFromPos;
  if (!id) {
    throw usage(
      "missing receiver id",
      "example: syrotp receiver disable rcv_01H...  (or --id rcv_01H...)",
    );
  }

  requireDbEnv();
  const admin: typeof Admin = await import("@syrotp/server/admin");

  let result;
  try {
    result = await admin.disableReceiver(id);
  } catch (err) {
    throw mapAdminError(err, admin.AdminError, "disableReceiver");
  }

  if (result.wasEnabled) {
    out.write(`${green("✓")} disabled ${result.id} ${dim(`(${result.msisdn})`)}\n`);
  } else {
    out.write(`${yellow("·")} ${result.id} was already disabled ${dim(`(${result.msisdn})`)}\n`);
  }
  await admin.closeDb().catch(() => {});
  return EXIT.OK;
}

// ----- receiver enable ---------------------------------------------

async function runEnable(args: ReadonlyArray<string>, out: NodeJS.WritableStream): Promise<ExitCode> {
  const flags = parseFlags(args, {
    flags: {
      id: { value: true },
      help: { value: false, alias: "h" },
    },
  });
  if (flags.unknown) throw usage(`unknown flag: ${flags.unknown}`);
  if (flags.values.help) {
    out.write(enableHelp());
    return EXIT.OK;
  }

  const idFromFlag = strOrNull(flags.values.id);
  const idFromPos = flags.positionals[0];
  const id = idFromFlag ?? idFromPos;
  if (!id) {
    throw usage(
      "missing receiver id",
      "example: syrotp receiver enable rcv_01H...  (or --id rcv_01H...)",
    );
  }

  requireDbEnv();
  const admin: typeof Admin = await import("@syrotp/server/admin");

  let result;
  try {
    result = await admin.enableReceiver(id);
  } catch (err) {
    throw mapAdminError(err, admin.AdminError, "enableReceiver");
  }

  if (result.wasDisabled) {
    out.write(`${green("✓")} enabled ${result.id} ${dim(`(${result.msisdn})`)}\n`);
  } else {
    out.write(`${yellow("·")} ${result.id} was already enabled ${dim(`(${result.msisdn})`)}\n`);
  }
  await admin.closeDb().catch(() => {});
  return EXIT.OK;
}

// ----- receiver test -----------------------------------------------

async function runTest(args: ReadonlyArray<string>, out: NodeJS.WritableStream): Promise<ExitCode> {
  const flags = parseFlags(args, {
    flags: {
      id: { value: true },
      "signing-key": { value: true },
      "base-url": { value: true },
      timeout: { value: true },
      help: { value: false, alias: "h" },
    },
  });
  if (flags.unknown) throw usage(`unknown flag: ${flags.unknown}`);
  if (flags.values.help) {
    out.write(testHelp());
    return EXIT.OK;
  }

  const idFlag = strOrNull(flags.values.id);
  const idPos = flags.positionals[0];
  const id = idFlag ?? idPos;
  const signingKey =
    strOrNull(flags.values["signing-key"]) ?? process.env.SYROTP_GATEWAY_KEY ?? null;
  const baseUrl =
    strOrNull(flags.values["base-url"]) ?? process.env.SYROTP_BASE_URL ?? null;

  const missing: string[] = [];
  if (!id) missing.push("receiver id (positional or --id)");
  if (!signingKey) missing.push("--signing-key (or SYROTP_GATEWAY_KEY env)");
  if (!baseUrl) missing.push("--base-url (or SYROTP_BASE_URL env)");
  if (missing.length > 0) {
    throw usage(
      `missing required input: ${missing.join(", ")}`,
      "example: syrotp receiver test rcv_01H... --signing-key <hex> --base-url http://localhost:3000",
    );
  }

  let timeoutMs: number | undefined;
  const t = strOrNull(flags.values.timeout);
  if (t !== null) {
    const n = Number.parseInt(t, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw usage(`--timeout must be a positive integer (got: ${t})`);
    }
    timeoutMs = n;
  }

  // testReceiver lives at `@syrotp/server/admin/probe` — a separate
  // module path that doesn't pull in db/redis. Skip requireDbEnv here
  // AND avoid the heavier admin module so a bare `syrotp receiver test`
  // runs even when no DB is configured.
  const probe = await import("@syrotp/server/admin/probe");

  let res;
  try {
    res = await probe.testReceiver({
      receiverId: id!,
      signingKey: signingKey!,
      baseUrl: baseUrl!,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  } catch (err) {
    // testReceiver only does HTTP. Any thrown error here means we never
    // got a response — by definition that's UNREACHABLE. Node's fetch
    // wraps the real cause in `err.cause`, so checking only err.message
    // would miss "fetch failed" wrapping a connection refused.
    void err;
    throw unreachable(
      `cannot reach ${baseUrl}`,
      "is the SYROTP server running? check `syrotp doctor`",
    );
  }

  // 2xx with matched=false is success: the probe was accepted, signed
  // correctly, and the no-pending-verification "no_match" reason came
  // back as expected. 401 means the signing key is wrong. 5xx means the
  // server hit an error.
  out.write("");
  if (res.ok && !res.matched) {
    out.write(`${green("✓")} ${bold("receiver healthy")}  ${gray(`(${res.latencyMs.toFixed(1)}ms)`)}\n`);
    out.write(`  status        ${res.status}\n`);
    out.write(`  matched       ${res.matched}  ${dim("(expected — probe code is random)")}\n`);
    if (res.reason) out.write(`  reason        ${res.reason}\n`);
    return EXIT.OK;
  }
  if (res.status === 401) {
    throw runtime(
      `receiver rejected the probe (401)`,
      "signing key likely wrong — re-issue with `syrotp receiver add` or unwrap the original",
    );
  }
  if (res.status >= 500) {
    throw unreachable(
      `server error ${res.status} on inbound probe`,
      "check server logs and `syrotp doctor`",
    );
  }
  throw runtime(`unexpected response: ${res.status}`);
}

// ----- helpers -----------------------------------------------------

function strOrNull(v: string | true | undefined): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requireDbEnv(): void {
  if (!process.env.DATABASE_URL) {
    throw missingConfig(
      "DATABASE_URL is not set",
      "this command writes to Postgres directly — set DATABASE_URL in .env or your shell",
    );
  }
  if (!process.env.MASTER_ENCRYPTION_KEY) {
    throw missingConfig(
      "MASTER_ENCRYPTION_KEY is not set",
      "needed to wrap/unwrap gateway signing keys at rest",
    );
  }
}

function mapAdminError(
  err: unknown,
  AdminErrorClass: typeof Admin.AdminError,
  prefix: string,
): CliError {
  if (err instanceof AdminErrorClass) {
    switch (err.code) {
      case "invalid_msisdn":
      case "invalid_app_id":
      case "invalid_name":
      case "invalid_receiver_id":
        return usage(`${prefix}: ${err.message}`);
      case "app_not_found":
      case "receiver_not_found":
      case "app_disabled":
        return runtime(`${prefix}: ${err.message}`);
      default:
        return runtime(`${prefix}: ${err.message}`);
    }
  }
  if (err instanceof Error) {
    if (/ECONN|getaddrinfo|ETIMEDOUT|ENOTFOUND/i.test(err.message)) {
      return unreachable(
        `${prefix}: cannot reach Postgres`,
        "check DATABASE_URL and that postgres is running",
      );
    }
    return runtime(`${prefix}: ${err.constructor.name}`);
  }
  return runtime(`${prefix}: unknown error`);
}

// ----- help text ---------------------------------------------------

export function helpText(): string {
  return `${bold("syrotp receiver")} — manage receivers (gateways)

${cyan("usage")}
  syrotp receiver <subcommand> [options]

${cyan("subcommands")}
  add       register a new receiver under an app, mint a signing key
  list      list receivers (table or --json)
  disable   flip enabled=false on a receiver
  enable    flip enabled=true on a receiver (symmetric to disable)
  test      sign a sample inbound and verify the gateway path works

${dim("Run `syrotp receiver <subcommand> --help` for details.")}
`;
}

function addHelp(): string {
  return `${bold("syrotp receiver add")} — register a new receiver

${cyan("usage")}
  syrotp receiver add --app-id <app_*> --name <s> --msisdn <e164> [--operator <s>] [--simulate-heartbeat]

The signing key is shown ${bold("exactly once")}. Save it now.
`;
}

function listHelp(): string {
  return `${bold("syrotp receiver list")} — list receivers

${cyan("usage")}
  syrotp receiver list [--app-id <app_*>] [--json]

Default output is a table; --json emits a stable JSON array for scripts.
`;
}

function disableHelp(): string {
  return `${bold("syrotp receiver disable")} — disable a receiver

${cyan("usage")}
  syrotp receiver disable <rcv_*>
  syrotp receiver disable --id <rcv_*>

Idempotent: a second disable on the same receiver exits 0 with a note.
`;
}

function enableHelp(): string {
  return `${bold("syrotp receiver enable")} — re-enable a receiver

${cyan("usage")}
  syrotp receiver enable <rcv_*>
  syrotp receiver enable --id <rcv_*>

Idempotent: enabling an already-enabled receiver exits 0 with a note.

${cyan("notes")}
  Only the ${bold("enabled")} flag flips. A receiver whose
  ${bold("last_heartbeat_at")} is stale stays excluded from selection
  until the gateway sends a fresh heartbeat — there is no
  "force healthy" mode by design.
`;
}

function testHelp(): string {
  return `${bold("syrotp receiver test")} — verify a gateway pairing

${cyan("usage")}
  syrotp receiver test <rcv_*> --signing-key <hex> --base-url <http(s)://...>

Sends an HMAC-signed probe inbound to /v1/inbound/sms. Expects 202 +
matched=false (the probe code is random, so it won't match anything).

The signing key can be supplied via --signing-key or SYROTP_GATEWAY_KEY env.
The base URL can be supplied via --base-url or SYROTP_BASE_URL env.
`;
}
