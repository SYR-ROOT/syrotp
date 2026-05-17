import { test } from "node:test";
import assert from "node:assert/strict";
import { EXIT, nameOf, pickWorst } from "./exit.js";

test("EXIT codes are stable integers", () => {
  // These numbers are part of the CLI's public contract — see exit.ts header.
  // Bumping them is a major-version change.
  assert.equal(EXIT.OK, 0);
  assert.equal(EXIT.RUNTIME, 1);
  assert.equal(EXIT.USAGE, 2);
  assert.equal(EXIT.MISSING_CONFIG, 3);
  assert.equal(EXIT.MISSING_DEP, 4);
  assert.equal(EXIT.UNREACHABLE, 5);
});

test("pickWorst: empty → OK", () => {
  assert.equal(pickWorst([]), EXIT.OK);
});

test("pickWorst: single code → that code", () => {
  assert.equal(pickWorst([EXIT.UNREACHABLE]), EXIT.UNREACHABLE);
});

test("pickWorst: dep beats config beats unreachable beats runtime", () => {
  assert.equal(pickWorst([EXIT.RUNTIME, EXIT.UNREACHABLE]), EXIT.UNREACHABLE);
  assert.equal(pickWorst([EXIT.UNREACHABLE, EXIT.MISSING_CONFIG]), EXIT.MISSING_CONFIG);
  assert.equal(pickWorst([EXIT.MISSING_CONFIG, EXIT.MISSING_DEP]), EXIT.MISSING_DEP);
});

test("nameOf: round-trip", () => {
  for (const [name, code] of Object.entries(EXIT)) {
    assert.equal(nameOf(code), name);
  }
});
