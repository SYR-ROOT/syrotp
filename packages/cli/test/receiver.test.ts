/**
 * Tests for `syrotp receiver <add|list|disable|test>` argv handling and
 * defensive behavior. These don't talk to a real DB — they exercise the
 * CLI surface that runs BEFORE the admin call.
 *
 * Some tests (e.g. `receiver test` with an unreachable base-url) trigger
 * the dynamic import of `@syrotp/server/admin`, which transitively loads
 * server/config.ts. That module validates env at import time and
 * process.exits if anything's missing — which would kill the test
 * process. We set placeholder env values up-front so the import always
 * succeeds, and the per-test missing-config probes use delete + restore.
 */
// Use ports unlikely to have anything listening — avoids noise from
// background ioredis reconnect attempts hitting an unrelated redis.
process.env.DATABASE_URL ??= "postgres://x:y@127.0.0.1:65111/x";
process.env.REDIS_URL ??= "redis://127.0.0.1:65112";
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
  try {
    await main(args, { out: new StringSink() });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof CliError, `expected CliError, got: ${caught}`);
  return caught as CliError;
}

// ----- top-level routing --------------------------------------------

test("receiver (no sub) prints help, exits OK", async () => {
  const out = new StringSink();
  const code = await main(["receiver"], { out });
  assert.equal(code, EXIT.OK);
  assert.match(out.data, /syrotp receiver/);
  // Help lists every subcommand, one per line.
  assert.match(out.data, /\badd\b/);
  assert.match(out.data, /\blist\b/);
  assert.match(out.data, /\bdisable\b/);
  assert.match(out.data, /\btest\b/);
});

test("receiver --help exits OK", async () => {
  const out = new StringSink();
  const code = await main(["receiver", "--help"], { out });
  assert.equal(code, EXIT.OK);
  assert.match(out.data, /syrotp receiver/);
});

test("receiver bogus → USAGE", async () => {
  const err = await expectThrow(["receiver", "bogus"]);
  assert.equal(err.code, EXIT.USAGE);
  assert.match(err.message, /unknown receiver subcommand/);
});

// ----- receiver add --------------------------------------------------

test("receiver add --help → OK", async () => {
  const out = new StringSink();
  const code = await main(["receiver", "add", "--help"], { out });
  assert.equal(code, EXIT.OK);
  assert.match(out.data, /receiver add/);
});

test("receiver add (no flags) → USAGE listing every required arg", async () => {
  const err = await expectThrow(["receiver", "add"]);
  assert.equal(err.code, EXIT.USAGE);
  assert.match(err.message, /--app-id/);
  assert.match(err.message, /--name/);
  assert.match(err.message, /--msisdn/);
});

test("receiver add (with all args, no DB) → MISSING_CONFIG", async () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const err = await expectThrow([
      "receiver", "add",
      "--app-id", "app_01H",
      "--name", "syriatel-01",
      "--msisdn", "+963998887777",
    ]);
    assert.equal(err.code, EXIT.MISSING_CONFIG);
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
  }
});

test("receiver add --bogus → USAGE", async () => {
  const err = await expectThrow(["receiver", "add", "--bogus"]);
  assert.equal(err.code, EXIT.USAGE);
});

// ----- receiver list -------------------------------------------------

test("receiver list --help → OK", async () => {
  const out = new StringSink();
  const code = await main(["receiver", "list", "--help"], { out });
  assert.equal(code, EXIT.OK);
  assert.match(out.data, /receiver list/);
  assert.match(out.data, /--json/);
});

test("receiver list (no DB) → MISSING_CONFIG", async () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const err = await expectThrow(["receiver", "list"]);
    assert.equal(err.code, EXIT.MISSING_CONFIG);
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
  }
});

// ----- receiver disable ----------------------------------------------

test("receiver disable --help → OK", async () => {
  const out = new StringSink();
  const code = await main(["receiver", "disable", "--help"], { out });
  assert.equal(code, EXIT.OK);
  assert.match(out.data, /receiver disable/);
});

test("receiver disable (no id) → USAGE", async () => {
  const err = await expectThrow(["receiver", "disable"]);
  assert.equal(err.code, EXIT.USAGE);
  assert.match(err.message, /missing receiver id/);
});

test("receiver disable accepts positional id", async () => {
  // We can't actually call the admin function without a DB, so the test
  // just confirms the parser doesn't throw USAGE on the positional form.
  // It WILL fail with MISSING_CONFIG when DATABASE_URL is unset.
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const err = await expectThrow(["receiver", "disable", "rcv_01H"]);
    assert.equal(err.code, EXIT.MISSING_CONFIG);
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
  }
});

test("receiver disable accepts --id flag form", async () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const err = await expectThrow(["receiver", "disable", "--id", "rcv_01H"]);
    assert.equal(err.code, EXIT.MISSING_CONFIG);
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
  }
});

// ----- receiver enable -----------------------------------------------

test("receiver enable --help → OK", async () => {
  const out = new StringSink();
  const code = await main(["receiver", "enable", "--help"], { out });
  assert.equal(code, EXIT.OK);
  assert.match(out.data, /receiver enable/);
});

test("receiver enable (no id) → USAGE", async () => {
  const err = await expectThrow(["receiver", "enable"]);
  assert.equal(err.code, EXIT.USAGE);
  assert.match(err.message, /missing receiver id/);
});

test("receiver enable accepts positional id", async () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const err = await expectThrow(["receiver", "enable", "rcv_01H"]);
    assert.equal(err.code, EXIT.MISSING_CONFIG);
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
  }
});

test("receiver enable accepts --id flag form", async () => {
  const prev = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const err = await expectThrow(["receiver", "enable", "--id", "rcv_01H"]);
    assert.equal(err.code, EXIT.MISSING_CONFIG);
  } finally {
    if (prev !== undefined) process.env.DATABASE_URL = prev;
  }
});

// ----- receiver test -------------------------------------------------

test("receiver test --help → OK", async () => {
  const out = new StringSink();
  const code = await main(["receiver", "test", "--help"], { out });
  assert.equal(code, EXIT.OK);
  assert.match(out.data, /receiver test/);
  assert.match(out.data, /--signing-key/);
});

test("receiver test (no inputs) → USAGE listing all missing", async () => {
  // Make sure env vars don't accidentally satisfy the test.
  const prev = {
    base: process.env.SYROTP_BASE_URL,
    gw: process.env.SYROTP_GATEWAY_KEY,
  };
  delete process.env.SYROTP_BASE_URL;
  delete process.env.SYROTP_GATEWAY_KEY;
  try {
    const err = await expectThrow(["receiver", "test"]);
    assert.equal(err.code, EXIT.USAGE);
    assert.match(err.message, /receiver id/);
    assert.match(err.message, /signing-key/);
    assert.match(err.message, /base-url/);
  } finally {
    if (prev.base !== undefined) process.env.SYROTP_BASE_URL = prev.base;
    if (prev.gw !== undefined) process.env.SYROTP_GATEWAY_KEY = prev.gw;
  }
});

test("receiver test reaches network attempt when given an unreachable base-url", async () => {
  // Probe a guaranteed-closed port. Expect UNREACHABLE.
  const err = await expectThrow([
    "receiver", "test", "rcv_01H",
    "--signing-key", "deadbeef",
    "--base-url", "http://127.0.0.1:1", // port 1 is reserved + closed
    "--timeout", "500",
  ]);
  assert.equal(err.code, EXIT.UNREACHABLE);
});

test("receiver test rejects bad --timeout value", async () => {
  const err = await expectThrow([
    "receiver", "test", "rcv_01H",
    "--signing-key", "deadbeef",
    "--base-url", "http://127.0.0.1:1",
    "--timeout", "abc",
  ]);
  assert.equal(err.code, EXIT.USAGE);
});
