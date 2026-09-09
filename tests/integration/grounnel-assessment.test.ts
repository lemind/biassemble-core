import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerGrounnelRoutes } from "../../src/routes/grounnel.js";
import { GrounnelExtractService } from "../../src/orchestrators/grounnel/extract.service.js";
import { GrounnelPipelineService } from "../../src/orchestrators/grounnel/pipeline.service.js";
import { RedisGrounnelStore } from "../../src/persistence/grounnel-store.js";
import { InMemoryRateLimiter } from "../../src/lib/rate-limit.js";
import { PromptRegistry } from "../../src/prompts/registry.js";
import { MockProvider } from "../mocks/mock-provider.js";
import { FakeRedisHashClient } from "../mocks/fake-redis-hash-client.js";
import { NoopGrounnelHistoryStore } from "../mocks/noop-grounnel-history-store.js";
import { NoopGrounnelLlmCallStore } from "../mocks/noop-grounnel-llm-call-store.js";
import { NoopGrounnelGateEventStore } from "../mocks/noop-grounnel-gate-event-store.js";
import { generateShareToken, isShareTokenShape } from "../../src/lib/share-token.js";
import type { SharedAssessment } from "../../src/contracts/grounnel.schemas.js";
import type { SearchProvider } from "../../src/providers/search/search-provider.js";

const TOKEN = "kPq3n_R7sT9vW2xY4zA6bC8dE0fG1hIj";
const RUN_ID = "0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d";

const ASSESSMENT: SharedAssessment = {
  status: "done",
  text: "The Eiffel Tower was originally constructed in London.",
  createdAt: "2026-09-07T17:25:48.000Z",
  completedAt: "2026-09-07T17:29:11.000Z",
  claims: [
    {
      text: "The Eiffel Tower was originally constructed in London.",
      verdict: "contradicted",
      evidence: "The Eiffel Tower is a lattice tower on the Champ de Mars in Paris.",
      confidence: 1,
      reason: "The sources place its construction in Paris.",
      sources: [
        { kind: "web", title: "Eiffel Tower", domain: "en.wikipedia.org", url: "https://en.wikipedia.org/wiki/Eiffel_Tower", status: "ok" },
      ],
      sourceExcerpt: "The Eiffel Tower was originally constructed in London.",
    },
  ],
};

function buildServer(assessments = new Map([[TOKEN, ASSESSMENT]])) {
  const server = Fastify();
  const grounnelStore = new RedisGrounnelStore(new FakeRedisHashClient());
  const prompts = new PromptRegistry();
  const provider = new MockProvider();
  const searchProvider = { search: async () => [] } as unknown as SearchProvider;
  const historyStore = new NoopGrounnelHistoryStore(assessments);
  registerGrounnelRoutes(server, {
    extractService: new GrounnelExtractService(provider, prompts, grounnelStore, historyStore, new NoopGrounnelLlmCallStore()),
    pipelineService: new GrounnelPipelineService(searchProvider, provider, prompts, grounnelStore, historyStore, new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore()),
    grounnelStore,
    historyStore,
    rateLimiter: new InMemoryRateLimiter(1000, 60_000),
  });
  return server;
}

describe("GET /assessment/:token (spec 019)", () => {
  it("returns the assessment with no credential — this is the one public route (FR-004)", async () => {
    const res = await buildServer().inject({ method: "GET", url: `/assessment/${TOKEN}` });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("done");
    expect(body.claims).toHaveLength(1);
    expect(body.claims[0].verdict).toBe("contradicted");
  });

  it("never exposes internal identifiers (FR-009)", async () => {
    const res = await buildServer().inject({ method: "GET", url: `/assessment/${TOKEN}` });
    expect(res.body).not.toContain(RUN_ID);
    const body = JSON.parse(res.body);
    expect(body).not.toHaveProperty("runId");
    expect(body).not.toHaveProperty("sessionId");
    expect(body.claims[0]).not.toHaveProperty("id");
  });

  // FR-003 — knowledge of a run's internal id must not grant access to its assessment.
  it("refuses a run_id supplied in the token position", async () => {
    const res = await buildServer(new Map([[RUN_ID, ASSESSMENT]])).inject({
      method: "GET",
      url: `/assessment/${RUN_ID}`,
    });
    expect(res.statusCode).toBe(404);
  });

  // FR-010 — an unknown token and a deleted run must be indistinguishable, or the endpoint
  // becomes an oracle for whether a run exists.
  it("answers an unknown token exactly as it answers a malformed one", async () => {
    const server = buildServer();
    const unknown = await server.inject({ method: "GET", url: `/assessment/${generateShareToken()}` });
    const malformed = await server.inject({ method: "GET", url: "/assessment/not.a.token" });
    expect(unknown.statusCode).toBe(404);
    expect(malformed.statusCode).toBe(404);
    expect(unknown.body).toBe(malformed.body);
  });

  it("marks the response noindex (FR-009, T009)", async () => {
    const res = await buildServer().inject({ method: "GET", url: `/assessment/${TOKEN}` });
    expect(res.headers["x-robots-tag"]).toBe("noindex");
  });

  // FR-011 — an unfinished run renders what exists and states its status, rather than looking done.
  it("returns an in-flight run with its real status, not a finished-looking empty one", async () => {
    const inFlight: SharedAssessment = { ...ASSESSMENT, status: "verifying", completedAt: null, claims: [] };
    const res = await buildServer(new Map([[TOKEN, inFlight]])).inject({ method: "GET", url: `/assessment/${TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("verifying");
  });
});

describe("generateShareToken (T003)", () => {
  it("is URL-safe, long enough to be unguessable, and never repeats", () => {
    const tokens = new Set(Array.from({ length: 500 }, generateShareToken));
    expect(tokens.size).toBe(500);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  // FR-003 — a run_id must be rejected on shape, not merely by being absent from the table.
  it("accepts its own output and every backfilled token, and rejects a run id", () => {
    expect(isShareTokenShape(generateShareToken())).toBe(true);
    expect(isShareTokenShape(`legacy_${"a1b2c3d4".repeat(4)}`)).toBe(true);
    expect(isShareTokenShape(RUN_ID)).toBe(false);
    expect(isShareTokenShape("short")).toBe(false);
    expect(isShareTokenShape("not.a.token")).toBe(false);
  });
});
