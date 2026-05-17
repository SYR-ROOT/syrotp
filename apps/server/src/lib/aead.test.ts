import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { wrap, unwrap } from "./aead.js";

const KEY = randomBytes(32).toString("hex");

test("wrap/unwrap roundtrip", () => {
  const plain = "hello world";
  const w = wrap(KEY, plain);
  assert.equal(unwrap(KEY, w), plain);
});

test("wrap/unwrap with AAD roundtrip", () => {
  const w = wrap(KEY, "secret", "receiver:rcv_abc");
  assert.equal(unwrap(KEY, w, "receiver:rcv_abc"), "secret");
});

test("wrong AAD fails to decrypt", () => {
  const w = wrap(KEY, "secret", "receiver:rcv_abc");
  assert.throws(() => unwrap(KEY, w, "receiver:rcv_xyz"));
});

test("wrong master key fails to decrypt", () => {
  const w = wrap(KEY, "secret");
  const other = randomBytes(32).toString("hex");
  assert.throws(() => unwrap(other, w));
});

test("tampered ciphertext fails", () => {
  const w = wrap(KEY, "secret");
  // Flip a single character in the ciphertext segment.
  const parts = w.split(".");
  const last = parts[3]!;
  const tampered = last.slice(0, -1) + (last.slice(-1) === "A" ? "B" : "A");
  parts[3] = tampered;
  assert.throws(() => unwrap(KEY, parts.join(".")));
});

test("rejects malformed wrap", () => {
  assert.throws(() => unwrap(KEY, "not-a-wrap"));
  assert.throws(() => unwrap(KEY, "v2.aaa.bbb.ccc"));
});
