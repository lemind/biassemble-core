import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerGrounnelRoutes } from "../../src/routes/grounnel.js";
import { GrounnelExtractService } from "../../src/orchestrators/grounnel/extract.service.js";
import { GrounnelPipelineService } from "../../src/orchestrators/grounnel/pipeline.service.js";
import { RedisGrounnelStore } from "../../src/persistence/grounnel-store.js";
import { RateLimiter } from "../../src/lib/rate-limit.js";
import { PromptRegistry } from "../../src/prompts/registry.js";
import { MockProvider } from "../mocks/mock-provider.js";
import { FakeRedisHashClient } from "../mocks/fake-redis-hash-client.js";
import { NoopGrounnelHistoryStore } from "../mocks/noop-grounnel-history-store.js";
import { NoopGrounnelLlmCallStore } from "../mocks/noop-grounnel-llm-call-store.js";
import { NoopGrounnelGateEventStore } from "../mocks/noop-grounnel-gate-event-store.js";
import type { SearchProvider, SearchPassage } from "../../src/providers/search/search-provider.js";

const VALID_AUTH = "Bearer dev-secret-change-me";
const NEVER_CALLED_SEARCH: SearchProvider = {
  async search(): Promise<SearchPassage[]> {
    throw new Error("SearchProvider must not be called — every claim here is opinion-shaped");
  },
};

function buildServer(limit: number) {
  const provider = new MockProvider();
  // Opinion-shaped — gate #3 resolves it during EXTRACT, no pipeline run, keeps each request fast
  // and deterministic so this file can focus purely on the rate limiter, not pipeline timing.
  provider.setDefault({ claims: [{ claim: "This is the best coffee in Rome." }], truncated: false });

  const server = Fastify();
  const grounnelStore = new RedisGrounnelStore(new FakeRedisHashClient());
  const prompts = new PromptRegistry();
  registerGrounnelRoutes(server, {
    extractService: new GrounnelExtractService(provider, prompts, grounnelStore, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore()),
    pipelineService: new GrounnelPipelineService(NEVER_CALLED_SEARCH, provider, prompts, grounnelStore, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore()),
    grounnelStore,
    rateLimiter: new RateLimiter(limit, 60_000),
  });
  return server;
}

async function post(server: ReturnType<typeof buildServer>, remoteAddress: string) {
  return server.inject({
    method: "POST",
    url: "/extract",
    headers: { authorization: VALID_AUTH },
    payload: { text: "Some pasted article text." },
    remoteAddress,
  });
}

describe("POST /extract rate limiting (T016, defense-in-depth behind authHook — D020 §4)", () => {
  it("allows requests up to the configured per-IP limit, then returns 429", async () => {
    const server = buildServer(2);

    const first = await post(server, "1.2.3.4");
    const second = await post(server, "1.2.3.4");
    const third = await post(server, "1.2.3.4");

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(third.statusCode).toBe(429);
    expect(JSON.parse(third.body)).toEqual({ error: "Too many requests — try again later." });
  });

  it("tracks separate IPs independently — one IP hitting the limit doesn't block another", async () => {
    const server = buildServer(1);

    const ipA_first = await post(server, "10.0.0.1");
    const ipB_first = await post(server, "10.0.0.2");
    const ipA_second = await post(server, "10.0.0.1");

    expect(ipA_first.statusCode).toBe(202);
    expect(ipB_first.statusCode).toBe(202);
    expect(ipA_second.statusCode).toBe(429);
  });

  it("authHook still runs first — an unauthenticated request gets 401 even once that IP has already exhausted its rate limit (D020 §4's defense-in-depth ordering)", async () => {
    const server = buildServer(1);
    const exhausted = await post(server, "5.5.5.5");
    expect(exhausted.statusCode).toBe(202);

    const res = await server.inject({ method: "POST", url: "/extract", payload: { text: "x" }, remoteAddress: "5.5.5.5" });
    expect(res.statusCode).toBe(401);
  });
});
