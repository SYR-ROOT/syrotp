/**
 * Pure-function security regressions for crypto utilities.
 * These don't need Postgres/Redis — they run with `pnpm test`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateApiKey,
  generateCode,
  generateNonce,
  hashSecret,
  hmacSha256Hex,
  safeEqual,
  sha256Hex,
  verifyHmacHex,
} from "./crypto.js";

test("safeEqual: equal-length match", () => {
  assert.equal(safeEqual("abcd1234", "abcd1234"), true);
});

test("safeEqual: equal-length mismatch", () => {
  assert.equal(safeEqual("abcd1234", "abcd1235"), false);
});

test("safeEqual: length mismatch returns false without throwing", () => {
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("abcd", "abc"), false);
  assert.equal(safeEqual("", "abc"), false);
});

test("safeEqual: empty strings", () => {
  assert.equal(safeEqual("", ""), true);
});

test("generateCode: respects length and excludes ambiguous chars", () => {
  for (let i = 0; i < 200; i++) {
    const code = generateCode(6);
    assert.equal(code.length, 6);
    // Excluded: 0 O 1 I L (unambiguous alphabet only).
    assert.ok(!/[0OIL1]/.test(code), `code "${code}" contains an ambiguous char`);
    assert.ok(/^[A-Z2-9]+$/.test(code));
  }
});

test("generateCode: rejects out-of-range lengths", () => {
  assert.throws(() => generateCode(3));
  assert.throws(() => generateCode(33));
});

test("generateCode: distribution sanity (no obvious bias)", () => {
  // Pull a moderate sample. Each character position is independent and
  // each of 31 alphabet symbols should appear at least once across 5000
  // attempts at length 4 (vanishingly unlikely to fail by chance).
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    for (const ch of generateCode(4)) seen.add(ch);
  }
  assert.equal(seen.size, 31, "every alphabet symbol should appear at least once");
});

test("generateApiKey: prefix + sufficient length", () => {
  const k = generateApiKey("pk_live");
  assert.match(k, /^pk_live_[a-z0-9]{32}$/);
});

test("generateApiKey: each call is unique", () => {
  const a = generateApiKey("sk_live");
  const b = generateApiKey("sk_live");
  assert.notEqual(a, b);
});

test("generateNonce: hex length doubles requested bytes", () => {
  const n = generateNonce(16);
  assert.match(n, /^[0-9a-f]{32}$/);
});

test("hashSecret: deterministic for the same input", () => {
  const key = "0".repeat(64);
  const a = hashSecret("api_key", key, "pk_live_xxx");
  const b = hashSecret("api_key", key, "pk_live_xxx");
  assert.equal(a, b);
});

test("hashSecret: domain separation prevents collisions across uses", () => {
  const key = "0".repeat(64);
  const a = hashSecret("api_key", key, "shared_value");
  const b = hashSecret("gateway_secret", key, "shared_value");
  assert.notEqual(a, b);
});

test("verifyHmacHex: round-trip", () => {
  const key = "shared-secret";
  const sig = hmacSha256Hex(key, "hello");
  assert.equal(verifyHmacHex(key, "hello", sig), true);
  assert.equal(verifyHmacHex(key, "world", sig), false);
});

test("sha256Hex: known vector", () => {
  // Empty string SHA-256.
  assert.equal(
    sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});
