import { describe, it, expect, beforeEach } from "vitest";
import { GrounnelPipelineService, buildGeminiRateLimitMessage } from "../../../../src/orchestrators/grounnel/pipeline.service.js";
import { RedisGrounnelStore } from "../../../../src/persistence/grounnel-store.js";
import { PromptRegistry } from "../../../../src/prompts/registry.js";
import { RateLimitError } from "../../../../src/providers/gemini.js";
import { MockProvider } from "../../../mocks/mock-provider.js";
import { FakeRedisHashClient } from "../../../mocks/fake-redis-hash-client.js";
import type { SearchProvider, SearchPassage } from "../../../../src/providers/search/search-provider.js";
import type { CompletionRequest, Provider } from "../../../../src/providers/types.js";

class FakeSearchProvider implements SearchProvider {
  constructor(private responses: Map<string, SearchPassage[]>) {}
  async search(query: string): Promise<SearchPassage[]> {
    return this.responses.get(query) ?? [];
  }
}

function webSource(overrides: Partial<SearchPassage> = {}): SearchPassage {
  return { url: "https://example.com/a", title: "Example", domain: "example.com", status: "ok", text: "long enough text ".repeat(10), ...overrides };
}

// Zod's uuid() format is version/variant-strict — "c1" fails it. Deterministic valid UUIDs instead.
function uuid(n: number): string {
  return `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

// Pulls the claim ids out of the rendered VERIFY prompt's embedded CLAIM_PASSAGE_PAIRS JSON,
// so mock responses can answer whatever batch actually got sent without hardcoding call order.
function idsFromRequest(request: CompletionRequest): string[] {
  const match = request.system.match(/CLAIM_PASSAGE_PAIRS: (\[.*\])/s);
  if (!match) return [];
  const pairs = JSON.parse(match[1]!) as Array<{ id: string }>;
  return pairs.map((p) => p.id);
}

describe("GrounnelPipelineService (T010)", () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider();
  });

  it("writes 'unsupported: no evidence found' directly, without any VERIFY call, when no source resolves to usable text", async () => {
    const claimId = uuid(1);
    const claimText = "Some obscure claim.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const search = new FakeSearchProvider(new Map([[claimText, [webSource({ status: "unreachable", text: null })]]]));
    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store);

    await service.run(auditId, [{ id: claimId, text: claimText }]);

    const status = await store.getStatus(auditId);
    const claim = status!.claims.find((c) => c.id === claimId)!;
    expect(claim.status).toBe("done");
    expect(claim.verdict).toBe("unsupported");
    expect(claim.reason).toBe("No relevant source found for this claim.");
    expect(claim.sources[0]).toMatchObject({ status: "unreachable" });
    expect(provider.getCallCount()).toBe(0);
  });

  it("writes 'unsupported: no evidence found' when the only passage is dropped by gate #4's relevance filter, with zero VERIFY calls", async () => {
    const claimId = uuid(1);
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({
      text: "article",
      maxClaims: 100,
      claims: [{ id: claimId, text: "The Eiffel Tower was completed in 1889." }],
      truncated: false,
    });
    const search = new FakeSearchProvider(
      new Map([["The Eiffel Tower was completed in 1889.", [webSource({ text: "The Great Wall of China spans thousands of miles. ".repeat(20) })]]])
    );
    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store);

    await service.run(auditId, [{ id: claimId, text: "The Eiffel Tower was completed in 1889." }]);

    const status = await store.getStatus(auditId);
    const claim = status!.claims.find((c) => c.id === claimId)!;
    expect(claim.status).toBe("done");
    expect(claim.verdict).toBe("unsupported");
    expect(claim.reason).toBe("No relevant source found for this claim.");
    expect(provider.getCallCount()).toBe(0);
  });

  it("runs VERIFY and writes the resulting verdict when a relevant passage is found", async () => {
    const claimId = uuid(1);
    const claimText = "Bukowski attended Los Angeles City College.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const passageText = "Bukowski attended Los Angeles City College for two years, per Wikipedia. ".repeat(5);
    const search = new FakeSearchProvider(new Map([[claimText, [webSource({ url: "https://en.wikipedia.org/wiki/Bukowski", text: passageText })]]]));

    provider.setResponseFn("You are a verification engine", (request) => {
      const ids = idsFromRequest(request);
      return { results: ids.map((id) => ({ id, verdict: "supported", evidence: "Bukowski attended Los Angeles City College", reason: "Wikipedia confirms it.", confidence: 0.95 })) };
    });

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store);
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    const status = await store.getStatus(auditId);
    const claim = status!.claims.find((c) => c.id === claimId)!;
    expect(claim.status).toBe("done");
    expect(claim.verdict).toBe("supported");
    expect(claim.confidence).toBe(0.95);
    expect(claim.sources[0]).toMatchObject({ url: "https://en.wikipedia.org/wiki/Bukowski" });
  });

  it("gate #1 downgrades a contradicted verdict whose evidence isn't a real substring of the passage", async () => {
    const claimId = uuid(1);
    const claimText = "Bukowski attended Harvard.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const passageText = "Bukowski attended Los Angeles City College for two years. ".repeat(5);
    const search = new FakeSearchProvider(new Map([[claimText, [webSource({ text: passageText })]]]));

    provider.setResponseFn("You are a verification engine", (request) => {
      const ids = idsFromRequest(request);
      // Evidence is fabricated — not present in the actual passage sent.
      return { results: ids.map((id) => ({ id, verdict: "contradicted", evidence: "attended Harvard University", reason: "fabricated", confidence: 0.9 })) };
    });

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store);
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    const status = await store.getStatus(auditId);
    const claim = status!.claims.find((c) => c.id === claimId)!;
    expect(claim.verdict).toBe("unsupported"); // downgraded by gate #1, never reaches the store as contradicted
    expect(claim.evidence).toBeNull();
  });

  it("reason-consistency gate forces contradicted when VERIFY's own reason says so but verdict didn't (real live-eval finding, g04)", async () => {
    const claimId = uuid(1);
    const claimText = "World War II ended in 1943.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const passageText = "World War II began in 1939 and ended in 1945 with the surrender of Germany and Japan. ".repeat(5);
    const search = new FakeSearchProvider(new Map([[claimText, [webSource({ text: passageText })]]]));

    provider.setResponseFn("You are a verification engine", (request) => {
      const ids = idsFromRequest(request);
      return {
        results: ids.map((id) => ({
          id,
          verdict: "unsupported",
          evidence: "ended in 1945",
          reason: "The passage states that World War II ended in 1945, directly contradicting the claim that it ended in 1943.",
          confidence: 0.9,
        })),
      };
    });

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store);
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    const status = await store.getStatus(auditId);
    const claim = status!.claims.find((c) => c.id === claimId)!;
    expect(claim.verdict).toBe("contradicted"); // gate #1 still validates the evidence is a real substring
  });

  it("Case A gate forces contradicted on a bare 'X, not Y' negation applyReasonConsistencyGate misses (real live-eval finding, g05)", async () => {
    const claimId = uuid(1);
    const claimText = "The Statue of Liberty was a gift from Canada to the United States, unveiled in 1886.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const passageText =
      "The Statue of Liberty was a gift from France to the United States, dedicated in 1886 to celebrate the friendship between the two nations. ".repeat(
        3
      );
    const search = new FakeSearchProvider(new Map([[claimText, [webSource({ text: passageText })]]]));

    provider.setResponseFn("You are a verification engine", (request) => {
      const ids = idsFromRequest(request);
      return {
        results: ids.map((id) => ({
          id,
          verdict: "unsupported",
          evidence: "a gift from France to the United States",
          reason: "The passage states the statue was a gift from France, not Canada.",
          confidence: 0.9,
        })),
      };
    });

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store);
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    const status = await store.getStatus(auditId);
    const claim = status!.claims.find((c) => c.id === claimId)!;
    expect(claim.verdict).toBe("contradicted");
  });

  it("gate #2 overrides the verdict when the numbers genuinely disagree beyond tolerance", async () => {
    const claimId = uuid(1);
    const claimText = "UC Riverside received a $1.2 million grant.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const passageText = "The NEH awarded UC Riverside a $350,000 grant to expand the project. ".repeat(5);
    const search = new FakeSearchProvider(new Map([[claimText, [webSource({ text: passageText })]]]));

    provider.setResponseFn("You are a verification engine", (request) => {
      const ids = idsFromRequest(request);
      return { results: ids.map((id) => ({ id, verdict: "supported", evidence: "$350,000 grant", reason: "matches", confidence: 0.9 })) };
    });

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store);
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    const status = await store.getStatus(auditId);
    const claim = status!.claims.find((c) => c.id === claimId)!;
    expect(claim.verdict).toBe("contradicted"); // overridden by gate #2 — $1.2M vs $350K disagree beyond tolerance
  });

  it("forces a low-confidence verdict to unverifiable", async () => {
    const claimId = uuid(1);
    const claimText = "Some claim with weak evidence.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const search = new FakeSearchProvider(new Map([[claimText, [webSource({ text: (claimText + " ").repeat(20) })]]]));

    provider.setResponseFn("You are a verification engine", (request) => {
      const ids = idsFromRequest(request);
      return { results: ids.map((id) => ({ id, verdict: "supported", evidence: claimText, reason: "weak match", confidence: 0.3 })) };
    });

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store);
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    const status = await store.getStatus(auditId);
    expect(status!.claims.find((c) => c.id === claimId)!.verdict).toBe("unverifiable");
  });

  it("degrades a batch to not_checked (status: failed) when VERIFY fails after retries, and the run continues", async () => {
    const claimId = uuid(1);
    const claimText = "A claim whose VERIFY call will fail.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const search = new FakeSearchProvider(new Map([[claimText, [webSource({ text: (claimText + " ").repeat(20) })]]]));
    provider.failAll("VERIFY provider is down");

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store);
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    const status = await store.getStatus(auditId);
    const claim = status!.claims.find((c) => c.id === claimId)!;
    expect(claim.status).toBe("failed");
    expect(claim.verdict).toBeNull();
    expect(status!.score.not_checked_n).toBe(1);
  });

  it("degrades a batch to not_checked instead of crashing when VERIFY's response is missing the results field entirely", async () => {
    // repair.ts's partialParseObject nulls out a field it can't validate (D018 §5.15) rather than
    // throwing — a real run hit this for VERIFY's `results` field and crashed .map() on null,
    // uncaught, instead of degrading cleanly like every other VERIFY failure path.
    const claimId = uuid(1);
    const claimText = "A claim whose VERIFY response omits results.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const search = new FakeSearchProvider(new Map([[claimText, [webSource({ text: (claimText + " ").repeat(20) })]]]));
    provider.setDefault({}); // valid JSON, but no `results` key — repair.ts nulls the field, doesn't throw

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store);
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    const status = await store.getStatus(auditId);
    const claim = status!.claims.find((c) => c.id === claimId)!;
    expect(claim.status).toBe("failed");
    expect(claim.verdict).toBeNull();
    expect(status!.score.not_checked_n).toBe(1);
  });

  it("degrades only the claims VERIFY's response omitted, not the whole batch", async () => {
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const claims = [
      { id: uuid(1), text: "First claim about Wikipedia." },
      { id: uuid(2), text: "Second claim about Wikipedia." },
    ];
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims, truncated: false });
    const search = new FakeSearchProvider(
      new Map([
        ["First claim about Wikipedia.", [webSource({ url: "https://a.example", text: "First claim about Wikipedia. ".repeat(20) })]],
        ["Second claim about Wikipedia.", [webSource({ url: "https://b.example", text: "Second claim about Wikipedia. ".repeat(20) })]],
      ])
    );

    provider.setResponseFn("You are a verification engine", () => ({
      // Only answers c1, silently omits c2.
      results: [{ id: uuid(1), verdict: "supported", evidence: "First claim about Wikipedia.", reason: "ok", confidence: 0.9 }],
    }));

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store);
    await service.run(auditId, claims);

    const status = await store.getStatus(auditId);
    expect(status!.claims.find((c) => c.id === uuid(1))!.status).toBe("done");
    expect(status!.claims.find((c) => c.id === uuid(2))!.status).toBe("failed");
  });

  it("splits more than 8 claims into multiple VERIFY batches", async () => {
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const claims = Array.from({ length: 10 }, (_, i) => ({ id: uuid(i), text: `Claim number ${i} about something.` }));
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims, truncated: false });
    const responses = new Map(claims.map((c) => [c.text, [webSource({ url: `https://example.com/${c.id}`, text: (c.text + " ").repeat(20) })]]));
    const search = new FakeSearchProvider(responses);

    let batchCount = 0;
    const batchSizes: number[] = [];
    provider.setResponseFn("You are a verification engine", (request) => {
      batchCount++;
      const ids = idsFromRequest(request);
      batchSizes.push(ids.length);
      return { results: ids.map((id) => ({ id, verdict: "supported", evidence: "long enough text", reason: "ok", confidence: 0.9 })) };
    });

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store);
    await service.run(auditId, claims);

    expect(batchCount).toBe(2); // 10 claims / BATCH_MAX 8 -> two batches
    expect(batchSizes).toEqual([8, 2]);
    const status = await store.getStatus(auditId);
    expect(status!.claims.every((c) => c.status === "done")).toBe(true);
  });

  it("writes a distinct 'try again later' reason when the only source hit Tavily's rate limit, not the generic no-evidence message", async () => {
    const claimId = uuid(1);
    const claimText = "A claim whose search fallback got rate limited.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const search = new FakeSearchProvider(
      new Map([[claimText, [{ url: "https://tavily.com", title: "Tavily", domain: "tavily.com", status: "rate_limited", text: null }]]])
    );
    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store);

    await service.run(auditId, [{ id: claimId, text: claimText }]);

    const status = await store.getStatus(auditId);
    const claim = status!.claims.find((c) => c.id === claimId)!;
    expect(claim.verdict).toBe("unsupported");
    expect(claim.reason).toBe(
      "This claim could not be checked right now — our search provider's rate limit was reached. Try again later."
    );
    expect(provider.getCallCount()).toBe(0);
  });

  it("stops attempting further VERIFY batches when Gemini itself is rate-limited, degrading all remaining claims with a clear retry message", async () => {
    const claims = Array.from({ length: 16 }, (_, i) => ({ id: uuid(i), text: `Claim number ${i} about something.` }));
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims, truncated: false });
    const responses = new Map(claims.map((c) => [c.text, [webSource({ url: `https://example.com/${c.id}`, text: (c.text + " ").repeat(20) })]]));
    const search = new FakeSearchProvider(responses);

    let calls = 0;
    const rateLimitedProvider: Provider = {
      mode: "mock",
      completeJson: async () => {
        calls++;
        throw new RateLimitError("daily quota exceeded", "daily", "2026-08-07T00:00:00Z");
      },
    };

    const service = new GrounnelPipelineService(search, rateLimitedProvider, new PromptRegistry(), store);
    await service.run(auditId, claims);

    // 16 claims / BATCH_MAX 8 = 2 batches — only the first should ever be attempted.
    expect(calls).toBe(1);
    const status = await store.getStatus(auditId);
    expect(status!.claims.every((c) => c.status === "failed")).toBe(true);
    expect(status!.claims.every((c) => c.reason === "We've hit today's AI usage limit. Please try again after 2026-08-07T00:00:00Z.")).toBe(true);
  });

  it("stops calling SearchProvider once Tavily rate-limits, instead of hitting it for every remaining claim", async () => {
    const claims = Array.from({ length: 25 }, (_, i) => ({ id: uuid(i), text: `Claim number ${i} happened.` }));
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims, truncated: false });

    const searchedTexts = new Set<string>();
    const search: SearchProvider = {
      async search(query: string): Promise<SearchPassage[]> {
        searchedTexts.add(query);
        if (query === claims[5]!.text) {
          return [{ url: "https://tavily.com", title: "Tavily", domain: "tavily.com", status: "rate_limited", text: null }];
        }
        return [webSource({ status: "unreachable", text: null })];
      },
    };

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store);
    await service.run(auditId, claims);

    // SEARCH_CONCURRENCY (20) — the wave containing the rate-limited claim (index 5, wave 1)
    // completes in full, but the next wave (claims 20-24) should never call search() at all.
    for (let i = 0; i < 20; i++) expect(searchedTexts.has(claims[i]!.text)).toBe(true);
    for (let i = 20; i < 25; i++) expect(searchedTexts.has(claims[i]!.text)).toBe(false);

    const status = await store.getStatus(auditId);
    for (let i = 20; i < 25; i++) {
      const claim = status!.claims.find((c) => c.id === claims[i]!.id)!;
      expect(claim.reason).toContain("rate limit was reached");
    }
  });

  it("buildGeminiRateLimitMessage gives a different message for daily vs per-minute limits", () => {
    expect(buildGeminiRateLimitMessage(new RateLimitError("x", "daily", "2026-08-07T00:00:00Z"))).toContain("try again after 2026-08-07T00:00:00Z");
    expect(buildGeminiRateLimitMessage(new RateLimitError("x", "daily"))).toContain("try again tomorrow");
    expect(buildGeminiRateLimitMessage(new RateLimitError("x", "per-minute"))).toContain("a few minutes");
  });
});
