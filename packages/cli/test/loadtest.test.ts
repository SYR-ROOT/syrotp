/**
 * Tests for `syrotp loadtest <quick | release-baseline>` — argv handling,
 * flag scoping (--continue-on-fail and --csv only on release-baseline),
 * env validation, health probe, spawn dispatch, and exit-code mapping.
 *
 * Like the smoke tests, we never spawn a real load tool — Spawner and
 * HealthProbe are injected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { runLoadtest } from "../src/commands/loadtest.js";
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

async function expectThrow(
  args: ReadonlyArray<string>,
  env: Record<string, string | undefined>,
  opts: { healthy?: boolean; spawnExit?: number } = {},
): Promise<CliError> {
  return withEnv(env, async () => {
    let caught: unknown;
    try {
      await runLoadtest({
        args,
        out: new StringSink(),
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

const URL_ENV = { SYROTP_BASE_URL: "http://localhost:3000" };

// ----- top-level ---------------------------------------------------

test("loadtest (no sub) prints help, exits OK", async () => {
  const out = new StringSink();
  const code = await runLoadtest({
    args: [],
    out,
    spawner: new RecordingSpawner(),
    healthProbe: HEALTHY,
  });
  assert.equal(code, EXIT.OK);
  assert.match(out.data, /syrotp loadtest/);
  assert.match(out.data, /quick/);
  assert.match(out.data, /release-baseline/);
});

test("loadtest --help → OK", async () => {
  const out = new StringSink();
  const code = await runLoadtest({
    args: ["--help"],
    out,
    spawner: new RecordingSpawner(),
    healthProbe: HEALTHY,
  });
  assert.equal(code, EXIT.OK);
  assert.match(out.data, /syrotp loadtest/);
});

test("loadtest unknown subcommand → USAGE (exit 2)", async () => {
  const err = await expectThrow(["bogus"], URL_ENV);
  assert.equal(err.code, EXIT.USAGE);
});

// ----- quick: flag scoping + dispatch -------------------------------

test("loadtest quick --help → OK", async () => {
  const out = new StringSink();
  const code = await runLoadtest({
    args: ["quick", "--help"],
    out,
    spawner: new RecordingSpawner(),
    healthProbe: HEALTHY,
  });
  assert.equal(code, EXIT.OK);
  assert.match(out.data, /loadtest quick/);
});

test("loadtest quick --continue-on-fail → USAGE (release-baseline only)", async () => {
  const err = await expectThrow(["quick", "--continue-on-fail"], URL_ENV);
  assert.equal(err.code, EXIT.USAGE);
  assert.match(err.message, /release-baseline/);
});

test("loadtest quick --csv → USAGE (release-baseline only)", async () => {
  const err = await expectThrow(["quick", "--csv"], URL_ENV);
  assert.equal(err.code, EXIT.USAGE);
  assert.match(err.message, /release-baseline/);
});

test("loadtest quick → spawns `pnpm loadtest:quick` and maps exit 0 → CLI 0", async () => {
  await withEnv(URL_ENV, async () => {
    const spawner = new RecordingSpawner(0);
    const code = await runLoadtest({
      args: ["quick"],
      out: new StringSink(),
      spawner,
      healthProbe: HEALTHY,
    });
    assert.equal(code, EXIT.OK);
    assert.equal(spawner.calls.length, 1);
    assert.equal(spawner.calls[0]!.cmd, "pnpm");
    assert.deepEqual(spawner.calls[0]!.args, ["loadtest:quick"]);
  });
});

test("loadtest quick maps acceptance failure (exit 1) → CLI 1", async () => {
  const err = await expectThrow(["quick"], URL_ENV, { spawnExit: 1 });
  assert.equal(err.code, EXIT.RUNTIME);
});

test("loadtest quick maps tool's exit 3 (no health) → CLI 5", async () => {
  const err = await expectThrow(["quick"], URL_ENV, { spawnExit: 3 });
  assert.equal(err.code, EXIT.UNREACHABLE);
});

// ----- release-baseline: flag forwarding + dispatch -----------------

test("loadtest release-baseline --help → OK", async () => {
  const out = new StringSink();
  const code = await runLoadtest({
    args: ["release-baseline", "--help"],
    out,
    spawner: new RecordingSpawner(),
    healthProbe: HEALTHY,
  });
  assert.equal(code, EXIT.OK);
  assert.match(out.data, /release-baseline/);
});

test("loadtest release-baseline → spawns suite, exits 0", async () => {
  await withEnv(URL_ENV, async () => {
    const spawner = new RecordingSpawner(0);
    const code = await runLoadtest({
      args: ["release-baseline"],
      out: new StringSink(),
      spawner,
      healthProbe: HEALTHY,
    });
    assert.equal(code, EXIT.OK);
    assert.equal(spawner.calls.length, 1);
    assert.equal(spawner.calls[0]!.cmd, "pnpm");
    assert.deepEqual(spawner.calls[0]!.args, [
      "--filter",
      "@syrotp/loadtest",
      "start",
      "suite",
      "release-baseline",
    ]);
  });
});

test("loadtest release-baseline --continue-on-fail forwards the flag", async () => {
  await withEnv(URL_ENV, async () => {
    const spawner = new RecordingSpawner(0);
    await runLoadtest({
      args: ["release-baseline", "--continue-on-fail"],
      out: new StringSink(),
      spawner,
      healthProbe: HEALTHY,
    });
    assert.deepEqual(spawner.calls[0]!.args, [
      "--filter",
      "@syrotp/loadtest",
      "start",
      "suite",
      "release-baseline",
      "--continue-on-fail",
    ]);
  });
});

test("loadtest release-baseline --csv forwards the flag", async () => {
  await withEnv(URL_ENV, async () => {
    const spawner = new RecordingSpawner(0);
    await runLoadtest({
      args: ["release-baseline", "--csv"],
      out: new StringSink(),
      spawner,
      healthProbe: HEALTHY,
    });
    assert.deepEqual(spawner.calls[0]!.args, [
      "--filter",
      "@syrotp/loadtest",
      "start",
      "suite",
      "release-baseline",
      "--csv",
    ]);
  });
});

test("loadtest release-baseline forwards both flags", async () => {
  await withEnv(URL_ENV, async () => {
    const spawner = new RecordingSpawner(0);
    await runLoadtest({
      args: ["release-baseline", "--continue-on-fail", "--csv"],
      out: new StringSink(),
      spawner,
      healthProbe: HEALTHY,
    });
    assert.deepEqual(spawner.calls[0]!.args, [
      "--filter",
      "@syrotp/loadtest",
      "start",
      "suite",
      "release-baseline",
      "--continue-on-fail",
      "--csv",
    ]);
  });
});

test("loadtest release-baseline maps tool exit 1 → CLI 1", async () => {
  const err = await expectThrow(["release-baseline"], URL_ENV, { spawnExit: 1 });
  assert.equal(err.code, EXIT.RUNTIME);
});

test("loadtest release-baseline rejects unknown flag", async () => {
  const err = await expectThrow(["release-baseline", "--bogus"], URL_ENV);
  assert.equal(err.code, EXIT.USAGE);
});

test("loadtest release-baseline rejects positional arg", async () => {
  const err = await expectThrow(["release-baseline", "extra"], URL_ENV);
  assert.equal(err.code, EXIT.USAGE);
});

// ----- preflight: env + reachability --------------------------------

test("loadtest quick missing SYROTP_BASE_URL → MISSING_CONFIG", async () => {
  const err = await expectThrow(["quick"], { SYROTP_BASE_URL: undefined });
  assert.equal(err.code, EXIT.MISSING_CONFIG);
  assert.match(err.message, /SYROTP_BASE_URL/);
});

test("loadtest release-baseline missing SYROTP_BASE_URL → MISSING_CONFIG", async () => {
  const err = await expectThrow(["release-baseline"], { SYROTP_BASE_URL: undefined });
  assert.equal(err.code, EXIT.MISSING_CONFIG);
});

test("loadtest quick server unreachable → UNREACHABLE", async () => {
  const err = await expectThrow(["quick"], URL_ENV, { healthy: false });
  assert.equal(err.code, EXIT.UNREACHABLE);
});

test("loadtest release-baseline server unreachable → UNREACHABLE", async () => {
  const err = await expectThrow(["release-baseline"], URL_ENV, { healthy: false });
  assert.equal(err.code, EXIT.UNREACHABLE);
});
