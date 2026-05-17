/**
 * End-to-end tests for the dispatcher (`main(argv, opts)`). We pass an
 * in-memory Writable as `out` so node:test's own IPC traffic on
 * process.stdout doesn't pollute the captured CLI output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { main } from "../src/index.js";
import { EXIT } from "../src/exit.js";
import { CliError } from "../src/errors.js";

class StringSink extends Writable {
  data = "";
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.data += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    cb();
  }
}

test("syrotp (no args) prints help, exits OK", async () => {
  const out = new StringSink();
  const code = await main([], { out });
  assert.equal(code, EXIT.OK);
  assert.match(out.data, /command-line interface/);
  assert.match(out.data, /doctor/);
});

test("syrotp --help prints help, exits OK", async () => {
  const out = new StringSink();
  const code = await main(["--help"], { out });
  assert.equal(code, EXIT.OK);
  assert.match(out.data, /usage/);
});

test("syrotp help doctor prints doctor-specific help", async () => {
  const out = new StringSink();
  const code = await main(["help", "doctor"], { out });
  assert.equal(code, EXIT.OK);
  assert.match(out.data, /syrotp doctor/);
  assert.match(out.data, /--env-file/);
  assert.match(out.data, /Reachability/);
});

test("syrotp version prints something like 'syrotp X.Y.Z'", async () => {
  const out = new StringSink();
  const code = await main(["version"], { out });
  assert.equal(code, EXIT.OK);
  assert.match(out.data, /^syrotp \S+\n$/);
});

test("syrotp -v is the same as version", async () => {
  const out = new StringSink();
  const code = await main(["-v"], { out });
  assert.equal(code, EXIT.OK);
  assert.match(out.data, /^syrotp \S+\n$/);
});

test("syrotp --version is the same as version", async () => {
  const out = new StringSink();
  const code = await main(["--version"], { out });
  assert.equal(code, EXIT.OK);
  assert.match(out.data, /^syrotp \S+\n$/);
});

test("syrotp unknown-cmd throws usage error (exit 2)", async () => {
  let caught: unknown;
  try {
    await main(["frobnicate"], { out: new StringSink() });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof CliError, "should throw CliError");
  assert.equal((caught as CliError).code, EXIT.USAGE);
});

test("syrotp doctor --bogus throws usage error", async () => {
  let caught: unknown;
  try {
    await main(["doctor", "--bogus"], { out: new StringSink() });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof CliError);
  assert.equal((caught as CliError).code, EXIT.USAGE);
});

test("syrotp doctor --help prints doctor help, exits OK", async () => {
  const out = new StringSink();
  const code = await main(["doctor", "--help"], { out });
  assert.equal(code, EXIT.OK);
  assert.match(out.data, /syrotp doctor/);
});

test("syrotp doctor --timeout=abc throws usage error", async () => {
  let caught: unknown;
  try {
    await main(["doctor", "--timeout", "abc"], { out: new StringSink() });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof CliError);
  assert.equal((caught as CliError).code, EXIT.USAGE);
});
