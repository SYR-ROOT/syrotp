/**
 * Latency histogram. We keep all samples in an array and sort on demand —
 * fine up to ~1M samples on a developer machine (~8MB). Beyond that switch
 * to a bucketed structure (HDR-style) but we don't need it yet.
 *
 * Times are stored in milliseconds (number, sub-millisecond precision OK).
 */
export class Latencies {
  private readonly samples: number[] = [];
  private mn = Number.POSITIVE_INFINITY;
  private mx = 0;
  private sum = 0;

  add(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.samples.push(ms);
    if (ms < this.mn) this.mn = ms;
    if (ms > this.mx) this.mx = ms;
    this.sum += ms;
  }

  count(): number {
    return this.samples.length;
  }

  min(): number {
    return this.samples.length === 0 ? 0 : this.mn;
  }

  max(): number {
    return this.mx;
  }

  mean(): number {
    return this.samples.length === 0 ? 0 : this.sum / this.samples.length;
  }

  percentile(p: number): number {
    const n = this.samples.length;
    if (n === 0) return 0;
    if (p <= 0) return this.mn;
    if (p >= 100) return this.mx;
    // Sort lazily once per snapshot. Histograms are read at the end of a run,
    // so a single sort is fine.
    const sorted = [...this.samples].sort((a, b) => a - b);
    // Nearest-rank method: index = ceil(p/100 * n) - 1, clamped to [0, n-1].
    const idx = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
    return sorted[idx]!;
  }

  snapshot() {
    return {
      count: this.count(),
      min_ms: round(this.min()),
      max_ms: round(this.max()),
      mean_ms: round(this.mean()),
      p50_ms: round(this.percentile(50)),
      p95_ms: round(this.percentile(95)),
      p99_ms: round(this.percentile(99)),
    };
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
