import { test } from "node:test";
import assert from "node:assert/strict";
import { maskPhone, normalizePhone, PhoneError } from "./phone.js";

test("normalizePhone: Syrian mobile local form", () => {
  const r = normalizePhone("0991234567", "SY");
  assert.equal(r.e164, "+963991234567");
  assert.equal(r.country, "SY");
});

test("normalizePhone: international form", () => {
  const r = normalizePhone("+963991234567", "SY");
  assert.equal(r.e164, "+963991234567");
});

test("normalizePhone: rejects gibberish", () => {
  assert.throws(() => normalizePhone("not a phone", "SY"), PhoneError);
});

test("normalizePhone: rejects short", () => {
  assert.throws(() => normalizePhone("12", "SY"), PhoneError);
});

test("maskPhone: standard", () => {
  assert.equal(maskPhone("+963991234567"), "+96399****567");
});

test("maskPhone: short fallback", () => {
  assert.equal(maskPhone("+12"), "***");
});
