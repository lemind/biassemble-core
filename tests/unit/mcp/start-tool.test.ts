import { describe, it, expect, beforeEach } from "vitest";
import { handleStartFactCheck, type StartToolDeps } from "../../../src/mcp/tools/start.js";
import { RequestTokenReservations, type ReservationRedisClient } from "../../../src/mcp/reservation.js";
import type { StartCheckInput, StartCheckResult } from "../../../src/orchestrators/grounnel/start-check.js";
import type { Provider } from "../../../src/providers/types.js";

const KEY = "sk-user-secret-123";
const SECRET = "s".repeat(64);

class MemoryReservations implements ReservationRedisClient {
  store = new Map<string, Record<string, string>>();
  ops = 0;
  async createIfAbsent(key: string, fields: Record<string, string>) {
    this.ops++;
    if (this.store.has(key)) return false;
    this.store.set(key, { ...fields });
    return true;
  }
  async read(key: string) {
    this.ops++;
    return this.store.get(key) ?? null;
  }
  async updateIfOwner(key: string, owner: string, fields: Record<string, string>) {
    const entry = this.store.get(key);
    if (entry?.owner !== owner) return false;
    this.store.set(key, { ...entry, ...fields });
    return true;
  }
  async deleteIfOwner(key: string, owner: string) {
    if (this.store.get(key)?.owner !== owner) return false;
    return this.store.delete(key);
  }
}

function headers(provider?: string, key?: string): Headers {
  const h = new Headers();
  if (provider) h.set("X-Grounnel-Provider", provider);
  if (key) h.set("X-Grounnel-Provider-Key", key);
  return h;
}

describe("start_fact_check", () => {
  let redis: MemoryReservations;
  let consumed: string[];
  let switchCalls: number;
  let built: Array<{ id: string; key: string }>;
  let startInputs: StartCheckInput[];
  let startResult: StartCheckResult;
  let deps: StartToolDeps;

  beforeEach(() => {
    redis = new MemoryReservations();
    consumed = [];
    switchCalls = 0;
    built = [];
    startInputs = [];
    startResult = { ok: true, id: "run-1", shareToken: "share-1", pendingClaims: [{ id: "c1", text: "t" }] as never };
    deps = {
      secret: SECRET,
      switchRedis: { exists: async () => { switchCalls++; return 0; } },
      reservations: new RequestTokenReservations(redis),
      startLimiter: { consume: async (id) => { consumed.push(id); return { allowed: true }; } },
      buildProvider: (id, key) => { built.push({ id, key }); return { mode: id, model: "m" } as Provider; },
      startCheck: async (input) => {
        startInputs.push(input);
        if (startResult.ok) await input.onRunCreated?.(startResult.shareToken);
        return startResult;
      },
      readAssessment: async () => ({ status: "verifying", claims: [{}, {}] }) as never,
    };
  });

  it("starts with the chosen provider and the caller's key, as an own-key MCP run", async () => {
    const result = await handleStartFactCheck({ text: "Paris is in France." }, headers("qwen", KEY), deps);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ shareToken: "share-1", status: "running", phase: "verifying", claimsFound: 1, readAfterSeconds: 15 });
    expect(built).toEqual([{ id: "qwen", key: KEY }]);
    expect(startInputs[0]).toMatchObject({ keySource: "own", entryPoint: "mcp" });
  });

  it.each([
    [headers(undefined, undefined), "key_required"],
    [headers("qwen", undefined), "key_required"],
    [headers(undefined, KEY), "provider_not_chosen"],
    [headers("openai", KEY), "unsupported_provider"],
    [undefined, "key_required"],
  ])("refuses bad headers before touching Redis (%#)", async (h, code) => {
    const result = await handleStartFactCheck({ text: "x" }, h, deps);
    expect(result.structuredContent).toMatchObject({ code });
    expect(switchCalls + redis.ops + consumed.length).toBe(0);
  });

  it.each([
    [{ text: "   " }, "empty_text"],
    [{ text: 42 }, "empty_text"],
    [{ text: "x".repeat(20_001) }, "text_too_large"],
    [{ text: "x", requestToken: "has space" }, "invalid_request_token"],
    [{ text: "x", requestToken: "" }, "invalid_request_token"],
  ])("validates input in the handler before any Redis call (%#)", async (args, code) => {
    const result = await handleStartFactCheck(args, headers("qwen", KEY), deps);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code });
    expect(switchCalls + redis.ops + consumed.length).toBe(0);
  });

  it("refuses every start without the HMAC secret", async () => {
    const result = await handleStartFactCheck({ text: "x" }, headers("qwen", KEY), { ...deps, secret: undefined });
    expect(result.structuredContent).toMatchObject({ code: "service_unavailable" });
  });

  it("refuses starts while the switch is off", async () => {
    deps.switchRedis = { exists: async () => 1 };
    const result = await handleStartFactCheck({ text: "x" }, headers("qwen", KEY), deps);
    expect(result.structuredContent).toMatchObject({ code: "service_unavailable" });
    expect(startInputs).toHaveLength(0);
  });

  it("fails closed when Redis throws", async () => {
    deps.startLimiter = { consume: async () => { throw new Error("redis down"); } };
    const result = await handleStartFactCheck({ text: "x" }, headers("qwen", KEY), deps);
    expect(result.structuredContent).toMatchObject({ code: "service_unavailable" });
    expect(startInputs).toHaveLength(0);
  });

  it("reports the window's remaining seconds when the key's allowance is used up", async () => {
    deps.startLimiter = { consume: async () => ({ allowed: false, retryAfterSeconds: 900 }) };
    const result = await handleStartFactCheck({ text: "x", requestToken: "t1" }, headers("qwen", KEY), deps);
    expect(result.structuredContent).toMatchObject({ code: "rate_limited", retryAfterSeconds: 900 });
    expect(redis.store.size).toBe(0);
  });

  it("releases the reservation when preflight fails", async () => {
    startResult = { ok: false, kind: "preflight", failure: { category: "no_balance", message: "No balance." } };
    const result = await handleStartFactCheck({ text: "x", requestToken: "t1" }, headers("deepseek", KEY), deps);
    expect(result.structuredContent).toMatchObject({ code: "preflight_no_balance" });
    expect(redis.store.size).toBe(0);
  });

  it("answers a duplicate after the check exists with the same share token and no allowance", async () => {
    await handleStartFactCheck({ text: "same text", requestToken: "t1" }, headers("qwen", KEY), deps);
    const again = await handleStartFactCheck({ text: "same text", requestToken: "t1" }, headers("qwen", KEY), deps);
    expect(again.structuredContent).toMatchObject({ shareToken: "share-1", status: "running", claimsFound: 2 });
    expect(consumed).toHaveLength(1);
    expect(startInputs).toHaveLength(1);
  });

  it("refuses the same token with different text", async () => {
    await handleStartFactCheck({ text: "first", requestToken: "t1" }, headers("qwen", KEY), deps);
    const other = await handleStartFactCheck({ text: "second", requestToken: "t1" }, headers("qwen", KEY), deps);
    expect(other.structuredContent).toMatchObject({ code: "token_conflict" });
  });

  it("never puts the key in a result or a Redis key or value", async () => {
    const results = [
      await handleStartFactCheck({ text: "x", requestToken: "t1" }, headers("qwen", KEY), deps),
      await handleStartFactCheck({ text: "" }, headers("qwen", KEY), deps),
    ];
    startResult = { ok: false, kind: "extraction_failed", error: new Error(`boom ${KEY}`) };
    results.push(await handleStartFactCheck({ text: "y", requestToken: "t2" }, headers("qwen", KEY), deps));
    expect(JSON.stringify(results)).not.toContain(KEY);
    expect(JSON.stringify([...redis.store.entries()])).not.toContain(KEY);
    expect(consumed.join()).not.toContain(KEY);
  });
});
