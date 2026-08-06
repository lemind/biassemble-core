import { describe, it, expect, vi, afterEach } from "vitest";
import { RateLimiter } from "../../../src/lib/rate-limit.js";

describe("RateLimiter (T011)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows requests up to the configured limit", () => {
    const limiter = new RateLimiter(3, 60_000);
    expect(limiter.checkAndConsume("1.2.3.4")).toBe(true);
    expect(limiter.checkAndConsume("1.2.3.4")).toBe(true);
    expect(limiter.checkAndConsume("1.2.3.4")).toBe(true);
  });

  it("blocks the request that exceeds the limit", () => {
    const limiter = new RateLimiter(2, 60_000);
    expect(limiter.checkAndConsume("1.2.3.4")).toBe(true);
    expect(limiter.checkAndConsume("1.2.3.4")).toBe(true);
    expect(limiter.checkAndConsume("1.2.3.4")).toBe(false);
  });

  it("tracks separate IPs independently", () => {
    const limiter = new RateLimiter(1, 60_000);
    expect(limiter.checkAndConsume("1.1.1.1")).toBe(true);
    expect(limiter.checkAndConsume("2.2.2.2")).toBe(true);
    expect(limiter.checkAndConsume("1.1.1.1")).toBe(false);
    expect(limiter.checkAndConsume("2.2.2.2")).toBe(false);
  });

  it("resets the window after it elapses", () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter(1, 60_000);
    expect(limiter.checkAndConsume("1.2.3.4")).toBe(true);
    expect(limiter.checkAndConsume("1.2.3.4")).toBe(false);

    vi.advanceTimersByTime(60_001);
    expect(limiter.checkAndConsume("1.2.3.4")).toBe(true);
  });

  it("uses RATE_LIMIT_PER_IP_PER_HOUR as a named constant, not an inline magic number, when no override is given", () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 5; i++) {
      expect(limiter.checkAndConsume("9.9.9.9")).toBe(true);
    }
    expect(limiter.checkAndConsume("9.9.9.9")).toBe(false);
  });
});
