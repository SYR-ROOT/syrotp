/**
 * Tests for `syrotp bootstrap` argv handling and error paths.
 *
 * Reaching the admin module would require a real DB; here we keep the
 * scope to argv + safety guards. Per-test env mutations delete / restore
 * the relevant vars so we can exercise the MISSING_CONFIG branch
 * deterministically. Placeholder env defaults at the top ensure any
 * future dynamic-import side-effect (config validation) never crashes
 * the test process.
 */
process.env.DATABASE_URL ??= "postgres://x:y@127.0.0.1:5432/x";
process.env.REDIS_URL ??= "redis://127.0.0.1:6379";
process.env.MASTER_ENCRYPTION_KEY ??= "0".repeat(64);
process.env.COOKIE_SECRET ??= "0".repeat(64);

import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { main } from "../src/index.js";
import { CliError } from "../src/errors.js";
import { EXIT } from "../src/exit.js";

class StringSink extends Writable {
  data = "";
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.data += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    cb();
  }
}

async function expectThrow(args: ReadonlyArray<string>): Promise<CliError> {
  let caught: unknown;
  const out = new StringSink();
  try {
    await main(args, { out });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof CliError, `expected CliError, got: ${caught}`);
  return caught as CliError;
}

test("bootstrap --help exits 0 and shows usage", async () => {
  const out = new StringSink();
  const code = await main(["bootstrap", "--help"], { out });
  assert.equal(code, EXIT.OK);
  assert.match(out.data, /syrotp bootstrap/);
  assert.match(out.data, /--app-name/);
  assert.match(out.data, /--msisdn/);
});

test("bootstrap with no args returns USAGE (exit 2) and lists missing flags", async () => {
  const err = await expectThrow(["bootstrap"]);
  assert.equal(err.code, EXIT.USAGE);
  assert.match(err.message, /--app-name/);
  assert.match(err.message, /--msisdn/);
});

test("bootstrap with only --app-name reports the still-missing flag", async () => {
  const err = await expectThrow(["bootstrap", "--app-name", "X"]);
  assert.equal(err.code, EXIT.USAGE);
  assert.match(err.message, /--msisdn/);
  assert.doesNotMatch(err.message, /--app-name/);
});

test("bootstrap rejects unknown flag with USAGE", async () => {
  const err = await expectThrow(["bootstrap", "--frobnicate"]);
  assert.equal(err.code, EXIT.USAGE);
  assert.match(err.message, /unknown flag/);
});

test("bootstrap reports MISSING_CONFIG when DATABASE_URL is unset", async () => {
  const prev = { db: process.env.DATABASE_URL, mk: process.env.MASTER_ENCRYPTION_KEY };
  delete process.env.DATABASE_URL;
  delete process.env.MASTER_ENCRYPTION_KEY;
  try {
    const err = await expectThrow([
      "bootstrap",
      "--app-name", "X",
      "--msisdn", "+963991234567",
    ]);
    assert.equal(err.code, EXIT.MISSING_CONFIG);
    assert.match(err.message, /DATABASE_URL/);
  } finally {
    if (prev.db !== undefined) process.env.DATABASE_URL = prev.db;
    if (prev.mk !== undefined) process.env.MASTER_ENCRYPTION_KEY = prev.mk;
  }
});

test("bootstrap reports MISSING_CONFIG when MASTER_ENCRYPTION_KEY is unset", async () => {
  const prev = { db: process.env.DATABASE_URL, mk: process.env.MASTER_ENCRYPTION_KEY };
  process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:1/x";
  delete process.env.MASTER_ENCRYPTION_KEY;
  try {
    const err = await expectThrow([
      "bootstrap",
      "--app-name", "X",
      "--msisdn", "+963991234567",
    ]);
    assert.equal(err.code, EXIT.MISSING_CONFIG);
    assert.match(err.message, /MASTER_ENCRYPTION_KEY/);
  } finally {
    if (prev.db !== undefined) process.env.DATABASE_URL = prev.db;
    else delete process.env.DATABASE_URL;
    if (prev.mk !== undefined) process.env.MASTER_ENCRYPTION_KEY = prev.mk;
  }
});

test("bootstrap error path never includes secret-shaped strings in message", async () => {
  // Every CliError thrown along the validation path has a deterministic
  // message we can grep — confirm none contain anything that *looks* like
  // a key or password.
  const cases: Array<ReadonlyArray<string>> = [
    ["bootstrap"],
    ["bootstrap", "--app-name", "X"],
    ["bootstrap", "--frobnicate"],
  ];
  for (const args of cases) {
    const err = await expectThrow(args);
    const blob = `${err.message}\n${err.hint ?? ""}`;
    assert.doesNotMatch(blob, /pk_live_[a-z0-9]+/, `pk_live leaked: args=${args.join(" ")}`);
    assert.doesNotMatch(blob, /sk_live_[a-z0-9]+/, `sk_live leaked: args=${args.join(" ")}`);
    assert.doesNotMatch(blob, /\b[0-9a-f]{64}\b/, `hex secret leaked: args=${args.join(" ")}`);
  }
});
