import { describe, it, expect } from "vitest";
import { RunKeyVault, RUN_KEY_TTL_SECONDS, type RunKeyRedisClient } from "../../../src/lib/run-key-vault.js";

class FakeRedis implements RunKeyRedisClient {
  store = new Map<string, { value: string; ex: number }>();
  async set(key: string, value: string, opts: { ex: number }) {
    this.store.set(key, { value, ex: opts.ex });
    return "OK";
  }
  async get(key: string) {
    return this.store.get(key)?.value ?? null;
  }
  async del(key: string) {
    return this.store.delete(key) ? 1 : 0;
  }
}

const KEY = "sk-vault-test-123456";

describe("RunKeyVault", () => {
  it("round-trips a key and stores only ciphertext, with the expiry", async () => {
    const redis = new FakeRedis();
    const vault = new RunKeyVault(redis, "secret-a");
    await vault.put("run-1", KEY);
    const stored = redis.store.get("grounnel:runkey:run-1")!;
    expect(stored.value).not.toContain(KEY);
    expect(stored.ex).toBe(RUN_KEY_TTL_SECONDS);
    expect(await vault.get("run-1")).toBe(KEY);
  });

  it("returns null once deleted or expired", async () => {
    const vault = new RunKeyVault(new FakeRedis(), "secret-a");
    await vault.put("run-1", KEY);
    await vault.delete("run-1");
    expect(await vault.get("run-1")).toBeNull();
  });

  it("refuses a ciphertext moved to another run or read with another secret", async () => {
    const redis = new FakeRedis();
    await new RunKeyVault(redis, "secret-a").put("run-1", KEY);
    redis.store.set("grounnel:runkey:run-2", redis.store.get("grounnel:runkey:run-1")!);
    await expect(new RunKeyVault(redis, "secret-a").get("run-2")).rejects.toThrow();
    await expect(new RunKeyVault(redis, "secret-b").get("run-1")).rejects.toThrow();
  });
});
