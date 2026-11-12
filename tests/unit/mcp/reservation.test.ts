import { describe, it, expect, beforeEach } from "vitest";
import { RequestTokenReservations, CREATED_TTL_SECONDS, PENDING_TTL_SECONDS, type ReservationRedisClient } from "../../../src/mcp/reservation.js";

class FakeReservationRedis implements ReservationRedisClient {
  store = new Map<string, { fields: Record<string, string>; ttl: number }>();

  async createIfAbsent(key: string, fields: Record<string, string>, ttlSeconds: number) {
    if (this.store.has(key)) return false;
    this.store.set(key, { fields: { ...fields }, ttl: ttlSeconds });
    return true;
  }
  async read(key: string) {
    return this.store.get(key)?.fields ?? null;
  }
  async updateIfOwner(key: string, owner: string, fields: Record<string, string>, ttlSeconds: number) {
    const entry = this.store.get(key);
    if (!entry || entry.fields.owner !== owner) return false;
    this.store.set(key, { fields: { ...entry.fields, ...fields }, ttl: ttlSeconds });
    return true;
  }
  async deleteIfOwner(key: string, owner: string) {
    if (this.store.get(key)?.fields.owner !== owner) return false;
    return this.store.delete(key);
  }
  expire(key: string) {
    this.store.delete(key);
  }
}

const KEY = "mcp:reqtok:qwen:abc:tok-1";

describe("RequestTokenReservations", () => {
  let redis: FakeReservationRedis;
  let reservations: RequestTokenReservations;
  beforeEach(() => {
    redis = new FakeReservationRedis();
    reservations = new RequestTokenReservations(redis);
  });

  it("gives the first start a pending lease with an owner", async () => {
    const outcome = await reservations.reserve(KEY, "text-a");
    expect(outcome.kind).toBe("owner");
    expect(redis.store.get(KEY)).toMatchObject({ fields: { state: "pending", textHmac: "text-a" }, ttl: PENDING_TTL_SECONDS });
  });

  it("answers a second start with the same text as in progress while the lease is pending", async () => {
    await reservations.reserve(KEY, "text-a");
    expect(await reservations.reserve(KEY, "text-a")).toEqual({ kind: "in_progress" });
  });

  it("answers a different text under the same token as a conflict, pending or created", async () => {
    const first = await reservations.reserve(KEY, "text-a");
    expect(await reservations.reserve(KEY, "text-b")).toEqual({ kind: "conflict" });
    if (first.kind !== "owner") throw new Error("expected owner");
    await reservations.markCreated(KEY, first.owner, "share-1");
    expect(await reservations.reserve(KEY, "text-b")).toEqual({ kind: "conflict" });
  });

  it("hands a retry the stored share token once created, for the hour", async () => {
    const first = await reservations.reserve(KEY, "text-a");
    if (first.kind !== "owner") throw new Error("expected owner");
    expect(await reservations.markCreated(KEY, first.owner, "share-1")).toBe(true);
    expect(redis.store.get(KEY)?.ttl).toBe(CREATED_TTL_SECONDS);
    expect(await reservations.reserve(KEY, "text-a")).toEqual({ kind: "created", shareToken: "share-1" });
  });

  it("lets a retry start cleanly after the owner's lease expired", async () => {
    await reservations.reserve(KEY, "text-a");
    redis.expire(KEY);
    expect((await reservations.reserve(KEY, "text-a")).kind).toBe("owner");
  });

  it("frees the token when the owner releases it after a failure", async () => {
    const first = await reservations.reserve(KEY, "text-a");
    if (first.kind !== "owner") throw new Error("expected owner");
    await reservations.release(KEY, first.owner);
    expect((await reservations.reserve(KEY, "text-a")).kind).toBe("owner");
  });

  it("refuses to advance or release for anyone but the owner", async () => {
    await reservations.reserve(KEY, "text-a");
    expect(await reservations.markCreated(KEY, "someone-else", "share-x")).toBe(false);
    await reservations.release(KEY, "someone-else");
    expect(redis.store.get(KEY)?.fields.state).toBe("pending");
  });

  it("does not resurrect an expired lease when its late owner tries to mark it created", async () => {
    const first = await reservations.reserve(KEY, "text-a");
    if (first.kind !== "owner") throw new Error("expected owner");
    redis.expire(KEY);
    const second = await reservations.reserve(KEY, "text-a");
    expect(await reservations.markCreated(KEY, first.owner, "share-late")).toBe(false);
    expect(second.kind).toBe("owner");
    expect(redis.store.get(KEY)?.fields.state).toBe("pending");
  });
});

describe("UpstashReservationRedisClient.read", () => {
  it("zips the flat array Upstash returns without automatic deserialization", async () => {
    const { UpstashReservationRedisClient } = await import("../../../src/mcp/reservation.js");
    const fake = { createScript: () => ({}), hgetall: async () => ["state", "pending", "owner", "o1", "textHmac", "abc123"] };
    const client = new UpstashReservationRedisClient(fake as never);
    expect(await client.read("k")).toEqual({ state: "pending", owner: "o1", textHmac: "abc123" });
  });

  it("treats an empty array or null as absent", async () => {
    const { UpstashReservationRedisClient } = await import("../../../src/mcp/reservation.js");
    for (const empty of [[], null]) {
      const client = new UpstashReservationRedisClient({ createScript: () => ({}), hgetall: async () => empty } as never);
      expect(await client.read("k")).toBeNull();
    }
  });
});
