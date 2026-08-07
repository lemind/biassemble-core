import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
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
import type { SearchProvider, SearchPassage } from "../../src/providers/search/search-provider.js";
import type { Provider } from "../../src/providers/types.js";

const VALID_AUTH = "Bearer dev-secret-change-me";

function buildServer(provider: Provider, searchProvider: SearchProvider) {
  const server = Fastify();
  const grounnelStore = new RedisGrounnelStore(new FakeRedisHashClient());
  const prompts = new PromptRegistry();
  registerGrounnelRoutes(server, {
    extractService: new GrounnelExtractService(provider, prompts, grounnelStore, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore()),
    pipelineService: new GrounnelPipelineService(searchProvider, provider, prompts, grounnelStore, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore()),
    grounnelStore,
    rateLimiter: new RateLimiter(1000, 60_000),
  });
  return { server, grounnelStore };
}

function webSource(claimText: string, overrides: Partial<SearchPassage> = {}): SearchPassage {
  return {
    url: "https://example.com/a",
    title: "Example",
    domain: "example.com",
    status: "ok",
    text: (claimText + " ").repeat(20),
    ...overrides,
  };
}

// Mirrors a real client: /extract returns before the pipeline finishes, so /status is polled.
async function pollUntilSettled(server: FastifyInstance, id: string, maxAttempts = 100): Promise<Record<string, any>> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await server.inject({ method: "GET", url: `/status/${id}`, headers: { authorization: VALID_AUTH } });
    const body = JSON.parse(res.body);
    if (body.status === "done") return body;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`status for ${id} never reached "done" after ${maxAttempts} polls`);
}

describe("GET /status/:id (T015)", () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider();
  });

  it("returns 401 when the Authorization header is missing", async () => {
    const { server } = buildServer(provider, { search: async () => [] });
    const res = await server.inject({ method: "GET", url: "/status/11111111-1111-4111-8111-111111111111" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 for a malformed id", async () => {
    const { server } = buildServer(provider, { search: async () => [] });
    const res = await server.inject({ method: "GET", url: "/status/not-a-uuid", headers: { authorization: VALID_AUTH } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid id" });
  });

  it("returns 404 when no audit exists for that id", async () => {
    const { server } = buildServer(provider, { search: async () => [] });
    const res = await server.inject({
      method: "GET",
      url: "/status/11111111-1111-4111-8111-111111111111",
      headers: { authorization: VALID_AUTH },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "not_found" });
  });

  it("returns the full StatusResponse shape, no delta logic, once a real run settles", async () => {
    provider.setDefault({ claims: [{ claim: "The Eiffel Tower was completed in 1889." }], truncated: false });
    provider.setResponseFn("You are a verification engine", (request) => {
      const match = request.system.match(/CLAIM_PASSAGE_PAIRS: (\[.*\])/s)!;
      const ids = (JSON.parse(match[1]) as Array<{ id: string }>).map((p) => p.id);
      return { results: ids.map((id) => ({ id, verdict: "supported", evidence: "Eiffel Tower completed 1889", reason: "matches", confidence: 0.9 })) };
    });
    const search: SearchProvider = { search: async (query) => [webSource(query)] };
    const { server } = buildServer(provider, search);

    const extractRes = await server.inject({
      method: "POST",
      url: "/extract",
      headers: { authorization: VALID_AUTH },
      payload: { text: "The Eiffel Tower was completed in 1889." },
    });
    const { id } = JSON.parse(extractRes.body);

    const body = await pollUntilSettled(server, id);
    expect(body).toMatchObject({
      id,
      status: "done",
      progress: { checked: 1, total: 1 },
      caps_hit: false,
    });
    expect(body.claims).toHaveLength(1);
    expect(body.claims[0]).toMatchObject({ verdict: "supported", status: "done" });
    expect(body.score).toMatchObject({ grounded_n: 1, eligible: 1, not_checked_n: 0 });
  });

  it("counts a forced VERIFY batch failure as not_checked (status: failed), not silently dropped from the denominator", async () => {
    provider.setDefault({ claims: [{ claim: "The Eiffel Tower was completed in 1889." }], truncated: false });
    // A custom Provider (not MockProvider.failAll) so EXTRACT still succeeds and only the
    // verification-engine call fails — matches how a real VERIFY-only outage would present.
    const failingOnVerify: Provider = {
      mode: "mock",
      completeJson: async (request) => {
        if (request.system.includes("You are a claim-extraction engine")) {
          return { result: { claims: [{ claim: "The Eiffel Tower was completed in 1889." }], truncated: false } as any };
        }
        throw new Error("VERIFY provider is down");
      },
    };
    const search: SearchProvider = { search: async (query) => [webSource(query)] };
    const { server } = buildServer(failingOnVerify, search);

    const extractRes = await server.inject({
      method: "POST",
      url: "/extract",
      headers: { authorization: VALID_AUTH },
      payload: { text: "The Eiffel Tower was completed in 1889." },
    });
    const { id } = JSON.parse(extractRes.body);

    const body = await pollUntilSettled(server, id);
    expect(body.claims[0]).toMatchObject({ status: "failed", verdict: null });
    expect(body.score).toMatchObject({ not_checked_n: 1, eligible: 1, grounded_n: 0 });
  });

  it("surfaces caps_hit: true when the audit was truncated at creation", async () => {
    const { server, grounnelStore } = buildServer(provider, { search: async () => [] });
    const { id } = await grounnelStore.createAudit({
      text: "article",
      maxClaims: 2,
      claims: [
        { id: "11111111-1111-4111-8111-111111111111", text: "Claim one." },
        { id: "22222222-2222-4222-8222-222222222222", text: "Claim two." },
      ],
      truncated: true,
    });

    const res = await server.inject({ method: "GET", url: `/status/${id}`, headers: { authorization: VALID_AUTH } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).caps_hit).toBe(true);
  });
});
