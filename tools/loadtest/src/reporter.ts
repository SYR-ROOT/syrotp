import { execSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { RunMetrics } from "./metrics.js";
import type { AcceptanceResult } from "./acceptance.js";

export interface ReportInputs {
  scenario: string;
  command: string;
  workers: number;
  total: number;
  baseUrl: string;
  csv: boolean;
  /**
   * Pre-resolved directory to write `report.json`, `summary.md`, and
   * (optionally) `ops.csv` into. The CLI / suite runner is responsible
   * for choosing this path.
   */
  reportDir: string;
  metrics: RunMetrics;
  acceptance: AcceptanceResult;
  /** Optional resource snapshot (e.g. process.memoryUsage()). */
  resources?: Record<string, unknown>;
}

export interface WrittenReport {
  dir: string;
  jsonPath: string;
  mdPath: string;
  csvPath?: string;
}

export function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Capture environment + machine context once, callable from suite + step. */
export function collectMeta(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    git_commit: gitCommit(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    host: hostname(),
    env: envSummary(),
    ...extra,
  };
}

const SECRET_PATTERN = /SECRET|TOKEN|PASSWORD|KEY|HASH/i;

function envSummary(): Record<string, string> {
  // Whitelist SYROTP_ + a few generic ops vars; redact anything that looks
  // like a credential. No load-test artifact ever leaks raw secrets.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    if (k.startsWith("SYROTP_") || k === "DATABASE_URL" || k === "REDIS_URL" || k === "NODE_ENV") {
      out[k] = SECRET_PATTERN.test(k) || /^postgres:\/\/.*:.*@/.test(v) ? redactValue(k, v) : v;
    }
  }
  return out;
}

function redactValue(key: string, value: string): string {
  if (key.endsWith("URL") && /:\/\//.test(value)) {
    // Mask user:password segment in URLs.
    return value.replace(/(:\/\/)[^@/]+(@)/, "$1***$2");
  }
  if (value.length <= 8) return "[REDACTED]";
  return value.slice(0, 4) + "***" + value.slice(-2);
}

function gitCommit(): string | null {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

export async function writeReport(input: ReportInputs): Promise<WrittenReport> {
  const dir = input.reportDir;
  await mkdir(dir, { recursive: true });

  const meta = {
    scenario: input.scenario,
    command: input.command,
    workers: input.workers,
    total: input.total,
    base_url: input.baseUrl,
    ...collectMeta(),
  };

  const json = {
    meta,
    metrics: input.metrics.snapshot(),
    acceptance: input.acceptance,
    resources: input.resources ?? null,
  };

  const jsonPath = join(dir, "report.json");
  const mdPath = join(dir, "summary.md");
  await writeFile(jsonPath, JSON.stringify(json, null, 2));
  await writeFile(mdPath, renderMarkdown(json, meta));

  let csvPath: string | undefined;
  if (input.csv) {
    csvPath = join(dir, "ops.csv");
    await writeFile(csvPath, renderCsv(input.metrics));
  }

  return { dir, jsonPath, mdPath, csvPath };
}

function renderMarkdown(j: ReturnType<typeof Object>, meta: Record<string, unknown>): string {
  const m = (j as { metrics: ReturnType<RunMetrics["snapshot"]> }).metrics;
  const acc = (j as { acceptance: AcceptanceResult }).acceptance;
  const lines: string[] = [];
  lines.push(`# Load test — ${meta.scenario}`);
  lines.push("");
  lines.push(`- **Result:** ${acc.pass ? "✅ PASS" : "❌ FAIL"}`);
  lines.push(`- **Workers:** ${meta.workers}`);
  lines.push(`- **Total:** ${meta.total}`);
  lines.push(`- **Duration:** ${m.duration_seconds.toFixed(2)}s`);
  lines.push(`- **Target:** \`${meta.base_url}\``);
  lines.push(`- **Commit:** \`${meta.git_commit ?? "unknown"}\``);
  lines.push(`- **Node:** ${meta.node} (${meta.platform}/${meta.arch})`);
  lines.push("");
  lines.push("## Operations");
  lines.push("");
  lines.push("| Op | Total | OK | Expected 4xx | Unexpected 4xx | 5xx | Net err | Timeout | Success rate | p50 | p95 | p99 |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const op of ["start", "inbound", "status", "heartbeat"] as const) {
    const x = m[op];
    if (x.total === 0) continue;
    lines.push(
      `| ${op} | ${x.total} | ${x.ok} | ${x.expected_4xx} | ${x.unexpected_4xx} | ${x.err_5xx} | ${x.network_err} | ${x.timeout} | ${(x.success_rate * 100).toFixed(2)}% | ${x.latency.p50_ms}ms | ${x.latency.p95_ms}ms | ${x.latency.p99_ms}ms |`,
    );
  }
  lines.push("");

  // Throughput where meaningful.
  const dur = Math.max(0.001, m.duration_seconds);
  if (m.start.total > 0)   lines.push(`- start verifications/sec: **${(m.start.total / dur).toFixed(1)}**`);
  if (m.inbound.total > 0) lines.push(`- inbound sms/sec:         **${(m.inbound.total / dur).toFixed(1)}**`);
  if (m.status.total > 0)  lines.push(`- status reads/sec:        **${(m.status.total / dur).toFixed(1)}**`);
  lines.push("");

  // Protocol-specific extras.
  for (const op of ["start", "inbound", "status", "heartbeat"] as const) {
    const extras = m[op].extras;
    const keys = Object.keys(extras);
    if (keys.length === 0) continue;
    lines.push(`### ${op} extras`);
    lines.push("");
    for (const k of keys) lines.push(`- \`${k}\`: ${extras[k]}`);
    lines.push("");
  }

  lines.push("## Acceptance");
  lines.push("");
  lines.push("| Check | Threshold | Actual | Pass |");
  lines.push("|---|---|---|:---:|");
  for (const c of acc.checks) {
    lines.push(`| ${c.name} | ${c.threshold} | ${c.actual} | ${c.pass ? "✅" : "❌"} |`);
  }
  lines.push("");

  lines.push("## Environment");
  lines.push("");
  lines.push("```");
  lines.push((meta.command as string) ?? "");
  lines.push("```");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(meta.env, null, 2));
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}

function renderCsv(metrics: RunMetrics): string {
  const m = metrics.snapshot();
  const rows: string[] = [];
  rows.push("op,total,ok,expected_4xx,unexpected_4xx,err_5xx,network_err,timeout,success_rate,p50_ms,p95_ms,p99_ms,min_ms,max_ms,mean_ms");
  for (const op of ["start", "inbound", "status", "heartbeat"] as const) {
    const x = m[op];
    rows.push(
      [
        op,
        x.total,
        x.ok,
        x.expected_4xx,
        x.unexpected_4xx,
        x.err_5xx,
        x.network_err,
        x.timeout,
        x.success_rate,
        x.latency.p50_ms,
        x.latency.p95_ms,
        x.latency.p99_ms,
        x.latency.min_ms,
        x.latency.max_ms,
        x.latency.mean_ms,
      ].join(","),
    );
  }
  return rows.join("\n") + "\n";
}
