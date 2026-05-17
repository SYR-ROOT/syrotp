import Redis from "ioredis";

/**
 * Flush the test Redis DB between tests. We use logical DB 15 by default
 * (see test/setup.ts) so this never touches a developer's local cache.
 */
export async function resetRedis(): Promise<void> {
  const r = new Redis(process.env.REDIS_URL!, { lazyConnect: true });
  try {
    await r.connect();
    await r.flushdb();
  } finally {
    await r.quit().catch(() => {});
  }
}
