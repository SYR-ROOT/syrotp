/**
 * Tests for `syrotp smoke` — argv handling, env validation, health probe,
 * spawn dispatch, and exit-code mapping.
 *
 * We never actually spawn `node scripts/smoke.mjs` from tests. The
 * Spawner is injected and records what was asked for; the HealthProbe
 * is injected too so we don't make real network calls.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { runSmoke } from "../src/commands/smoke.js";
import { CliError } from "../src/errors.js";
import { EXIT } from "../src/exit.js";
import type { Spawner, SpawnRequest } from "../src/spawn.js";
import type { HealthProbe } from "../src/commands/smoke.js";

class StringSink extends Writable {
  data = "";
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.data += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    cb();
  }
}

class RecordingSpawner implements Spawner {
  calls: SpawnRequest[] = [];
  constructor(private readonly exitCode: number = 0) {}
  async run(req: SpawnRequest): Promise<number> {
    this.calls.push(req);
    return this.exitCode;
  }
}

const HEALTHY: HealthProbe = async () => ({ ok: true, status: "ok", version: "0.1.1" });
const UNREACHABLE_PROBE: HealthProbe = async () => ({ ok: false, reason: "ECONNREFUSED" });

const SMOKE_ENV = {
  SYROTP_BASE_URL: "http://localhost:3000",
  SYROTP_PUBLIC_KEY: "pk_live_test",
  SYROTP_SECRET_KEY: "sk_live_test",
  SYROTP_RECEIVER_ID: "rcv_test",
  SYROTP_GATEWAY_KEY: "0".repeat(64),
  SYROTP_PHONE: "+963991234567",
} as const;

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

async function expectThrow(args: ReadonlyArray<string>, env: Record<string, string | undefined>, opts: { healthy?: boolean; spawnExit?: number } = {}): Promise<CliError> {
  return withEnv(env, async () => {
    const out = new StringSink();
    let caught: unknown;
    try {
      await runSmoke({
        args,
        out,
        spawner: new RecordingSpawner(opts.spawnExit ?? 0),
        healthProbe: opts.healthy === false ? UNREACHABLE_PROBE : HEALTHY,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof CliError, `expected CliError, got: ${caught}`);
    return caught as CliError;
  });
}

// ----- env / args ---------------------------------------------------

test("smoke --help → OK", async () => {
  const out = new StringSink();
  const code = await runSmoke({
    args: ["--help"],
    out,
    spawner: new RecordingSpawner(),
    healthProbe: HEALTHY,
  });
  assert.equal(code, EXIT.OK);
  assert.match(out.data, /syrotp smoke/);
  assert.match(out.data, /SYROTP_BASE_URL/);
});

test("smoke --bogus → USAGE", async () => {
  const err = await expectThrow(["--bogus"], SMOKE_ENV);
  assert.equal(err.code, EXIT.USAGE);
});

test("smoke <positional> → USAGE", async () => {
  const err = await expectThrow(["something"], SMOKE_ENV);
  assert.equal(err.code, EXIT.USAGE);
});

test("smoke missing required env → MISSING_CONFIG and lists all missing", async () => {
  const err = await expectThrow([], {
    SYROTP_BASE_URL: undefined,
    SYROTP_PUBLIC_KEY: undefined,
    SYROTP_SECRET_KEY: "x",
    SYROTP_RECEIVER_ID: "x",
    SYROTP_GATEWAY_KEY: "x",
    SYROTP_PHONE: "x",
  });
  assert.equal(err.code, EXIT.MISSING_CONFIG);
  assert.match(err.message, /SYROTP_BASE_URL/);
  assert.match(err.message, /SYROTP_PUBLIC_KEY/);
});

test("smoke server unreachable → UNREACHABLE", async () => {
  const err = await expectThrow([], SMOKE_ENV, { healthy: false });
  assert.equal(err.code, EXIT.UNREACHABLE);
});

// ----- exit-code mapping --------------------------------------------

test("smoke maps script exit 0 → CLI 0", async () => {
  await withEnv(SMOKE_ENV, async () => {
    const spawner = new RecordingSpawner(0);
    const out = new StringSink();
    const code = await runSmoke({ args: [], out, spawner, healthProbe: HEALTHY });
    assert.equal(code, EXIT.OK);
    assert.match(out.data, /smoke PASS/);
    assert.equal(spawner.calls.length, 1);
    assert.equal(spawner.calls[0]!.cmd, process.execPath);
    assert.deepEqual(spawner.calls[0]!.args, ["scripts/smoke.mjs"]);
  });
});

test("smoke maps script exit 1 → CLI 1 (RUNTIME)", async () => {
  const err = await expectThrow([], SMOKE_ENV, { spawnExit: 1 });
  assert.equal(err.code, EXIT.RUNTIME);
});

test("smoke maps script exit 3 → CLI 5 (UNREACHABLE — defensive)", async () => {
  const err = await expectThrow([], SMOKE_ENV, { spawnExit: 3 });
  assert.equal(err.code, EXIT.UNREACHABLE);
});

test("smoke maps script exit 2 → CLI 3 (MISSING_CONFIG — defensive)", async () => {
  const err = await expectThrow([], SMOKE_ENV, { spawnExit: 2 });
  assert.equal(err.code, EXIT.MISSING_CONFIG);
});
