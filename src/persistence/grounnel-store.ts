import { randomUUID } from "node:crypto";
import type { Redis } from "@upstash/redis";
import { ClaimSchema, type Claim, type ClaimResult, type StatusResponse } from "../contracts/grounnel.schemas.js";

// D019 §4 — comfortably covers the P0 one-shot flow and a time-limited shareable-result page
// without needing Postgres. Distinct from the search/fetch cache's own TTL by design.
const AUDIT_TTL_SECONDS = 60 * 60 * 24 * 7;

export interface GrounnelStore {
  createAudit(data: {
    text: string;
    maxClaims: number;
    claims: Array<Pick<Claim, "id" | "text">>;
    truncated: boolean;
  }): Promise<{ id: string }>;
  writeClaimResult(auditId: string, claimId: string, result: ClaimResult): Promise<void>;
  getStatus(id: string): Promise<StatusResponse | null>;
}

/** The subset of @upstash/redis's client this store needs — narrow enough to fake in tests without a live connection. */
export interface RedisHashClient {
  hset(key: string, fields: Record<string, string>): Promise<number>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string> | null>;
  expire(key: string, seconds: number): Promise<number>;
  // hset + expire combined into one round-trip (e.g. via @upstash/redis's multi()/pipeline()) —
  // two separate calls left a crash-between-them window where the hash gets no TTL and leaks.
  hsetWithExpire(key: string, fields: Record<string, string>, seconds: number): Promise<void>;
}

// Immutable, creation-time-only facts. Deliberately does NOT store `status` or `progress` —
// both are derived from the claims currently in the hash every read (getStatus), so there is
// no second place for them to drift out of sync with the claims that are the actual source of
// truth. Deviates from D019 §4's illustrative `HSET ... meta '{"status":"verifying",...}'`
// example, which shows status as stored/mutable — this store recomputes it instead. `truncated`
// is the caller's own real signal (EXTRACT's self-reported flag OR-ed with the cap actually
// being applied), not re-derived from `total`/`maxClaims` — a `total >= maxClaims` comparison
// false-positives when EXTRACT legitimately returns exactly the cap with nothing cut.
interface Meta {
  total: number;
  truncated: boolean;
}

/**
 * Adapts @upstash/redis's `Redis` client to `RedisHashClient` (T012 wiring). The caller must
 * construct `Redis` with `automaticDeserialization: false` — this store always hands it strings
 * it already `JSON.stringify`'d itself, and the client's default auto-JSON-parse-on-read would
 * hand `writeClaimResult`/`getStatus` an object instead of the string they call `JSON.parse` on.
 */
export class UpstashRedisHashClient implements RedisHashClient {
  constructor(private readonly redis: Redis) {}

  async hset(key: string, fields: Record<string, string>): Promise<number> {
    return this.redis.hset(key, fields);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.redis.hget<string>(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string> | null> {
    // automaticDeserialization:false also disables HGETALL's own field-flattening deserializer
    // (not just JSON parsing) — the SDK then hands back its raw REST reply, a flat
    // [field1, value1, field2, value2, ...] array, not an object. Zipped here instead of via
    // redis.hgetall<Record<string,string>>(), which would silently return that array as-is.
    // Cast: the SDK's own type says Record<string, unknown>, but under automaticDeserialization:false
    // this command's actual runtime shape is the raw flat array described above, not an object.
    const flat = (await this.redis.hgetall<Record<string, unknown>>(key)) as unknown as string[] | null;
    // A missing key comes back as `[]` (truthy), not `null` — HGETALL on a key that doesn't
    // exist is an empty array over the REST wire, same as real Redis's empty-hash reply.
    if (!flat || flat.length === 0) return null;
    const result: Record<string, string> = {};
    for (let i = 0; i < flat.length; i += 2) {
      result[flat[i]!] = flat[i + 1]!;
    }
    return result;
  }

  async expire(key: string, seconds: number): Promise<number> {
    return this.redis.expire(key, seconds);
  }

  async hsetWithExpire(key: string, fields: Record<string, string>, seconds: number): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.hset(key, fields);
    pipeline.expire(key, seconds);
    await pipeline.exec();
  }
}

const META_FIELD = "meta";

function claimField(claimId: string): string {
  return `claim:${claimId}`;
}

/**
 * Redis hash-per-audit persistence (D019 §4): one hash per audit (`audit:{id}`), one field per
 * claim plus `meta` — never a single JSON blob, which would need read-modify-write on every
 * batch completion and race when two batches finish close together (D019 §4).
 */
export class RedisGrounnelStore implements GrounnelStore {
  constructor(private readonly redis: RedisHashClient) {}

  async createAudit(data: {
    text: string;
    maxClaims: number;
    claims: Array<Pick<Claim, "id" | "text">>;
    truncated: boolean;
  }): Promise<{ id: string }> {
    const id = randomUUID();
    const key = `audit:${id}`;
    const meta: Meta = { total: data.claims.length, truncated: data.truncated };
    const fields: Record<string, string> = { [META_FIELD]: JSON.stringify(meta) };
    for (const claim of data.claims) {
      const full: Claim = {
        id: claim.id,
        text: claim.text,
        status: "pending",
        verdict: null,
        evidence: null,
        confidence: null,
        reason: null,
        sources: [],
      };
      fields[claimField(claim.id)] = JSON.stringify(full);
    }
    await this.redis.hsetWithExpire(key, fields, AUDIT_TTL_SECONDS);
    return { id };
  }

  async writeClaimResult(auditId: string, claimId: string, result: ClaimResult): Promise<void> {
    const key = `audit:${auditId}`;
    const existingRaw = await this.redis.hget(key, claimField(claimId));
    if (!existingRaw) {
      throw new Error(
        `writeClaimResult: no existing claim ${claimId} for audit ${auditId} — createAudit must write the initial claim list first`
      );
    }
    const existing = ClaimSchema.parse(JSON.parse(existingRaw));
    const merged: Claim = { ...existing, ...result };
    // Single-field HSET — independent of every other claim's own field, which is what makes
    // concurrent writeClaimResult calls for different claims land without clobbering each other.
    await this.redis.hset(key, { [claimField(claimId)]: JSON.stringify(merged) });
  }

  async getStatus(id: string): Promise<StatusResponse | null> {
    const key = `audit:${id}`;
    const raw = await this.redis.hgetall(key);
    if (!raw || !raw[META_FIELD]) return null;
    const meta = JSON.parse(raw[META_FIELD]) as Meta;

    const claims: Claim[] = [];
    for (const [field, value] of Object.entries(raw)) {
      if (field === META_FIELD) continue;
      claims.push(ClaimSchema.parse(JSON.parse(value)));
    }

    const checked = claims.filter((c) => c.status !== "pending").length;
    const total = meta.total;
    const status: StatusResponse["status"] =
      total === 0 || checked === total ? "done" : checked === 0 ? "extracting" : "verifying";

    const grounded_n = claims.filter((c) => c.verdict === "supported").length;
    const unclear_n = claims.filter((c) => c.verdict === "partially_supported" || c.verdict === "unverifiable").length;
    const no_evidence_n = claims.filter((c) => c.verdict === "unsupported").length;
    const contradicted_n = claims.filter((c) => c.verdict === "contradicted").length;
    const not_checked_n = claims.filter((c) => c.status === "failed").length;
    const eligible = grounded_n + unclear_n + no_evidence_n + contradicted_n + not_checked_n;
    const grounded_pct = eligible === 0 ? 0 : Math.round((grounded_n / eligible) * 100);

    return {
      id,
      status,
      progress: { checked, total },
      claims,
      score: { grounded_pct, grounded_n, unclear_n, no_evidence_n, contradicted_n, not_checked_n, eligible },
      caps_hit: meta.truncated,
    };
  }
}
