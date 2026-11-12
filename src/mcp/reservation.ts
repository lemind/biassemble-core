import { randomUUID } from "node:crypto";
import type { Redis } from "@upstash/redis";

/** Lease while a start is in flight; longer than a start's p95 with margin (D034 §5). */
export const PENDING_TTL_SECONDS = 120;
/** A created reservation answers retries for the rest of the hour. */
export const CREATED_TTL_SECONDS = 3600;

export type ReserveOutcome =
  | { kind: "owner"; owner: string }
  | { kind: "created"; shareToken: string }
  | { kind: "in_progress" }
  | { kind: "conflict" };

/** The Redis operations a reservation needs; each is atomic server-side. Narrow enough to fake in tests. */
export interface ReservationRedisClient {
  createIfAbsent(key: string, fields: Record<string, string>, ttlSeconds: number): Promise<boolean>;
  read(key: string): Promise<Record<string, string> | null>;
  updateIfOwner(key: string, owner: string, fields: Record<string, string>, ttlSeconds: number): Promise<boolean>;
  deleteIfOwner(key: string, owner: string): Promise<boolean>;
}

export function reservationKey(provider: string, keyHmac: string, requestToken: string): string {
  return `mcp:reqtok:${provider}:${keyHmac}:${requestToken}`;
}

/** Request-token reservations for start_fact_check (data-model.md). Only the owner advances or releases one. */
export class RequestTokenReservations {
  constructor(private readonly redis: ReservationRedisClient) {}

  async reserve(key: string, textHmac: string): Promise<ReserveOutcome> {
    // Twice: a lease can expire between a failed create and the read that follows it.
    for (let attempt = 0; attempt < 2; attempt++) {
      const owner = randomUUID();
      if (await this.redis.createIfAbsent(key, { state: "pending", owner, textHmac }, PENDING_TTL_SECONDS)) {
        return { kind: "owner", owner };
      }
      const existing = await this.redis.read(key);
      if (!existing) continue;
      if (existing.textHmac !== textHmac) return { kind: "conflict" };
      if (existing.state === "created" && existing.shareToken) return { kind: "created", shareToken: existing.shareToken };
      return { kind: "in_progress" };
    }
    return { kind: "in_progress" };
  }

  /** False when this owner no longer holds the lease (expired, or never held it). */
  async markCreated(key: string, owner: string, shareToken: string): Promise<boolean> {
    return this.redis.updateIfOwner(key, owner, { state: "created", shareToken }, CREATED_TTL_SECONDS);
  }

  async release(key: string, owner: string): Promise<void> {
    await this.redis.deleteIfOwner(key, owner);
  }
}

const CREATE_IF_ABSENT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
for i = 2, #ARGV, 2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]) end
redis.call('EXPIRE', KEYS[1], ARGV[1])
return 1`;
const UPDATE_IF_OWNER = `
if redis.call('HGET', KEYS[1], 'owner') ~= ARGV[1] then return 0 end
for i = 3, #ARGV, 2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1]) end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1`;
const DELETE_IF_OWNER = `
if redis.call('HGET', KEYS[1], 'owner') ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])`;

function flatten(fields: Record<string, string>): string[] {
  return Object.entries(fields).flat();
}

/** Adapts @upstash/redis to ReservationRedisClient with one Lua script per operation. */
export class UpstashReservationRedisClient implements ReservationRedisClient {
  private readonly create;
  private readonly update;
  private readonly remove;

  constructor(private readonly redis: Redis) {
    this.create = redis.createScript<number>(CREATE_IF_ABSENT);
    this.update = redis.createScript<number>(UPDATE_IF_OWNER);
    this.remove = redis.createScript<number>(DELETE_IF_OWNER);
  }

  async createIfAbsent(key: string, fields: Record<string, string>, ttlSeconds: number): Promise<boolean> {
    return (await this.create.eval([key], [String(ttlSeconds), ...flatten(fields)])) === 1;
  }

  async read(key: string): Promise<Record<string, string> | null> {
    const fields = await this.redis.hgetall<Record<string, string>>(key);
    return fields && Object.keys(fields).length > 0 ? fields : null;
  }

  async updateIfOwner(key: string, owner: string, fields: Record<string, string>, ttlSeconds: number): Promise<boolean> {
    return (await this.update.eval([key], [owner, String(ttlSeconds), ...flatten(fields)])) === 1;
  }

  async deleteIfOwner(key: string, owner: string): Promise<boolean> {
    return (await this.remove.eval([key], [owner])) === 1;
  }
}
