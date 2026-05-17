/**
 * Capture pino log output from the Fastify app so tests can assert on
 * redaction. We intercept `process.stdout.write` for the duration of the
 * test — pino writes there by default.
 */
const lines: string[] = [];
let originalWrite: typeof process.stdout.write | null = null;
let buffer = "";

export function startCapture(): void {
  if (originalWrite) return;
  originalWrite = process.stdout.write.bind(process.stdout);
  // Replace stdout.write. Pino writes one JSON line per record.
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    buffer += s;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      lines.push(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
    // Don't actually write to stdout during capture — keeps test output clean.
    void rest;
    return true;
  }) as typeof process.stdout.write;
}

export function stopCapture(): string[] {
  if (originalWrite) {
    process.stdout.write = originalWrite;
    originalWrite = null;
  }
  if (buffer.length > 0) {
    lines.push(buffer);
    buffer = "";
  }
  const out = lines.slice();
  lines.length = 0;
  return out;
}
