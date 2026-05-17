import { Redis } from "ioredis";
import { config } from "../config.js";

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});

redis.on("error", (err: Error) => {
  // Don't spam — ioredis already retries; just record.
  console.error("[redis] error:", err.message);
});

export async function closeRedis(): Promise<void> {
  await redis.quit();
}
