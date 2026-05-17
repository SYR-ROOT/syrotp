import { test } from "node:test";
import assert from "node:assert/strict";

// matching.ts pulls in db/index.ts → config.ts, which validates env at
// import time. For a pure-function unit test like extractCode we don't
// need real DB credentials — but we need *something* that passes config's
// shape checks. Set placeholder values BEFORE the dynamic import below.
process.env.DATABASE_URL ??= "postgres://x:y@localhost:5432/x";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.MASTER_ENCRYPTION_KEY ??= "0".repeat(64);
process.env.COOKIE_SECRET ??= "0".repeat(64);

const { extractCode } = await import("./matching.js");

test("extractCode: simple", () => {
  assert.equal(extractCode("VERIFY A7K9P2"), "A7K9P2");
});

test("extractCode: lowercase", () => {
  assert.equal(extractCode("verify a7k9p2"), "A7K9P2");
});

test("extractCode: extra whitespace", () => {
  assert.equal(extractCode("   VERIFY   A7K9P2  "), "A7K9P2");
});

test("extractCode: no space (autocorrect glitch)", () => {
  assert.equal(extractCode("VERIFYA7K9P2"), "A7K9P2");
});

test("extractCode: wrong prefix returns null", () => {
  assert.equal(extractCode("CONFIRM A7K9P2"), null);
});

test("extractCode: rejects punctuation in tail", () => {
  assert.equal(extractCode("VERIFY A7K-9P2"), null);
});

test("extractCode: rejects empty tail", () => {
  assert.equal(extractCode("VERIFY"), null);
});

test("extractCode: rejects oversized tail", () => {
  assert.equal(extractCode("VERIFY " + "A".repeat(64)), null);
});

test("extractCode: rejects non-string", () => {
  // @ts-expect-error testing runtime behavior
  assert.equal(extractCode(null), null);
});
