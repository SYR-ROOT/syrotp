/**
 * Generate test phone numbers in E.164. We intentionally use the SY +963
 * mobile range so server-side normalization treats them as "real."
 *
 * The 7-digit suffix is derived from the index, so identical indices across
 * runs collide deterministically (useful for replaying a workload).
 */
export function phoneFromIndex(i: number): string {
  // Syrian mobile prefixes start at 9; we use 99 to avoid common testbeds.
  // Last 7 digits encode the index.
  const tail = String(1000000 + (i % 9000000)).padStart(7, "0");
  return `+96399${tail}`;
}
