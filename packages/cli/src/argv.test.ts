import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFlags, parseTopLevel } from "./argv.js";

test("parseTopLevel: empty argv → help", () => {
  const r = parseTopLevel([]);
  assert.equal(r.command, "help");
});

test("parseTopLevel: --help / -h / help all yield help", () => {
  for (const arg of ["--help", "-h", "help"]) {
    assert.equal(parseTopLevel([arg]).command, "help", `arg=${arg}`);
  }
});

test("parseTopLevel: help with topic carries the topic", () => {
  assert.equal(parseTopLevel(["help", "doctor"]).helpTopic, "doctor");
  assert.equal(parseTopLevel(["--help", "doctor"]).helpTopic, "doctor");
});

test("parseTopLevel: version aliases", () => {
  for (const arg of ["version", "--version", "-v"]) {
    assert.equal(parseTopLevel([arg]).command, "version", `arg=${arg}`);
  }
});

test("parseTopLevel: doctor passes rest", () => {
  const r = parseTopLevel(["doctor", "--timeout", "1500"]);
  assert.equal(r.command, "doctor");
  assert.deepEqual(r.rest, ["--timeout", "1500"]);
});

test("parseTopLevel: unknown command preserves token", () => {
  const r = parseTopLevel(["frobnicate"]);
  assert.equal(r.command, "unknown");
  assert.equal(r.unknownToken, "frobnicate");
});

test("parseTopLevel: bootstrap + receiver route to their commands", () => {
  assert.equal(parseTopLevel(["bootstrap"]).command, "bootstrap");
  assert.equal(parseTopLevel(["receiver", "list"]).command, "receiver");
  assert.deepEqual(parseTopLevel(["receiver", "list", "--json"]).rest, ["list", "--json"]);
});

test("parseFlags: simple --key value", () => {
  const r = parseFlags(["--timeout", "5000"], {
    flags: { timeout: { value: true } },
  });
  assert.equal(r.values.timeout, "5000");
  assert.deepEqual(r.positionals, []);
  assert.equal(r.unknown, undefined);
});

test("parseFlags: --key=value form", () => {
  const r = parseFlags(["--timeout=5000"], {
    flags: { timeout: { value: true } },
  });
  assert.equal(r.values.timeout, "5000");
});

test("parseFlags: boolean flag", () => {
  const r = parseFlags(["--help"], { flags: { help: { value: false, alias: "h" } } });
  assert.equal(r.values.help, true);
});

test("parseFlags: short alias resolves to long name", () => {
  const r = parseFlags(["-h"], { flags: { help: { value: false, alias: "h" } } });
  assert.equal(r.values.help, true);
});

test("parseFlags: unknown flag is reported, not thrown", () => {
  const r = parseFlags(["--bogus"], { flags: { help: { value: false } } });
  assert.equal(r.unknown, "--bogus");
});

test("parseFlags: missing value for value-flag is reported", () => {
  const r = parseFlags(["--env-file"], { flags: { "env-file": { value: true } } });
  assert.equal(r.unknown, "--env-file");
});

test("parseFlags: positionals are collected", () => {
  const r = parseFlags(["foo", "--help", "bar"], { flags: { help: { value: false } } });
  assert.deepEqual(r.positionals, ["foo", "bar"]);
});

test("parseFlags: -- ends flag parsing", () => {
  const r = parseFlags(["--help", "--", "--not-a-flag"], { flags: { help: { value: false } } });
  assert.equal(r.values.help, true);
  assert.deepEqual(r.positionals, ["--not-a-flag"]);
});
