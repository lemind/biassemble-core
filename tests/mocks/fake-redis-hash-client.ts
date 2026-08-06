import type { RedisHashClient } from "../../src/persistence/grounnel-store.js";

/** In-memory fake — same field-level semantics as @upstash/redis's hash commands, no live connection. */
export class FakeRedisHashClient implements RedisHashClient {
  private store = new Map<string, Map<string, string>>();

  async hset(key: string, fields: Record<string, string>): Promise<number> {
    let hash = this.store.get(key);
    if (!hash) {
      hash = new Map();
      this.store.set(key, hash);
    }
    let added = 0;
    for (const [field, value] of Object.entries(fields)) {
      if (!hash.has(field)) added++;
      hash.set(field, value);
    }
    return added;
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.store.get(key)?.get(field) ?? null;
  }

  async hgetall(key: string): Promise<Record<string, string> | null> {
    const hash = this.store.get(key);
    if (!hash) return null;
    return Object.fromEntries(hash);
  }

  async expire(): Promise<number> {
    return 1;
  }

  async hsetWithExpire(key: string, fields: Record<string, string>, seconds: number): Promise<void> {
    await this.hset(key, fields);
    await this.expire(key, seconds);
  }
}
