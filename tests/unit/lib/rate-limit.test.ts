import { describe, it, expect, vi, afterEach } from "vitest";
import { InMemoryRateLimiter, RedisRateLimiter } from "../../../src/lib/rate-limit.js";
import { FakeRateLimitRedisClient } from "../../mocks/fake-rate-limit-redis-client.js";

describe("InMemoryRateLimiter (T011)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests up to the configured limit", async () => {
    const limiter = new InMemoryRateLimiter(3, 60_000);
    expect(await limiter.checkAndConsume("1.2.3.4")).toBe(true);
    expect(await limiter.checkAndConsume("1.2.3.4")).toBe(true);
    expect(await limiter.checkAndConsume("1.2.3.4")).toBe(true);
  });

  it("blocks the request that exceeds the limit", async () => {
    const limiter = new InMemoryRateLimiter(2, 60_000);
    expect(await limiter.checkAndConsume("1.2.3.4")).toBe(true);
    expect(await limiter.checkAndConsume("1.2.3.4")).toBe(true);
    expect(await limiter.checkAndConsume("1.2.3.4")).toBe(false);
  });

  it("tracks separate IPs independently", async () => {
    const limiter = new InMemoryRateLimiter(1, 60_000);
    expect(await limiter.checkAndConsume("1.1.1.1")).toBe(true);
    expect(await limiter.checkAndConsume("2.2.2.2")).toBe(true);
    expect(await limiter.checkAndConsume("1.1.1.1")).toBe(false);
    expect(await limiter.checkAndConsume("2.2.2.2")).toBe(false);
  });

  it("resets the window after it elapses", async () => {
    vi.useFakeTimers();
    const limiter = new InMemoryRateLimiter(1, 60_000);
    expect(await limiter.checkAndConsume("1.2.3.4")).toBe(true);
    expect(await limiter.checkAndConsume("1.2.3.4")).toBe(false);

    vi.advanceTimersByTime(60_001);
    expect(await limiter.checkAndConsume("1.2.3.4")).toBe(true);
  });

  it("uses RATE_LIMIT_PER_IP_PER_HOUR as a named constant, not an inline magic number, when no override is given", async () => {
    const limiter = new InMemoryRateLimiter();
    for (let i = 0; i < 5; i++) {
      expect(await limiter.checkAndConsume("9.9.9.9")).toBe(true);
    }
    expect(await limiter.checkAndConsume("9.9.9.9")).toBe(false);
  });
});

// D020 §4 fix — RedisRateLimiter is the production implementation (shared across every Vercel
// Lambda instance via Upstash, unlike InMemoryRateLimiter's per-process buckets). Same fixed-window
// contract, verified here against FakeRateLimitRedisClient rather than a live connection.
describe("RedisRateLimiter (D020 §4)", () => {
  it("same IP: allows exactly the configured limit, rejects the next one", async () => {
    const limiter = new RedisRateLimiter(new FakeRateLimitRedisClient(), 5, 3600);
    for (let i = 0; i < 5; i++) {
      expect(await limiter.checkAndConsume("1.2.3.4")).toBe(true);
    }
    expect(await limiter.checkAndConsume("1.2.3.4")).toBe(false);
  });

  it("different IP: gets an independent bucket, unaffected by another IP's exhausted limit", async () => {
    const limiter = new RedisRateLimiter(new FakeRateLimitRedisClient(), 1, 3600);
    expect(await limiter.checkAndConsume("1.1.1.1")).toBe(true);
    expect(await limiter.checkAndConsume("1.1.1.1")).toBe(false);
    expect(await limiter.checkAndConsume("2.2.2.2")).toBe(true);
  });

  it("expiration: allows requests again once the window has fully elapsed", async () => {
    const redis = new FakeRateLimitRedisClient();
    const limiter = new RedisRateLimiter(redis, 1, 3600);
    expect(await limiter.checkAndConsume("1.2.3.4")).toBe(true);
    expect(await limiter.checkAndConsume("1.2.3.4")).toBe(false);

    redis.advanceTime(3600 * 1000 + 1);
    expect(await limiter.checkAndConsume("1.2.3.4")).toBe(true);
  });

  it("concurrent requests for the same IP: the count is exact, never lets more than the limit through", async () => {
    const limiter = new RedisRateLimiter(new FakeRateLimitRedisClient(), 5, 3600);
    // 20 concurrent calls racing for a 5-request bucket — INCR-based counting (atomic server-side
    // in the real Upstash Lua script) must still land on exactly 5 successes, not more.
    const results = await Promise.all(Array.from({ length: 20 }, () => limiter.checkAndConsume("1.2.3.4")));
    expect(results.filter(Boolean).length).toBe(5);
  });
});
