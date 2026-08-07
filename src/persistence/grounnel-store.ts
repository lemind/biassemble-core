import { randomUUID } from "node:crypto";
import type { Redis } from "@upstash/redis";
import { ClaimSchema, type Claim, type ClaimResult, type StatusResponse } from "../contracts/grounnel.schemas.js";

// D019 §4 — comfortably covers the P0 one-shot flow and a time-limited shareable-result page
// without needing Postgres. Distinct from the search/fetch cache's own TTL by design.
const AUDIT_TTL_SECONDS = 60 * 60 * 24 * 7;

export interface GrounnelStore {
  createAudit(data: {
    id?: string;
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

// Deliberately excludes `status`/`progress` (derived from claims each read, no drift) and takes `truncated` as the caller's own signal, not `total>=maxClaims` — rationale: D019 §4.
// createdAt optional — audits written before this field existed have no value here.
interface Meta {
  total: number;
  truncated: boolean;
  createdAt?: string;
}

/** Adapts @upstash/redis's `Redis` to `RedisHashClient`. Build it with `automaticDeserialization: false` — this store parses JSON itself; the SDK's auto-parse would return objects, not strings. */
export class UpstashRedisHashClient implements RedisHashClient {
  constructor(private readonly redis: Redis) {}

  async hset(key: string, fields: Record<string, string>): Promise<number> {
    return this.redis.hset(key, fields);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.redis.hget<string>(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string> | null> {
    // automaticDeserialization:false skips HGETALL's field-flattening too — SDK returns the raw flat [field,value,...] array (`[]`, not null, when missing), zipped into an object here.
    const flat = (await this.redis.hgetall<Record<string, unknown>>(key)) as unknown as string[] | null;
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
const LAST_ACTIVITY_FIELD = "lastActivityAt";

function claimField(claimId: string): string {
  return `claim:${claimId}`;
}

/** Redis hash-per-audit persistence: one hash per audit (`audit:{id}`), one field per claim + `meta` — never one JSON blob, which would race across concurrent batch writes. D019 §4. */
export class RedisGrounnelStore implements GrounnelStore {
  constructor(private readonly redis: RedisHashClient) {}

  async createAudit(data: {
    id?: string;
    text: string;
    maxClaims: number;
    claims: Array<Pick<Claim, "id" | "text">>;
    truncated: boolean;
  }): Promise<{ id: string }> {
    const id = data.id ?? randomUUID();
    const key = `audit:${id}`;
    const meta: Meta = { total: data.claims.length, truncated: data.truncated, createdAt: new Date().toISOString() };
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
    // lastActivityAt rides along in the same call (no extra round trip) — getStatus uses it to
    // freeze elapsed_seconds once status is "done", instead of it counting up forever on every read.
    await this.redis.hset(key, { [claimField(claimId)]: JSON.stringify(merged), [LAST_ACTIVITY_FIELD]: new Date().toISOString() });
  }

  async getStatus(id: string): Promise<StatusResponse | null> {
    const key = `audit:${id}`;
    const raw = await this.redis.hgetall(key);
    if (!raw || !raw[META_FIELD]) return null;
    const meta = JSON.parse(raw[META_FIELD]) as Meta;

    const claims: Claim[] = [];
    for (const [field, value] of Object.entries(raw)) {
      if (field === META_FIELD || field === LAST_ACTIVITY_FIELD) continue;
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

    const startedAt = meta.createdAt ?? null;
    // Frozen at the last claim write once done, not Date.now() — otherwise elapsed_seconds keeps
    // climbing forever on every later poll of an already-finished run (real bug, caught live).
    const endedAt = status === "done" && raw[LAST_ACTIVITY_FIELD] ? raw[LAST_ACTIVITY_FIELD] : new Date().toISOString();
    const elapsedSeconds = startedAt ? Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000) : null;

    return {
      id,
      status,
      progress: { checked, total },
      claims,
      score: { grounded_pct, grounded_n, unclear_n, no_evidence_n, contradicted_n, not_checked_n, eligible },
      caps_hit: meta.truncated,
      started_at: startedAt,
      elapsed_seconds: elapsedSeconds,
    };
  }
}
