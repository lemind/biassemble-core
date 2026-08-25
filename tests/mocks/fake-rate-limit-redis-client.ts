import type { RateLimitRedisClient } from "../../src/lib/rate-limit.js";

/** In-memory fake — same external counting contract as UpstashRateLimitRedisClient's Lua script
 * (INCR, TTL set only on the increment that creates the key). Real atomicity against concurrent
 * *processes* comes from Redis executing that script as a single server-side operation; this fake
 * is only exercised from one JS process, which is inherently single-threaded between `await` points
 * — sufficient to prove the counting contract itself, not the live server-side atomicity. */
export class FakeRateLimitRedisClient implements RateLimitRedisClient {
  private store = new Map<string, { count: number; expiresAt: number }>();

  constructor(private now: () => number = () => Date.now()) {}

  /** Test hook — advances the fake clock so a window's TTL can be observed expiring without a real sleep. */
  advanceTime(ms: number): void {
    const current = this.now();
    this.now = () => current + ms;
  }

  async incrWithWindow(key: string, windowSeconds: number): Promise<number> {
    const now = this.now();
    const existing = this.store.get(key);
    if (!existing || now >= existing.expiresAt) {
      this.store.set(key, { count: 1, expiresAt: now + windowSeconds * 1000 });
      return 1;
    }
    existing.count++;
    return existing.count;
  }
}
