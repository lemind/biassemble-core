import { describe, it, expect } from "vitest";
import { RedisWindowLimiter, type WindowCounterClient } from "../../../src/lib/rate-limit.js";

class FakeCounter implements WindowCounterClient {
  counts = new Map<string, number>();
  keys: string[] = [];
  async incrWithWindowTtl(key: string) {
    this.keys.push(key);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return { count, ttlSeconds: 1234 };
  }
}

describe("RedisWindowLimiter", () => {
  it("allows up to the limit, then refuses with the window's remaining seconds", async () => {
    const limiter = new RedisWindowLimiter(new FakeCounter(), 2, 3600, "ratelimit:mcp-start");
    expect(await limiter.consume("k")).toEqual({ allowed: true });
    expect(await limiter.consume("k")).toEqual({ allowed: true });
    expect(await limiter.consume("k")).toEqual({ allowed: false, retryAfterSeconds: 1234 });
  });

  it("uses the bare prefix for a global bucket", async () => {
    const counter = new FakeCounter();
    await new RedisWindowLimiter(counter, 3000, 60, "ratelimit:mcp-read-global").consume("");
    expect(counter.keys).toEqual(["ratelimit:mcp-read-global"]);
  });

  it("never lets a call through when Redis throws", async () => {
    const broken: WindowCounterClient = { incrWithWindowTtl: async () => { throw new Error("redis down"); } };
    await expect(new RedisWindowLimiter(broken, 30, 3600, "p").consume("k")).rejects.toThrow("redis down");
  });
});
