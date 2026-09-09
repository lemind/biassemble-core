import type { Redis } from "@upstash/redis";

// v10 §3c — placeholder, not yet confirmed (spec.md Assumption 5, Open Questions).
export const RATE_LIMIT_PER_IP_PER_HOUR = 5;
// Spec 019 T014 — reads are cheap next to a run, so this is deliberately generous: it exists to
// stop a scraper walking the endpoint, not to ration people opening a link they were sent. One
// page load is one request, and a 47-claim run measured 159 KB of response.
export const RATE_LIMIT_READS_PER_IP_PER_HOUR = 120;
const WINDOW_MS = 60 * 60 * 1000;
export const WINDOW_SECONDS = WINDOW_MS / 1000;

/** Fixed window, per IP: exactly RATE_LIMIT_PER_IP_PER_HOUR requests, window starts on that key's
 * first request and resets in full afterward — not sliding/token-bucket. D020 §4 (rate-limit fix). */
export interface RateLimiter {
  /** True if this call is allowed (and consumes one unit); false if the caller is over limit. */
  checkAndConsume(ip: string): Promise<boolean>;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/** In-memory, per-process — not a cross-instance guarantee on Vercel serverless (D020 §4's original
 * gap). Kept for local dev / tests that don't want a live Redis; production wiring uses
 * RedisRateLimiter instead (server.ts only registers Grounnel routes once Redis is configured). */
export class InMemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number = RATE_LIMIT_PER_IP_PER_HOUR,
    private readonly windowMs: number = WINDOW_MS
  ) {}

  async checkAndConsume(ip: string): Promise<boolean> {
    const now = Date.now();
    const bucket = this.buckets.get(ip);
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(ip, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (bucket.count >= this.limit) {
      return false;
    }
    bucket.count++;
    return true;
  }
}

/** The subset of @upstash/redis's client this limiter needs — narrow enough to fake in tests
 * without a live connection, same convention as persistence/grounnel-store.ts's RedisHashClient. */
export interface RateLimitRedisClient {
  /** Atomically increments `key` by 1, setting its TTL to windowSeconds only on the increment that
   * creates the key (result 1) — so concurrent callers can't each reset the window on every hit,
   * which would turn a fixed window into a sliding one. Returns the post-increment count. */
  incrWithWindow(key: string, windowSeconds: number): Promise<number>;
}

// One round trip, atomic server-side (Redis executes the whole script as a single operation) — a
// plain INCR + conditional EXPIRE over two separate calls would race two concurrent first-requests
// for the same key into a "who sets the TTL" gap; this doesn't need MULTI/EXEC or a pipeline.
const INCR_WITH_WINDOW_SCRIPT = "local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return c";

/** Adapts @upstash/redis's `Redis` to `RateLimitRedisClient`. */
export class UpstashRateLimitRedisClient implements RateLimitRedisClient {
  private readonly script;

  constructor(redis: Redis) {
    this.script = redis.createScript<number>(INCR_WITH_WINDOW_SCRIPT);
  }

  async incrWithWindow(key: string, windowSeconds: number): Promise<number> {
    return this.script.eval([key], [String(windowSeconds)]);
  }
}

/** Redis-backed fixed window — shared across every Vercel Lambda instance, unlike InMemoryRateLimiter.
 * D020 §4: the in-memory limiter's per-process buckets meant 5/hour was only ever enforced per
 * instance, not globally; this closes that gap using the same Upstash connection already wired up
 * for GrounnelStore (D019 §4), no new infrastructure. */
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: RateLimitRedisClient,
    private readonly limit: number = RATE_LIMIT_PER_IP_PER_HOUR,
    private readonly windowSeconds: number = WINDOW_MS / 1000,
    // Parameterised so submissions and shared-assessment reads get separate buckets — sharing one
    // would let a burst of page views lock a person out of running their own check.
    private readonly keyPrefix: string = "ratelimit:extract"
  ) {}

  async checkAndConsume(ip: string): Promise<boolean> {
    const count = await this.redis.incrWithWindow(`${this.keyPrefix}:${ip}`, this.windowSeconds);
    return count <= this.limit;
  }
}
