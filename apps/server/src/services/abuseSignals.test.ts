/**
 * Pure-math unit tests for `calcHealthScore`. The DB-fed compute
 * path is exercised by the integration suite; this file pins the
 * scoring formula so a future refactor can't silently shift it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// abuseSignals.ts pulls in db/index.ts → config.ts, which validates
// env at import time. For a pure-function unit test we just need
// placeholders that pass config's shape checks. Same pattern as
// matching.test.ts.
process.env.DATABASE_URL ??= "postgres://x:y@localhost:5432/x";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.MASTER_ENCRYPTION_KEY ??= "0".repeat(64);
process.env.COOKIE_SECRET ??= "0".repeat(64);

const { calcHealthScore } = await import("./abuseSignals.js");

describe("calcHealthScore", () => {
  it("zero across all signals → 100 (perfect health)", () => {
    assert.equal(
      calcHealthScore({ failed_rate: 0, unmatched_rate: 0, binding_failure_rate: 0 }),
      100,
    );
  });

  it("everything-bad with all rates at 1.0 produces 100 - 30 - 40 - 10 = 20", () => {
    assert.equal(
      calcHealthScore({ failed_rate: 1, unmatched_rate: 1, binding_failure_rate: 1 }),
      20,
    );
  });

  it("clamps to 0 when math would go negative (defensive — shouldn't happen with real rates)", () => {
    assert.equal(
      calcHealthScore({ failed_rate: 5, unmatched_rate: 5, binding_failure_rate: 5 }),
      0,
    );
  });

  it("only failed_rate weighted at 30 — 50% failed → 85", () => {
    assert.equal(
      calcHealthScore({ failed_rate: 0.5, unmatched_rate: 0, binding_failure_rate: 0 }),
      85,
    );
  });

  it("only unmatched_rate weighted at 40 — 25% unmatched → 90", () => {
    assert.equal(
      calcHealthScore({ failed_rate: 0, unmatched_rate: 0.25, binding_failure_rate: 0 }),
      90,
    );
  });

  it("only binding_failure_rate weighted at 10 — 100% expired bindings → 90", () => {
    assert.equal(
      calcHealthScore({ failed_rate: 0, unmatched_rate: 0, binding_failure_rate: 1 }),
      90,
    );
  });

  it("rounds to integer (no fractional scores)", () => {
    const score = calcHealthScore({
      failed_rate: 0.123,
      unmatched_rate: 0.456,
      binding_failure_rate: 0.789,
    });
    assert.equal(Number.isInteger(score), true);
  });

  it("clamps the upper bound to 100 even for nonsensical negative inputs", () => {
    assert.equal(
      calcHealthScore({ failed_rate: -1, unmatched_rate: -1, binding_failure_rate: -1 }),
      100,
    );
  });
});
