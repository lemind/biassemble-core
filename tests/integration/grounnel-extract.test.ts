import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerGrounnelRoutes } from "../../src/routes/grounnel.js";
import { GrounnelExtractService } from "../../src/orchestrators/grounnel/extract.service.js";
import { GrounnelPipelineService } from "../../src/orchestrators/grounnel/pipeline.service.js";
import { RedisGrounnelStore } from "../../src/persistence/grounnel-store.js";
import { RateLimiter } from "../../src/lib/rate-limit.js";
import { PromptRegistry } from "../../src/prompts/registry.js";
import { RateLimitError } from "../../src/providers/gemini.js";
import { MockProvider } from "../mocks/mock-provider.js";
import { FakeRedisHashClient } from "../mocks/fake-redis-hash-client.js";
import type { SearchProvider, SearchPassage } from "../../src/providers/search/search-provider.js";
import type { Provider } from "../../src/providers/types.js";

const VALID_AUTH = "Bearer dev-secret-change-me";
const NEVER_CALLED_SEARCH: SearchProvider = {
  async search(): Promise<SearchPassage[]> {
    throw new Error("SearchProvider must not be called for opinion-only claims");
  },
};

function buildServer(provider: Provider, searchProvider: SearchProvider = NEVER_CALLED_SEARCH): FastifyInstance {
  const server = Fastify();
  const grounnelStore = new RedisGrounnelStore(new FakeRedisHashClient());
  const prompts = new PromptRegistry();
  registerGrounnelRoutes(server, {
    extractService: new GrounnelExtractService(provider, prompts, grounnelStore),
    pipelineService: new GrounnelPipelineService(searchProvider, provider, prompts, grounnelStore),
    grounnelStore,
    // High limit — this file exercises /extract's own contract, not rate limiting (T016's job).
    rateLimiter: new RateLimiter(1000, 60_000),
  });
  return server;
}

describe("POST /extract (T014)", () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider();
    // Opinion-shaped — gate #3 resolves it during EXTRACT, no pipeline run, no polling needed.
    provider.setDefault({ claims: [{ claim: "This is the best coffee in Rome." }], truncated: false });
  });

  it("returns 401 when the Authorization header is missing", async () => {
    const server = buildServer(provider);
    const res = await server.inject({ method: "POST", url: "/extract", payload: { text: "some article text" } });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Missing or invalid authorization header" });
  });

  it("returns 401 when the token is invalid", async () => {
    const server = buildServer(provider);
    const res = await server.inject({
      method: "POST",
      url: "/extract",
      headers: { authorization: "Bearer wrong-secret" },
      payload: { text: "some article text" },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "Invalid API key" });
  });

  it("returns 400 on a malformed body (empty text fails ExtractRequestSchema)", async () => {
    const server = buildServer(provider);
    const res = await server.inject({
      method: "POST",
      url: "/extract",
      headers: { authorization: VALID_AUTH },
      payload: { text: "" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("Invalid request body");
  });

  it("returns 202 { id } with the full claim list already written to the store (T009's guarantee, surfaced at the route level)", async () => {
    const server = buildServer(provider);
    const res = await server.inject({
      method: "POST",
      url: "/extract",
      headers: { authorization: VALID_AUTH },
      payload: { text: "Some pasted article text." },
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.id).toBeTruthy();

    const status = await server.inject({ method: "GET", url: `/status/${body.id}`, headers: { authorization: VALID_AUTH } });
    expect(status.statusCode).toBe(200);
    const statusBody = JSON.parse(status.body);
    expect(statusBody.claims).toHaveLength(1);
    expect(statusBody.claims[0].text).toBe("This is the best coffee in Rome.");
    // Opinion claim — gate #3 already resolved it to "done" synchronously, before the 202 was sent.
    expect(statusBody.claims[0].status).toBe("done");
    expect(statusBody.claims[0].verdict).toBe("unverifiable");
  });

  it("returns 503 with a clear retry message when Gemini itself is rate-limited during EXTRACT (no audit exists yet to write a per-claim reason into)", async () => {
    const rateLimitedProvider: Provider = {
      mode: "mock",
      completeJson: async () => {
        throw new RateLimitError("daily quota exceeded", "daily", "2026-08-07T00:00:00Z");
      },
    };
    const server = buildServer(rateLimitedProvider);
    const res = await server.inject({
      method: "POST",
      url: "/extract",
      headers: { authorization: VALID_AUTH },
      payload: { text: "Some pasted article text." },
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("We've hit today's AI usage limit. Please try again after 2026-08-07T00:00:00Z.");
    expect(body.limit_type).toBe("daily");
    expect(body.resets_at).toBe("2026-08-07T00:00:00Z");
  });

  it("returns 502 when EXTRACT fails for a non-rate-limit reason after exhausting retries", async () => {
    const failingProvider = new MockProvider();
    failingProvider.failAll("persistent provider error");
    const server = buildServer(failingProvider);

    const res = await server.inject({
      method: "POST",
      url: "/extract",
      headers: { authorization: VALID_AUTH },
      payload: { text: "Some pasted article text." },
    });

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body)).toEqual({ error: "Extract failed" });
  });
});
