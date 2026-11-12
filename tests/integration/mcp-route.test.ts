import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { registerMcpRoute } from "../../src/routes/mcp.js";
import { RequestTokenReservations, type ReservationRedisClient } from "../../src/mcp/reservation.js";
import type { StartToolDeps } from "../../src/mcp/tools/start.js";
import type { ReadToolDeps } from "../../src/mcp/tools/read.js";
import type { SharedAssessment } from "../../src/contracts/grounnel.schemas.js";
import type { Provider } from "../../src/providers/types.js";

const KEY = "sk-integration-secret-777";
const TOKEN = "knrYomRVILN14zljAhoJeeja7POX0EE_";

const noReservations: ReservationRedisClient = {
  createIfAbsent: async () => true,
  read: async () => null,
  updateIfOwner: async () => true,
  deleteIfOwner: async () => true,
};

const assessment: SharedAssessment = {
  status: "done", text: "t", createdAt: "", completedAt: null, provider: "qwen", model: "m", ownKeyTokens: { input: 10, output: 2 },
  truncated: false, failureReason: null,
  counts: { supported: 1, partiallySupported: 0, unsupported: 0, unverifiable: 0, contradicted: 0, excluded: 0, noVerdict: 0 },
  claims: [{ text: "c", verdict: "supported", evidence: null, confidence: 0.9, reason: "r", sources: [{ kind: "web", title: "A", domain: "a.example", url: "https://a.example/", status: "ok" }], citations: [], status: "done", sourceExcerpt: null }],
};

describe("POST /mcp (T2138)", () => {
  let app: FastifyInstance;
  let url: URL;
  const builtWith: string[] = [];

  beforeAll(async () => {
    const allow = { consume: async () => ({ allowed: true as const }) };
    const deps: StartToolDeps & ReadToolDeps = {
      secret: "s".repeat(64),
      switchRedis: { exists: async () => 0 },
      reservations: new RequestTokenReservations(noReservations),
      startLimiter: allow,
      tokenLimiter: allow,
      globalLimiter: allow,
      buildProvider: (id, key) => { builtWith.push(`${id}:${key === KEY}`); return { mode: id, model: "m" } as Provider; },
      startCheck: async () => ({ ok: true, id: "run-1", shareToken: TOKEN, pendingClaims: [{ id: "c1", text: "c" }] as never }),
      readAssessment: async (token) => (token === TOKEN ? assessment : null),
    };
    app = Fastify();
    registerMcpRoute(app, deps);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    url = new URL(`http://127.0.0.1:${address.port}/mcp`);
  });

  afterAll(async () => {
    await app.close();
  });

  async function connect(era: "legacy" | "modern"): Promise<Client> {
    const client = new Client(
      { name: "test", version: "1.0.0" },
      era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {}
    );
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { "X-Grounnel-Provider": "qwen", "X-Grounnel-Provider-Key": KEY } },
    });
    await client.connect(transport);
    return client;
  }

  it.each(["legacy", "modern"] as const)("serves the same tools and results to a %s client", async (era) => {
    const client = await connect(era);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_fact_check", "start_fact_check"]);

    const read = await client.callTool({ name: "get_fact_check", arguments: { shareToken: TOKEN } });
    expect(read.isError).toBeFalsy();
    expect(read.structuredContent).toMatchObject({ status: "done", provider: "qwen", capHit: false, claims: [{ verdict: "supported" }] });

    // The connection headers reach the handler in both eras.
    const started = await client.callTool({ name: "start_fact_check", arguments: { text: "Paris is in France." } });
    expect(started.isError).toBeFalsy();
    expect(started.structuredContent).toMatchObject({ shareToken: TOKEN, status: "running" });
    expect(builtWith.at(-1)).toBe("qwen:true");

    const bad = await client.callTool({ name: "start_fact_check", arguments: { text: "" } });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent).toMatchObject({ code: "empty_text" });
    expect(JSON.stringify([read, started, bad])).not.toContain(KEY);
    await client.close();
  });

  it("refuses a browser Origin and answers GET and DELETE with 405", async () => {
    const withOrigin = await fetch(url, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
    expect(withOrigin.status).toBe(403);
    expect((await fetch(url)).status).toBe(405);
    expect((await fetch(url, { method: "DELETE" })).status).toBe(405);
  });
});

describe("POST /mcp never leaks the provider key (T2119)", () => {
  it("keeps a synthetic key out of logs, results, Redis and stored errors on every path", async () => {
    const { logger } = await import("../../src/observability/logger.js");
    const { vi } = await import("vitest");
    const logged: unknown[] = [];
    const spies = (["info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { logged.push(args); }) as never)
    );
    const redisWrites: unknown[] = [];
    const recordingRedis: ReservationRedisClient = {
      createIfAbsent: async (key, fields) => { redisWrites.push(key, fields); return true; },
      read: async () => null,
      updateIfOwner: async (key, _owner, fields) => { redisWrites.push(key, fields); return true; },
      deleteIfOwner: async (key) => { redisWrites.push(key); return true; },
    };
    const limiterIds: string[] = [];
    let mode: "ok" | "preflight" | "extraction" = "ok";
    const deps: StartToolDeps & ReadToolDeps = {
      secret: "s".repeat(64),
      switchRedis: { exists: async () => 0 },
      reservations: new RequestTokenReservations(recordingRedis),
      startLimiter: { consume: async (id) => { limiterIds.push(id); return { allowed: true }; } },
      tokenLimiter: { consume: async (id) => { limiterIds.push(id); return { allowed: true }; } },
      globalLimiter: { consume: async () => ({ allowed: true }) },
      buildProvider: (id) => ({ mode: id, model: "m" }) as Provider,
      startCheck: async (input) => {
        if (mode === "preflight") return { ok: false, kind: "preflight", failure: { category: "invalid_key", message: "The key was rejected." } };
        // A provider error that echoes the key, as some do: it must stop at the handler.
        if (mode === "extraction") return { ok: false, kind: "extraction_failed", error: new Error(`401 for key ${KEY}`) };
        await input.onRunCreated?.(TOKEN);
        return { ok: true, id: "run-1", shareToken: TOKEN, pendingClaims: [] };
      },
      readAssessment: async (token) => (token === TOKEN ? assessment : null),
    };
    const app = Fastify();
    registerMcpRoute(app, deps);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const target = new URL(`http://127.0.0.1:${address.port}/mcp`);

    const results: unknown[] = [];
    for (const era of ["legacy", "modern"] as const) {
      const client = new Client({ name: "leak", version: "1.0.0" }, era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {});
      await client.connect(new StreamableHTTPClientTransport(target, { requestInit: { headers: { "X-Grounnel-Provider": "qwen", "X-Grounnel-Provider-Key": KEY } } }));
      results.push(await client.listTools());
      mode = "ok";
      results.push(await client.callTool({ name: "start_fact_check", arguments: { text: "Paris is in France.", requestToken: `ok-${era}` } }));
      mode = "preflight";
      results.push(await client.callTool({ name: "start_fact_check", arguments: { text: "Paris.", requestToken: `pf-${era}` } }));
      mode = "extraction";
      results.push(await client.callTool({ name: "start_fact_check", arguments: { text: "Paris!", requestToken: `ex-${era}` } }));
      results.push(await client.callTool({ name: "get_fact_check", arguments: { shareToken: TOKEN } }));
      results.push(await client.callTool({ name: "get_fact_check", arguments: { shareToken: "nope" } }));
      await client.close();
    }
    await app.close();
    spies.forEach((spy) => spy.mockRestore());

    expect(results.length).toBe(12);
    expect(redisWrites.length).toBeGreaterThan(0);
    for (const [what, value] of [["results", results], ["logs", logged], ["redis", redisWrites], ["limiter ids", limiterIds]] as const) {
      expect(JSON.stringify(value, (_k, v) => (v instanceof Error ? `${v.message} ${v.stack}` : v)), what).not.toContain(KEY);
    }
  });
});
