import { redis } from "../lib/redis.js";

/**
 * Atomic fixed-window counter using Redis INCR + EXPIRE.
 * Returns the current count for the window and whether it's over the limit.
 *
 * Fixed window is fine for our needs — a slightly more permissive boundary
 * is acceptable, and the implementation is simple + atomic without Lua.
 */
export interface RateCheck {
  allowed: boolean;
  count: number;
  remaining: number;
  resetSeconds: number;
}

export async function rateCheck(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateCheck> {
  const bucket = `syrotp:rl:${key}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;
  // Pipeline two commands. INCR auto-creates with value 1.
  const pipeline = redis.multi();
  pipeline.incr(bucket);
  pipeline.expire(bucket, windowSeconds, "NX");
  const replies = await pipeline.exec();
  if (!replies) {
    // Redis transient failure — fail open with a count of 1 rather than
    // hard-blocking traffic. Surface as a warning at the call site if needed.
    return { allowed: true, count: 0, remaining: limit, resetSeconds: windowSeconds };
  }
  const incrReply = replies[0];
  const count = Array.isArray(incrReply) && typeof incrReply[1] === "number"
    ? incrReply[1]
    : 0;
  const remaining = Math.max(0, limit - count);
  const resetSeconds =
    windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
  return { allowed: count <= limit, count, remaining, resetSeconds };
}
