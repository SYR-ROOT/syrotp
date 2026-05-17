import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDotenv, redactValue } from "./config.js";

test("parseDotenv: simple key=value", () => {
  assert.deepEqual(parseDotenv("FOO=bar\nBAZ=qux"), [
    ["FOO", "bar"],
    ["BAZ", "qux"],
  ]);
});

test("parseDotenv: ignores comments and blank lines", () => {
  const out = parseDotenv("# comment\n\nFOO=bar\n# another\n");
  assert.deepEqual(out, [["FOO", "bar"]]);
});

test("parseDotenv: strips matching surrounding quotes", () => {
  assert.deepEqual(parseDotenv(`FOO="hello world"`), [["FOO", "hello world"]]);
  assert.deepEqual(parseDotenv(`FOO='hello'`), [["FOO", "hello"]]);
});

test("parseDotenv: keeps inner = signs in value", () => {
  assert.deepEqual(parseDotenv("URL=postgres://u:p@h/db?x=1"), [
    ["URL", "postgres://u:p@h/db?x=1"],
  ]);
});

test("parseDotenv: rejects invalid keys", () => {
  // Keys must match [A-Za-z_][A-Za-z0-9_]*. "1FOO" is invalid.
  assert.deepEqual(parseDotenv("1FOO=bar"), []);
  // Spaces aren't part of the key.
  assert.deepEqual(parseDotenv("foo bar=baz"), []);
});

test("parseDotenv: handles CRLF and LF", () => {
  assert.deepEqual(parseDotenv("A=1\r\nB=2\nC=3"), [
    ["A", "1"],
    ["B", "2"],
    ["C", "3"],
  ]);
});

test("redactValue: secret-shaped names get masked", () => {
  assert.match(redactValue("MASTER_ENCRYPTION_KEY", "0123456789abcdef"), /^0123\*\*\*ef$/);
  assert.equal(redactValue("API_TOKEN", "short"), "[REDACTED]");
});

test("redactValue: postgres/redis URLs get user:pass masked", () => {
  assert.equal(
    redactValue("DATABASE_URL", "postgres://syrotp:secret@localhost:5432/syrotp"),
    "postgres://***@localhost:5432/syrotp",
  );
  assert.equal(
    redactValue("REDIS_URL", "redis://default:pw@localhost:6379/0"),
    "redis://***@localhost:6379/0",
  );
});

test("redactValue: non-secret stays unchanged", () => {
  assert.equal(redactValue("SYROTP_BASE_URL", "http://localhost:3000"), "http://localhost:3000");
  assert.equal(redactValue("NODE_ENV", "production"), "production");
});
