import { redisConnection } from "../config/redis";
import { env } from "../config/env";

/**
 * Distributed, per-sender, per-hour-window rate limiter.
 *
 * Key design:
 *   rate:{senderId}:{hourWindowEpoch}
 * where hourWindowEpoch = Math.floor(now / 3600000).
 *
 * We use Redis INCR (atomic) + EXPIRE, which is safe across many worker
 * processes/instances hitting the same Redis - no in-memory counters are
 * used, so horizontal scaling of workers does not break the limit.
 *
 * A Lua script makes the "increment and check" step atomic so two workers
 * can never both slip through on the boundary value.
 */

const CHECK_AND_INCR_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])

local current = redis.call("GET", key)
if current == false then
  redis.call("SET", key, 1, "EX", ttl)
  return 1
end

current = tonumber(current)
if current >= limit then
  return -1
end

return redis.call("INCR", key)
`;

function hourWindowKey(senderId: string, atMs: number): { key: string; windowStart: number; windowEnd: number } {
  const windowStart = Math.floor(atMs / 3_600_000) * 3_600_000;
  const windowEnd = windowStart + 3_600_000;
  return { key: `rate:${senderId}:${windowStart}`, windowStart, windowEnd };
}

export interface RateLimitResult {
  allowed: boolean;
  /** If not allowed, the epoch ms at which the next window opens. */
  nextAvailableAt?: number;
  currentCount?: number;
}

/**
 * Atomically attempts to consume one "send slot" for a sender in the
 * current hour window. Returns whether it was allowed.
 */
export async function tryConsumeSendSlot(senderId: string, atMs: number = Date.now()): Promise<RateLimitResult> {
  const limit = env.maxEmailsPerHourPerSender;
  const { key, windowEnd } = hourWindowKey(senderId, atMs);
  const ttlSeconds = 3600 + 60; // small buffer so key doesn't expire exactly at boundary

  const result = (await redisConnection.eval(CHECK_AND_INCR_LUA, 1, key, limit, ttlSeconds)) as number;

  if (result === -1) {
    return { allowed: false, nextAvailableAt: windowEnd };
  }
  return { allowed: true, currentCount: result };
}

/** Read-only peek at current usage for a sender's current window (for dashboards). */
export async function getCurrentUsage(senderId: string, atMs: number = Date.now()) {
  const { key, windowStart, windowEnd } = hourWindowKey(senderId, atMs);
  const raw = await redisConnection.get(key);
  return {
    count: raw ? Number(raw) : 0,
    limit: env.maxEmailsPerHourPerSender,
    windowStart,
    windowEnd,
  };
}
