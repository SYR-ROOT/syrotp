/**
 * Tiny worker pool for load tests. JS is single-threaded, so a "worker" is
 * just an async loop. Concurrency = number of in-flight operations.
 *
 * The pool accepts a unit-of-work function that gets called `total` times.
 * Each invocation receives an index (0..total-1) — useful for deriving
 * unique idempotency keys, phone numbers, etc.
 */
export async function runPool(
  total: number,
  workers: number,
  work: (index: number) => Promise<void>,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  let next = 0;
  let done = 0;
  let lastReport = 0;

  const concurrency = Math.max(1, Math.min(workers, total));
  const tasks: Promise<void>[] = [];
  for (let w = 0; w < concurrency; w++) {
    tasks.push(
      (async () => {
        while (true) {
          const i = next++;
          if (i >= total) return;
          try {
            await work(i);
          } catch (err) {
            // The scenario is responsible for classifying outcomes via
            // metrics. An exception here is unexpected — log & rethrow as
            // a surface signal.
            console.error("[worker]", err instanceof Error ? err.message : err);
            throw err;
          } finally {
            done++;
            if (onProgress && done - lastReport >= Math.max(1, Math.floor(total / 20))) {
              lastReport = done;
              onProgress(done, total);
            }
          }
        }
      })(),
    );
  }
  await Promise.all(tasks);
  if (onProgress) onProgress(done, total);
}
