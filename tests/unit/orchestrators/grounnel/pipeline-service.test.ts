import { describe, it, expect, beforeEach } from "vitest";
import { GrounnelPipelineService, buildGeminiRateLimitMessage } from "../../../../src/orchestrators/grounnel/pipeline.service.js";
import { RedisGrounnelStore } from "../../../../src/persistence/grounnel-store.js";
import { PromptRegistry } from "../../../../src/prompts/registry.js";
import { RateLimitError } from "../../../../src/providers/gemini.js";
import { MockProvider } from "../../../mocks/mock-provider.js";
import { FakeRedisHashClient } from "../../../mocks/fake-redis-hash-client.js";
import { NoopGrounnelHistoryStore } from "../../../mocks/noop-grounnel-history-store.js";
import { FakeGrounnelHistoryStore } from "../../../mocks/fake-grounnel-history-store.js";
import { NoopGrounnelLlmCallStore } from "../../../mocks/noop-grounnel-llm-call-store.js";
import { FakeGrounnelLlmCallStore } from "../../../mocks/fake-grounnel-llm-call-store.js";
import { NoopGrounnelGateEventStore } from "../../../mocks/noop-grounnel-gate-event-store.js";
import { FakeGrounnelGateEventStore } from "../../../mocks/fake-grounnel-gate-event-store.js";
import type { SearchProvider, SearchPassage } from "../../../../src/providers/search/search-provider.js";
import type { CompletionRequest, Provider } from "../../../../src/providers/types.js";
import { buildPassageSentences } from "../../../../src/orchestrators/grounnel/passage-sentences.js";

// D026 §7/§11 (T043/T049) — VERIFY now cites {source, n} pairs, not free text. Finds the
// citation(s) whose real, code-extracted text equals `expectedEvidence` (a single sentence, or
// several joined by " ... "), so tests can keep expressing intent as "the resolved evidence
// should read X" instead of hand-counting buildPassageSentences' internal numbering. Single-source
// test fixtures always cite source "A" (the only pooled passage in these single-passage cases).
function citationsFor(claimText: string, passageText: string, expectedEvidence: string): Array<{ source: string; n: number }> {
  const sentences = buildPassageSentences(claimText, passageText);
  return expectedEvidence.split(" ... ").map((part) => {
    const match = sentences.find((s) => s.text === part);
    if (!match) {
      throw new Error(`citationsFor: no sentence exactly matches "${part}". Available: ${JSON.stringify(sentences.map((s) => s.text))}`);
    }
    return { source: "A", n: match.n };
  });
}

class FakeSearchProvider implements SearchProvider {
  calls: Array<{ query: string; context?: { runId: string; claimId: string } }> = [];
  constructor(private responses: Map<string, SearchPassage[]>) {}
  async search(query: string, context?: { runId: string; claimId: string }): Promise<SearchPassage[]> {
    this.calls.push({ query, context });
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

// D025/T035 — same idea as idsFromRequest, for the batched consistency-check classifier's own marker.
function idsFromConsistencyRequest(request: CompletionRequest): string[] {
  const match = request.system.match(/REASON_VERDICT_PAIRS: (\[.*\])/s);
  if (!match) return [];
  const pairs = JSON.parse(match[1]!) as Array<{ id: string }>;
  return pairs.map((p) => p.id);
}

describe("GrounnelPipelineService (T010)", () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider();
    // D025/T035 — default "everything is consistent" so existing tests (none of which are about
    // this new classifier) don't have to configure it themselves or hit a retry-storm from an
    // unconfigured mock response. Tests that specifically exercise gate #5 override this.
    provider.setResponseFn("You are a consistency auditor", (request) => {
      const ids = idsFromConsistencyRequest(request);
      return { results: ids.map((id) => ({ id, consistent: true })) };
    });
  });

  it("writes 'unsupported: no evidence found' directly, without any VERIFY call, when no source resolves to usable text", async () => {
    const claimId = uuid(1);
    const claimText = "Some obscure claim.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const search = new FakeSearchProvider(new Map([[claimText, [webSource({ status: "unreachable", text: null })]]]));
    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());

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
    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());

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
      return { results: ids.map((id) => ({ id, verdict: "supported", evidenceCitations: citationsFor(claimText, passageText, "Bukowski attended Los Angeles City College for two years, per Wikipedia."), reason: "Wikipedia confirms it.", confidence: 0.95 })) };
    });

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    const status = await store.getStatus(auditId);
    const claim = status!.claims.find((c) => c.id === claimId)!;
    expect(claim.status).toBe("done");
    expect(claim.verdict).toBe("supported");
    expect(claim.confidence).toBe(0.95);
    expect(claim.sources[0]).toMatchObject({ url: "https://en.wikipedia.org/wiki/Bukowski" });
  });

  it("T040 (D026 §6): never sends the passage's source_url to VERIFY — no page-identity memory cue", async () => {
    const claimId = uuid(1);
    const claimText = "Bukowski attended Los Angeles City College.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const passageText = "Bukowski attended Los Angeles City College for two years, per Wikipedia. ".repeat(5);
    const search = new FakeSearchProvider(new Map([[claimText, [webSource({ url: "https://en.wikipedia.org/wiki/Bukowski", text: passageText })]]]));

    let capturedSystem = "";
    provider.setResponseFn("You are a verification engine", (request) => {
      capturedSystem = request.system;
      const ids = idsFromRequest(request);
      return { results: ids.map((id) => ({ id, verdict: "supported", evidenceCitations: citationsFor(claimText, passageText, "Bukowski attended Los Angeles City College for two years, per Wikipedia."), reason: "Confirmed.", confidence: 0.95 })) };
    });

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    expect(capturedSystem).not.toContain("en.wikipedia.org");
    expect(capturedSystem).not.toContain("source_url");
  });

  it("T041 (D026 §6): tries the next already-fetched 'ok' source when the first fails gate #4's relevance filter, instead of giving up", async () => {
    const claimId = uuid(1);
    const claimText = "The Eiffel Tower was completed in 1889.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const irrelevantSource = webSource({ url: "https://irrelevant.example", text: "The Great Wall of China spans thousands of miles. ".repeat(20) });
    const relevantSource = webSource({
      url: "https://relevant.example",
      text: "The Eiffel Tower in Paris was completed in 1889 as an iron lattice structure. ".repeat(5),
    });
    const search = new FakeSearchProvider(new Map([[claimText, [irrelevantSource, relevantSource]]]));

    provider.setResponseFn("You are a verification engine", (request) => {
      const ids = idsFromRequest(request);
      return {
        results: ids.map((id) => ({
          id,
          verdict: "supported",
          evidenceCitations: citationsFor(claimText, relevantSource.text!, "The Eiffel Tower in Paris was completed in 1889 as an iron lattice structure."),
          reason: "Matches.",
          confidence: 0.9,
        })),
      };
    });

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    const status = await store.getStatus(auditId);
    const claim = status!.claims.find((c) => c.id === claimId)!;
    expect(claim.verdict).toBe("supported");
    expect(claim.reason).not.toBe("No relevant source found for this claim.");
    expect(claim.sources.map((s) => s.url)).toEqual(["https://irrelevant.example", "https://relevant.example"]);
  });

  it("D026 §11 (T049): pools MULTIPLE relevant passages into one VERIFY call and can resolve a citation combining sentences from different sources — not just the single best-ranked one", async () => {
    const claimId = uuid(1);
    const claimText = "Apple's market capitalization surpassed $3.5 trillion in 2024.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    // Neither page alone states the full fact as clearly as combining them: A gives the year/company
    // context, B gives the specific figure. Both independently pass gate #4 (each contains a real
    // claim key-term), so resolveEvidence should pool BOTH, not just the higher-ranked one.
    const sourceA = webSource({
      url: "https://a.example",
      text: "The company had a landmark year in 2024 across every major product line, according to analysts. ".repeat(5),
    });
    const sourceB = webSource({
      url: "https://b.example",
      text: "Apple's valuation reached $3.8 trillion during the year, according to regulatory filings. ".repeat(5),
    });
    const search = new FakeSearchProvider(new Map([[claimText, [sourceA, sourceB]]]));

    let capturedSystem = "";
    provider.setResponseFn("You are a verification engine", (request) => {
      capturedSystem = request.system;
      const ids = idsFromRequest(request);
      return {
        results: ids.map((id) => ({
          id,
          verdict: "supported",
          evidenceCitations: [
            ...citationsFor(claimText, sourceA.text!, "The company had a landmark year in 2024 across every major product line, according to analysts."),
            { source: "B", n: citationsFor(claimText, sourceB.text!, "Apple's valuation reached $3.8 trillion during the year, according to regulatory filings.")[0]!.n },
          ],
          reason: "Source A confirms 2024; source B confirms the $3.8T figure, which surpasses $3.5T.",
          confidence: 0.95,
        })),
      };
    });

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    // Both sources' sentences were actually sent, grouped by label — proves pooling, not just ranking.
    const sentPayload = JSON.parse(capturedSystem.match(/CLAIM_PASSAGE_PAIRS: (\[.*\])/s)![1]!);
    expect(Object.keys(sentPayload[0].passage_sentences).sort()).toEqual(["A", "B"]);

    const status = await store.getStatus(auditId);
    const claim = status!.claims.find((c) => c.id === claimId)!;
    expect(claim.verdict).toBe("supported");
    expect(claim.evidence).toBe(
      "The company had a landmark year in 2024 across every major product line, according to analysts. ... Apple's valuation reached $3.8 trillion during the year, according to regulatory filings."
    );
  });

  it("gate #1 downgrades a contradicted verdict citing a sentence number that doesn't exist (D026 §7: the model can no longer fabricate quote TEXT, so this is the new equivalent of the old free-text fabrication case)", async () => {
    const claimId = uuid(1);
    const claimText = "Bukowski attended Harvard.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const passageText = "Bukowski attended Los Angeles City College for two years. ".repeat(5);
    const search = new FakeSearchProvider(new Map([[claimText, [webSource({ text: passageText })]]]));

    provider.setResponseFn("You are a verification engine", (request) => {
      const ids = idsFromRequest(request);
      // Cites a sentence number well outside the numbered list actually given for this pair —
      // resolveEvidenceFromSentenceIds nulls the whole answer, same "ungrounded" outcome gate #1 used
      // to catch from typed fabrication, now catching a malformed/invalid index instead.
      return { results: ids.map((id) => ({ id, verdict: "contradicted", evidenceCitations: [{ source: "A", n: 999 }], reason: "fabricated", confidence: 0.9 })) };
    });

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());
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
          evidenceCitations: citationsFor(claimText, passageText, "World War II began in 1939 and ended in 1945 with the surrender of Germany and Japan."),
          reason: "The passage states that World War II ended in 1945, directly contradicting the claim that it ended in 1943.",
          confidence: 0.9,
        })),
      };
    });

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    const status = await store.getStatus(auditId);
    const claim = status!.claims.find((c) => c.id === claimId)!;
    expect(claim.verdict).toBe("contradicted"); // gate #1 still validates the evidence is a real substring
  });

  it("T034: retries VERIFY once when reason_consistency flips a verdict but gate #1 finds no real evidence backing it (real live-eval finding, g04, 2026-08-07)", async () => {
    const claimId = uuid(1);
    const claimText = "World War II ended in 1943.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const passageText = "World War II began in 1939 and ended in 1945 with the surrender of Germany and Japan. ".repeat(5);
    const search = new FakeSearchProvider(new Map([[claimText, [webSource({ text: passageText })]]]));

    provider.setResponseFn("You are a verification engine", (request) => {
      const ids = idsFromRequest(request);
      // First call (the real batch): self-inconsistent — reason narrates a contradiction, but
      // verdict/evidence don't reflect it (the exact real g04 shape). Second call (T034's retry):
      // the model gets it right this time, with real evidence.
      const selfInconsistent = provider.getCallCount() === 1;
      return {
        results: ids.map((id) => ({
          id,
          verdict: selfInconsistent ? "unsupported" : "contradicted",
          evidenceCitations: selfInconsistent ? null : citationsFor(claimText, passageText, "World War II began in 1939 and ended in 1945 with the surrender of Germany and Japan."),
          reason: "The passage states that World War II ended in 1945, which contradicts the claim that it ended in 1943.",
          confidence: 0.9,
        })),
      };
    });

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    const status = await store.getStatus(auditId);
    const claim = status!.claims.find((c) => c.id === claimId)!;
    expect(provider.getCallCount()).toBe(4); // primary VERIFY + D025 consistency-check classifier + T034 retry + D025 §5's retry-contradiction check
    expect(claim.verdict).toBe("contradicted");
    expect(claim.evidence).toBe("World War II began in 1939 and ended in 1945 with the surrender of Germany and Japan.");
  });

  it("D026 §7/§11 (reviewed finding): the reconciliation retry's user message describes evidence_citations, not the old free-text quote contract", async () => {
    const claimId = uuid(1);
    const claimText = "World War II ended in 1943.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const passageText = "World War II began in 1939 and ended in 1945 with the surrender of Germany and Japan. ".repeat(5);
    const search = new FakeSearchProvider(new Map([[claimText, [webSource({ text: passageText })]]]));

    let retryUserMessage = "";
    provider.setResponseFn("You are a verification engine", (request) => {
      const ids = idsFromRequest(request);
      const selfInconsistent = provider.getCallCount() === 1;
      if (!selfInconsistent) retryUserMessage = request.user;
      return {
        results: ids.map((id) => ({
          id,
          verdict: selfInconsistent ? "unsupported" : "contradicted",
          evidenceCitations: selfInconsistent ? null : citationsFor(claimText, passageText, "World War II began in 1939 and ended in 1945 with the surrender of Germany and Japan."),
          reason: "The passage states that World War II ended in 1945, which contradicts the claim that it ended in 1943.",
          confidence: 0.9,
        })),
      };
    });

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    expect(retryUserMessage).toContain("evidence_citations");
    expect(retryUserMessage).not.toContain("exact quote");
  });

  it("T034: keeps the original degraded verdict when the retry also comes back self-inconsistent — never loops", async () => {
    const claimId = uuid(1);
    const claimText = "World War II ended in 1943.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const passageText = "World War II began in 1939 and ended in 1945 with the surrender of Germany and Japan. ".repeat(5);
    const search = new FakeSearchProvider(new Map([[claimText, [webSource({ text: passageText })]]]));

    provider.setResponseFn("You are a verification engine", (request) => {
      const ids = idsFromRequest(request);
      // Every call is self-inconsistent — the retry doesn't help this time.
      return {
        results: ids.map((id) => ({
          id,
          verdict: "unsupported",
          evidenceCitations: null,
          reason: "The passage states that World War II ended in 1945, which contradicts the claim that it ended in 1943.",
          confidence: 0.9,
        })),
      };
    });

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    const status = await store.getStatus(auditId);
    const claim = status!.claims.find((c) => c.id === claimId)!;
    // 3 calls (primary + classifier + one retry, exactly one — no loop) per pass, x3 passes: the
    // main pipeline plus both D026 §13 escalation tiers (still unsupported after each, so both fire;
    // the mock always answers the same way regardless of candidate count, same result every tier).
    expect(provider.getCallCount()).toBe(9);
    expect(claim.verdict).toBe("unsupported"); // degrades safely, doesn't fabricate evidence on the second miss either
    expect(claim.evidence).toBeNull();
  });

  it("T034 (reviewed finding): retries even when VERIFY's raw output already says contradicted, not just when reason_consistency had to flip it", async () => {
    const claimId = uuid(1);
    const claimText = "World War II ended in 1943.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const passageText = "World War II began in 1939 and ended in 1945 with the surrender of Germany and Japan. ".repeat(5);
    const search = new FakeSearchProvider(new Map([[claimText, [webSource({ text: passageText })]]]));

    provider.setResponseFn("You are a verification engine", (request) => {
      const ids = idsFromRequest(request);
      // First call: verdict is ALREADY "contradicted" (not flipped by reason_consistency — its own
      // overridden stays false here), but evidence is null. Old needsRetry (reasonConsistency.overridden
      // only) would have missed this entirely. Second call (retry): real evidence.
      const selfInconsistent = provider.getCallCount() === 1;
      return {
        results: ids.map((id) => ({
          id,
          verdict: "contradicted",
          evidenceCitations: selfInconsistent ? null : citationsFor(claimText, passageText, "World War II began in 1939 and ended in 1945 with the surrender of Germany and Japan."),
          reason: "The passage states that World War II ended in 1945, which contradicts the claim that it ended in 1943.",
          confidence: 0.9,
        })),
      };
    });

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    const status = await store.getStatus(auditId);
    const claim = status!.claims.find((c) => c.id === claimId)!;
    expect(provider.getCallCount()).toBe(3); // primary + retry (proves it fired despite reason_consistency never flipping anything) + D025 §5's retry-contradiction check
    expect(claim.verdict).toBe("contradicted");
    expect(claim.evidence).toBe("World War II began in 1939 and ended in 1945 with the surrender of Germany and Japan.");
  });

  it("D025: batched classifier flags a self-inconsistent 'unsupported' verdict with no explicit contradiction wording (nothing reason_consistency/implicit_negation catch), triggering a reconciliation retry — the real g04 recurrence, 2026-08-09", async () => {
    const claimId = uuid(1);
    const claimText = "World War II ended in 1943.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const passageText = "World War II began on September 1, 1939 and ended on September 2, 1945 with the surrender of Germany and Japan. ".repeat(5);
    const search = new FakeSearchProvider(new Map([[claimText, [webSource({ text: passageText })]]]));

    let verifyCalls = 0;
    provider.setResponseFn("You are a verification engine", (request) => {
      verifyCalls++;
      const ids = idsFromRequest(request);
      // Real g04 recurrence shape (run 2e755218, 2026-08-09): the model read the real end date
      // (proven by its own reason) but never reflected that in verdict/evidence — no "contradicts"/
      // "conflict"/", not Y" wording for the existing gates to catch. First call reproduces this
      // exact reason text; the retry gets it right.
      const firstPass = verifyCalls === 1;
      return {
        results: ids.map((id) => ({
          id,
          verdict: firstPass ? "unsupported" : "contradicted",
          evidenceCitations: firstPass ? null : citationsFor(claimText, passageText, "World War II began on September 1, 1939 and ended on September 2, 1945 with the surrender of Germany and Japan."),
          reason: firstPass
            ? "The passage mentions the dates of World War II as September 1, 1939 to September 2, 1945, but does not state that it ended in 1943."
            : "The passage states World War II ended on September 2, 1945, which conflicts with the claimed 1943 end date.",
          confidence: 0.9,
        })),
      };
    });

    // Overrides the beforeEach default — the FIRST classifier call (pass 1) says this claim's reason
    // does NOT support its verdict, triggering the retry. The retry's own result is genuinely correct
    // this time (real evidence, reason matches "contradicted"), so D025 §5's post-retry check — the
    // SECOND classifier call, over the retry's output — must say "consistent" or this test's own
    // premise (the retry actually fixes g04) can't be told apart from a false accusation.
    let consistencyCalls = 0;
    provider.setResponseFn("You are a consistency auditor", (request) => {
      consistencyCalls++;
      const ids = idsFromConsistencyRequest(request);
      const consistent = consistencyCalls > 1;
      return { results: ids.map((id) => ({ id, consistent })) };
    });

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    const status = await store.getStatus(auditId);
    const claim = status!.claims.find((c) => c.id === claimId)!;
    expect(verifyCalls).toBe(2); // primary VERIFY + the reconciliation retry — fired purely from gate #5, not gate #1
    expect(claim.verdict).toBe("contradicted");
    expect(claim.evidence).toBe("World War II began on September 1, 1939 and ended on September 2, 1945 with the surrender of Germany and Japan.");
  });

  it("D025 §5 addendum: downgrades a retry that lands on contradicted to unsupported when the post-retry classifier says its reason still doesn't support it (real live-test finding, the Emu War 'within days' claim, 2026-08-10)", async () => {
    const claimId = uuid(1);
    const claimText = "The campaign was declared a total failure within days.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const passageText = "The campaign failed most miserably, bringing its target its most complete victory. ".repeat(5);
    const search = new FakeSearchProvider(new Map([[claimText, [webSource({ text: passageText })]]]));

    let verifyCalls = 0;
    provider.setResponseFn("You are a verification engine", (request) => {
      verifyCalls++;
      const ids = idsFromRequest(request);
      const firstPass = verifyCalls === 1;
      return {
        results: ids.map((id) => ({
          id,
          verdict: firstPass ? "unsupported" : "contradicted",
          // The retry's evidence is real and gate #1-grounded — the bug isn't a fabricated quote,
          // it's the retry's own REASONING wrongly treating "confirmed failure" as also confirming
          // the claim's separate, never-evidenced "within days" timing.
          evidenceCitations: firstPass ? null : citationsFor(claimText, passageText, "The campaign failed most miserably, bringing its target its most complete victory."),
          reason: firstPass
            ? "The passage confirms the campaign failed but says nothing about the timing."
            : "The passage states the campaign failed most miserably, directly contradicting the claim that it was not declared a total failure.",
          confidence: 0.9,
        })),
      };
    });

    // Pass 1's classifier call catches the initial unsupported/reason mismatch (triggers the retry).
    // Pass 2's classifier call (D025 §5) catches that the retry's OWN reason — despite landing on
    // contradicted — still doesn't actually support contradicting the claim's "within days" timing.
    provider.setResponseFn("You are a consistency auditor", (request) => {
      const ids = idsFromConsistencyRequest(request);
      return { results: ids.map((id) => ({ id, consistent: false })) };
    });

    const gateEventStore = new FakeGrounnelGateEventStore();
    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), gateEventStore);
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    const status = await store.getStatus(auditId);
    const claim = status!.claims.find((c) => c.id === claimId)!;
    expect(claim.verdict).toBe("unsupported"); // not unverifiable — the contradiction failed validation, the claim wasn't unverifiable
    expect(claim.evidence).toBeNull();

    const events = gateEventStore.calls[0]!.events;
    const retryReconciliation = events.find((e) => e.gate === "retry_reconciliation")!;
    expect(retryReconciliation).toMatchObject({
      verdictBefore: "contradicted",
      verdictAfter: "unsupported",
      overridden: true,
      reason: "retry_contradiction_invalidated",
    });
  });

  it("D026 §12: gate #1b catches cross-claim contamination in a batched VERIFY call — one claim's id answered with a DIFFERENT claim's reasoning (real live-test finding, Marie Curie / Camp David Accords, 2026-08-10)", async () => {
    const curieId = uuid(1);
    const curieText = "Marie Curie won Nobel Prizes in chemistry and physics.";
    const curiePassage = "She shared the 1903 Nobel Prize in Physics with her husband. She won the 1911 Nobel Prize in Chemistry. ".repeat(3);
    const campDavidId = uuid(2);
    const campDavidText = "The Camp David Accords were signed in 1998.";
    const campDavidPassage = "The Camp David Accords were signed on 17 September 1978, ending the state of war between Egypt and Israel. ".repeat(3);
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({
      text: "article",
      maxClaims: 100,
      claims: [
        { id: curieId, text: curieText },
        { id: campDavidId, text: campDavidText },
      ],
      truncated: false,
    });
    const search = new FakeSearchProvider(
      new Map([
        [curieText, [webSource({ url: "https://a.example", text: curiePassage })]],
        [campDavidText, [webSource({ url: "https://b.example", text: campDavidPassage })]],
      ])
    );

    provider.setResponseFn("You are a verification engine", (request) => {
      const ids = idsFromRequest(request);
      if (ids.length === 1 && ids[0] === curieId) {
        // The T034 retry — single-claim, so cross-contamination is structurally impossible; gets it right.
        return {
          results: [
            {
              id: curieId,
              verdict: "supported",
              evidenceCitations: citationsFor(curieText, curiePassage, "She won the 1911 Nobel Prize in Chemistry."),
              reason: "Sentence A2 states she won the 1911 Nobel Prize in Chemistry, and A1 states she shared the 1903 Nobel Prize in Physics.",
              confidence: 0.9,
            },
          ],
        };
      }
      // The real batched primary call — Marie Curie's id gets Camp David's reasoning, verbatim, while
      // still citing a REAL sentence from her own pooled passage (gate #1 alone would pass this clean).
      return {
        results: ids.map((id) =>
          id === curieId
            ? {
                id,
                verdict: "contradicted",
                evidenceCitations: citationsFor(curieText, curiePassage, "She won the 1911 Nobel Prize in Chemistry."),
                reason: "Sentence A1 states the Camp David Accords were signed on 17 September 1978, not 1998.",
                confidence: 1,
              }
            : {
                id,
                verdict: "contradicted",
                evidenceCitations: citationsFor(campDavidText, campDavidPassage, "The Camp David Accords were signed on 17 September 1978, ending the state of war between Egypt and Israel."),
                reason: "Sentence A1 states the Camp David Accords were signed on 17 September 1978, not 1998.",
                confidence: 1,
              }
        ),
      };
    });

    const gateEventStore = new FakeGrounnelGateEventStore();
    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), gateEventStore);
    await service.run(auditId, [
      { id: curieId, text: curieText },
      { id: campDavidId, text: campDavidText },
    ]);

    const status = await store.getStatus(auditId);
    const curie = status!.claims.find((c) => c.id === curieId)!;
    const campDavid = status!.claims.find((c) => c.id === campDavidId)!;

    // The contaminated claim gets caught and retried into a correct answer — not a false accusation.
    expect(curie.verdict).toBe("supported");
    // The real Camp David claim is untouched by the new gate — its reason genuinely is about itself.
    expect(campDavid.verdict).toBe("contradicted");

    const curieEvents = gateEventStore.calls.find((c) => c.claimId === curieId)!.events;
    const overlapEvent = curieEvents.find((e) => e.gate === "claim_reason_overlap")!;
    expect(overlapEvent).toMatchObject({ verdictBefore: "contradicted", verdictAfter: "unsupported", overridden: true, reason: "claim_reason_no_overlap" });

    const campDavidEvents = gateEventStore.calls.find((c) => c.claimId === campDavidId)!.events;
    expect(campDavidEvents.find((e) => e.gate === "claim_reason_overlap")).toMatchObject({ overridden: false, reason: null });
  });

  it("D026 §13: escalates a claim still unsupported after the normal pipeline to a wider candidate pool, and finds real evidence there (the blue whale live-test shape, 2026-08-10)", async () => {
    const claimId = uuid(1);
    const claimText = "The blue whale is the largest animal known to have ever existed.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const passageText = "The blue whale is the largest animal ever to have lived on Earth. ".repeat(10);

    const searchCalls: Array<number | undefined> = [];
    const search: SearchProvider = {
      async search(_query, context) {
        searchCalls.push(context?.maxCandidates);
        // Real shape: the base 3-candidate pool never surfaces the one page that states the fact;
        // a wider pool (tier 5+) does — no code path here cares about the exact number past 3.
        if ((context?.maxCandidates ?? 3) <= 3) {
          return [webSource({ status: "unreachable", text: null })];
        }
        return [webSource({ text: passageText })];
      },
    };

    provider.setResponseFn("You are a verification engine", (request) => {
      const ids = idsFromRequest(request);
      return { results: ids.map((id) => ({ id, verdict: "supported", evidenceCitations: citationsFor(claimText, passageText, "The blue whale is the largest animal ever to have lived on Earth."), reason: "The passage confirms this directly.", confidence: 0.95 })) };
    });

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    const status = await store.getStatus(auditId);
    const claim = status!.claims.find((c) => c.id === claimId)!;
    expect(claim.verdict).toBe("supported");
    expect(claim.evidence).toBe("The blue whale is the largest animal ever to have lived on Earth.");
    // Base pass (no maxCandidates), then tier 5 finds it — tier 8 never needed.
    expect(searchCalls).toEqual([undefined, 5]);
  });

  it("D026 §13: downgrades an escalation round's fresh 'contradicted' verdict when the reason-consistency check says it doesn't hold up — the same false-accusation risk T051 closed for retries, now closed for escalation", async () => {
    const claimId = uuid(1);
    // Reason deliberately shares key terms with the claim ("Marie"/"Curie") so gate #1b (D026 §12)
    // passes it through unflagged — this test isolates the NEW escalation guard specifically, not
    // the lexical-overlap gate that already happens to catch some of the same shape.
    const claimText = "Marie Curie discovered radium in 1898.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const passageText = "Marie Curie worked extensively on radioactivity throughout her career. ".repeat(10);

    const search: SearchProvider = {
      async search(_query, context) {
        if ((context?.maxCandidates ?? 3) <= 3) {
          return [webSource({ status: "unreachable", text: null })];
        }
        return [webSource({ text: passageText })];
      },
    };

    provider.setResponseFn("You are a verification engine", (request) => {
      const ids = idsFromRequest(request);
      return {
        results: ids.map((id) => ({
          id,
          verdict: "contradicted",
          evidenceCitations: citationsFor(claimText, passageText, "Marie Curie worked extensively on radioactivity throughout her career."),
          reason: "The passage discusses Marie Curie's general work but does not mention radium or the year 1898.",
          confidence: 0.9,
        })),
      };
    });
    // Every consistency-check call says the reason doesn't hold up for this claim.
    provider.setResponseFn("You are a consistency auditor", (request) => {
      const ids = idsFromConsistencyRequest(request);
      return { results: ids.map((id) => ({ id, consistent: false })) };
    });

    const gateEventStore = new FakeGrounnelGateEventStore();
    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), gateEventStore);
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    const status = await store.getStatus(auditId);
    const claim = status!.claims.find((c) => c.id === claimId)!;
    expect(claim.verdict).toBe("unsupported"); // not a false accusation, despite the escalation round answering "contradicted"
    expect(claim.evidence).toBeNull();

    // Fires once per escalation tier (5, then 8) — the claim stays unresolved after each downgrade,
    // so it's still eligible for the next tier, and each tier's fresh "contradicted" gets caught again.
    const events = gateEventStore.calls.flatMap((c) => c.events);
    expect(events.filter((e) => e.gate === "retry_reconciliation" && e.overridden)).toHaveLength(2);
  });

  it("T034 (reviewed finding): a successful retry appends its gate events to the original pass's, instead of discarding the original trace", async () => {
    const claimId = uuid(1);
    const claimText = "World War II ended in 1943.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const passageText = "World War II began in 1939 and ended in 1945 with the surrender of Germany and Japan. ".repeat(5);
    const search = new FakeSearchProvider(new Map([[claimText, [webSource({ text: passageText })]]]));

    provider.setResponseFn("You are a verification engine", (request) => {
      const ids = idsFromRequest(request);
      const selfInconsistent = provider.getCallCount() === 1;
      return {
        results: ids.map((id) => ({
          id,
          verdict: selfInconsistent ? "unsupported" : "contradicted",
          evidenceCitations: selfInconsistent ? null : citationsFor(claimText, passageText, "World War II began in 1939 and ended in 1945 with the surrender of Germany and Japan."),
          reason: "The passage states that World War II ended in 1945, which contradicts the claim that it ended in 1943.",
          confidence: 0.9,
        })),
      };
    });

    const gateEventStore = new FakeGrounnelGateEventStore();
    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), gateEventStore);
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    expect(gateEventStore.calls).toHaveLength(1);
    const events = gateEventStore.calls[0]!.events;
    // 6 gates x 2 passes (D025 added counterfact_ignored, D026 §12 added claim_reason_overlap),
    // plus D025 §5's retry-contradiction check (the retry landed on contradicted, so it ran) —
    // the original inconsistent pass is not lost.
    expect(events).toHaveLength(13);
    expect(events.filter((e) => e.gate === "contradiction_evidence")).toHaveLength(2);
    // The original pass's downgrade (the reason this retried at all) is still present.
    // Index 3, not 2: counterfact_ignored (D025) now sits between implicit_negation and contradiction_evidence.
    expect(events[3]).toMatchObject({ gate: "contradiction_evidence", verdictAfter: "unsupported", reason: "evidence_null" });
    // The retry pass's success is also present, distinguishable by looking further into the array.
    // Index 9, not 8: each pass is now 6 gates (contradiction_evidence is offset 3 within a pass).
    expect(events[9]).toMatchObject({ gate: "contradiction_evidence", verdictAfter: "contradicted", reason: null });
    // D025 §5 — the post-retry check itself, appended last; the default beforeEach classifier mock
    // says "consistent", so it validates the retry's contradiction rather than downgrading it.
    expect(events[12]).toMatchObject({ gate: "retry_reconciliation", verdictBefore: "contradicted", verdictAfter: "contradicted", overridden: false, reason: null });
  });

  it("T034 (reviewed finding): a RateLimitError during the retry call stops remaining batches, same as the primary VERIFY call", async () => {
    const inconsistentClaim = { id: uuid(0), text: "World War II ended in 1943." };
    const otherClaims = Array.from({ length: 7 }, (_, i) => ({ id: uuid(i + 1), text: `Claim number ${i + 1} about something.` }));
    const lastBatchClaim = { id: uuid(9), text: "A claim in the second batch." };
    const allClaims = [inconsistentClaim, ...otherClaims, lastBatchClaim]; // 9 claims: BATCH_MAX 8 + 1
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: allClaims, truncated: false });

    const passageText = "World War II began in 1939 and ended in 1945 with the surrender of Germany and Japan. ".repeat(5);
    const responses = new Map<string, SearchPassage[]>([[inconsistentClaim.text, [webSource({ text: passageText })]]]);
    for (const c of [...otherClaims, lastBatchClaim]) {
      responses.set(c.text, [webSource({ url: `https://example.com/${c.id}`, text: (c.text + " ").repeat(20) })]);
    }
    const search = new FakeSearchProvider(responses);

    let calls = 0;
    const provider2: Provider = {
      mode: "mock",
      completeJson: async (request) => {
        calls++;
        // D025 §2 — this batch now makes 3 real calls before batch 2: (1) primary VERIFY, (2) the
        // batched consistency-check classifier (every claim here is "supported"/"unsupported", none
        // "contradicted", so all 8 are candidates), (3) T034's single-claim retry for
        // inconsistentClaim — that one hits the rate limit. Batch 2 must never be attempted.
        if (calls === 3) {
          throw new RateLimitError("daily quota exceeded", "daily", "2026-08-07T00:00:00Z");
        }
        if (request.system.includes("You are a consistency auditor")) {
          const ids = idsFromConsistencyRequest(request);
          return { result: { results: ids.map((id) => ({ id, consistent: true })) } };
        }
        const ids = idsFromRequest(request);
        return {
          result: {
            results: ids.map((id) => ({
              id,
              verdict: id === inconsistentClaim.id ? "unsupported" : "supported",
              evidenceCitations: id === inconsistentClaim.id ? null : [{ source: "A", n: 1 }],
              reason:
                id === inconsistentClaim.id
                  ? "The passage states that World War II ended in 1945, which contradicts the claim that it ended in 1943."
                  : "The passage confirms this.",
              confidence: 0.9,
            })),
          },
        };
      },
    };

    const service = new GrounnelPipelineService(search, provider2, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());
    await service.run(auditId, allClaims);

    expect(calls).toBe(3); // batch 1's primary call + classifier + inconsistentClaim's retry — batch 2 never called
    const status = await store.getStatus(auditId);
    const flagged = status!.claims.find((c) => c.id === inconsistentClaim.id)!;
    expect(flagged.verdict).toBe("unsupported"); // kept the pre-retry degraded result, didn't crash
    const secondBatchClaim = status!.claims.find((c) => c.id === lastBatchClaim.id)!;
    expect(secondBatchClaim.status).toBe("failed"); // degraded, never actually verified
    expect(secondBatchClaim.reason).toContain("We've hit today's AI usage limit");
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
          evidenceCitations: citationsFor(claimText, passageText, "The Statue of Liberty was a gift from France to the United States, dedicated in 1886 to celebrate the friendship between the two nations."),
          reason: "The passage states the statue was a gift from France, not Canada.",
          confidence: 0.9,
        })),
      };
    });

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());
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
      return {
        results: ids.map((id) => ({
          id,
          verdict: "supported",
          evidenceCitations: citationsFor(claimText, passageText, "The NEH awarded UC Riverside a $350,000 grant to expand the project."),
          reason: "matches",
          confidence: 0.9,
        })),
      };
    });

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());
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
      return { results: ids.map((id) => ({ id, verdict: "supported", evidenceCitations: [{ source: "A", n: 1 }], reason: "weak match", confidence: 0.3 })) };
    });

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());
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

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());
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

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    const status = await store.getStatus(auditId);
    const claim = status!.claims.find((c) => c.id === claimId)!;
    expect(claim.status).toBe("failed");
    expect(claim.verdict).toBeNull();
    expect(status!.score.not_checked_n).toBe(1);
  });

  it("degrades only the claims VERIFY's response omitted even after a D026 §8 fill-in retry, not the whole batch", async () => {
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
      // Every call (primary AND the fill-in retry) only ever answers c1, silently omits c2 —
      // the fill-in genuinely can't recover it this time, so c2 must still degrade in the end.
      results: [{ id: uuid(1), verdict: "supported", evidenceCitations: [{ source: "A", n: 1 }], reason: "ok", confidence: 0.9 }],
    }));

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());
    await service.run(auditId, claims);

    const status = await store.getStatus(auditId);
    expect(status!.claims.find((c) => c.id === uuid(1))!.status).toBe("done");
    const c2 = status!.claims.find((c) => c.id === uuid(2))!;
    expect(c2.status).toBe("failed");
    expect(c2.reason).toContain("even after a fill-in retry");
  });

  it("D026 §8 (T045): recovers a claim VERIFY's response omitted via a fill-in retry, instead of degrading it", async () => {
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

    let verifyCalls = 0;
    provider.setResponseFn("You are a verification engine", (request) => {
      verifyCalls++;
      const ids = idsFromRequest(request);
      if (verifyCalls === 1) {
        // Primary call: only answers c1, silently omits c2 — the ids requested prove c2 WAS asked.
        expect(ids).toEqual([uuid(1), uuid(2)]);
        return { results: [{ id: uuid(1), verdict: "supported", evidenceCitations: [{ source: "A", n: 1 }], reason: "ok", confidence: 0.9 }] };
      }
      // Fill-in call: requested only c2 this time (never re-asks the whole batch), and answers it.
      expect(ids).toEqual([uuid(2)]);
      return { results: [{ id: uuid(2), verdict: "supported", evidenceCitations: [{ source: "A", n: 1 }], reason: "ok", confidence: 0.9 }] };
    });

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());
    await service.run(auditId, claims);

    const status = await store.getStatus(auditId);
    expect(status!.claims.find((c) => c.id === uuid(1))!.status).toBe("done");
    const c2 = status!.claims.find((c) => c.id === uuid(2))!;
    expect(c2.status).toBe("done");
    expect(c2.verdict).toBe("supported");
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
      return { results: ids.map((id) => ({ id, verdict: "supported", evidenceCitations: [{ source: "A", n: 1 }], reason: "ok", confidence: 0.9 })) };
    });

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());
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
    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());

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

    const service = new GrounnelPipelineService(search, rateLimitedProvider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());
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

    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());
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

  it("T024/D023 §7: writes a grounnel_claims row alongside the Redis writeClaimResult call, and marks the run done at the end", async () => {
    const claimId = uuid(1);
    const claimText = "Bukowski attended Los Angeles City College.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const passageText = "Bukowski attended Los Angeles City College for two years, per Wikipedia. ".repeat(5);
    const search = new FakeSearchProvider(new Map([[claimText, [webSource({ text: passageText })]]]));

    provider.setResponseFn("You are a verification engine", (request) => {
      const ids = idsFromRequest(request);
      return { results: ids.map((id) => ({ id, verdict: "supported", evidenceCitations: citationsFor(claimText, passageText, "Bukowski attended Los Angeles City College for two years, per Wikipedia."), reason: "Wikipedia confirms it.", confidence: 0.95 })) };
    });

    const historyStore = new FakeGrounnelHistoryStore();
    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, historyStore, new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    expect(historyStore.createClaimCalls).toHaveLength(1);
    expect(historyStore.createClaimCalls[0]).toMatchObject({ claimId, runId: auditId, claimText, verdict: "supported", status: "done" });
    // Two updateRun calls: T025's per-batch promptVersionVerify stamp, then T024's final
    // status:"done" stamp at the end of run() — assert the LAST one, not an exact count of one.
    expect(historyStore.updateRunCalls.length).toBeGreaterThanOrEqual(1);
    const finalUpdate = historyStore.updateRunCalls[historyStore.updateRunCalls.length - 1]!;
    expect(finalUpdate.runId).toBe(auditId);
    expect(finalUpdate.data).toMatchObject({ status: "done" });
  });

  it("T024/D023 §7: a no-evidence claim also writes a grounnel_claims row (status done, verdict unsupported)", async () => {
    const claimId = uuid(1);
    const claimText = "Some obscure claim.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const search = new FakeSearchProvider(new Map([[claimText, [webSource({ status: "unreachable", text: null })]]]));
    const historyStore = new FakeGrounnelHistoryStore();
    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, historyStore, new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());

    await service.run(auditId, [{ id: claimId, text: claimText }]);

    expect(historyStore.createClaimCalls).toHaveLength(1);
    expect(historyStore.createClaimCalls[0]).toMatchObject({ claimId, runId: auditId, verdict: "unsupported", status: "done" });
  });

  it("T025/D023 §4: records one grounnel_llm_calls completion for the VERIFY call, stamped with the real prompt version", async () => {
    const claimId = uuid(1);
    const claimText = "Bukowski attended Los Angeles City College.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const passageText = "Bukowski attended Los Angeles City College for two years, per Wikipedia. ".repeat(5);
    const search = new FakeSearchProvider(new Map([[claimText, [webSource({ text: passageText })]]]));

    provider.setResponseFn("You are a verification engine", (request) => {
      const ids = idsFromRequest(request);
      return { results: ids.map((id) => ({ id, verdict: "supported", evidenceCitations: citationsFor(claimText, passageText, "Bukowski attended Los Angeles City College for two years, per Wikipedia."), reason: "confirmed", confidence: 0.9 })) };
    });

    const prompts = new PromptRegistry();
    const llmCallStore = new FakeGrounnelLlmCallStore();
    const service = new GrounnelPipelineService(search, provider, prompts, store, new NoopGrounnelHistoryStore(), llmCallStore, new NoopGrounnelGateEventStore());
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    // Two rows now: the primary VERIFY call, plus D025's batched consistency-check classifier call
    // (fires because this claim's verdict — "supported" — isn't already "contradicted").
    expect(llmCallStore.recordCallContexts).toHaveLength(2);
    expect(llmCallStore.recordCallContexts[0]).toMatchObject({
      runId: auditId,
      stage: "verify",
      callType: "primary",
      promptVersion: prompts.getGrounnelVerifyVersion(),
    });
    expect(llmCallStore.recordCallContexts[1]).toMatchObject({
      runId: auditId,
      stage: "verify",
      callType: "consistency_check",
      promptVersion: prompts.getGrounnelConsistencyCheckVersion(),
    });
    expect(llmCallStore.completions[0]!.info.status).toBe("success");
  });

  it("T026/D023 §6: passes {runId, claimId} context through to SearchProvider.search()", async () => {
    const claimId = uuid(1);
    const claimText = "Bukowski attended Los Angeles City College.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const search = new FakeSearchProvider(new Map([[claimText, [webSource({ status: "unreachable", text: null })]]]));
    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), new NoopGrounnelGateEventStore());

    await service.run(auditId, [{ id: claimId, text: claimText }]);

    // 3 calls: the primary pass plus both D026 §13 escalation tiers — this claim never resolves
    // (search always returns the same unreachable source), so it stays eligible at every tier.
    expect(search.calls).toHaveLength(3);
    for (const call of search.calls) {
      expect(call).toMatchObject({ query: claimText, context: { runId: auditId, claimId } });
    }
  });

  it("T027/D023 §5: records exactly one grounnel_gate_events batch per claim, one entry per gate, in chain order", async () => {
    const claimId = uuid(1);
    const claimText = "Bukowski attended Los Angeles City College.";
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const { id: auditId } = await store.createAudit({ text: "article", maxClaims: 100, claims: [{ id: claimId, text: claimText }], truncated: false });
    const passageText = "Bukowski attended Los Angeles City College for two years, per Wikipedia. ".repeat(5);
    const search = new FakeSearchProvider(new Map([[claimText, [webSource({ text: passageText })]]]));

    provider.setResponseFn("You are a verification engine", (request) => {
      const ids = idsFromRequest(request);
      return { results: ids.map((id) => ({ id, verdict: "supported", evidenceCitations: citationsFor(claimText, passageText, "Bukowski attended Los Angeles City College for two years, per Wikipedia."), reason: "confirmed", confidence: 0.9 })) };
    });

    const gateEventStore = new FakeGrounnelGateEventStore();
    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), gateEventStore);
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    expect(gateEventStore.calls).toHaveLength(1);
    expect(gateEventStore.calls[0]!.runId).toBe(auditId);
    expect(gateEventStore.calls[0]!.claimId).toBe(claimId);
    expect(gateEventStore.calls[0]!.events.map((e) => e.gate)).toEqual([
      "reason_consistency",
      "implicit_negation",
      "counterfact_ignored",
      "contradiction_evidence",
      "claim_reason_overlap",
      "numeric",
    ]);
    // Real claim: verdict starts and ends "supported" — none of the six gates should fire.
    expect(gateEventStore.calls[0]!.events.every((e) => !e.overridden)).toBe(true);
  });

  it("T027/D023 §5: an overriding gate (g05-shaped implicit negation) is recorded with overridden:true and the real before/after verdicts", async () => {
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
          evidenceCitations: citationsFor(claimText, passageText, "The Statue of Liberty was a gift from France to the United States, dedicated in 1886 to celebrate the friendship between the two nations."),
          reason: "The passage states the statue was a gift from France, not Canada.",
          confidence: 0.9,
        })),
      };
    });

    const gateEventStore = new FakeGrounnelGateEventStore();
    const service = new GrounnelPipelineService(search, provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore(), gateEventStore);
    await service.run(auditId, [{ id: claimId, text: claimText }]);

    const events = gateEventStore.calls[0]!.events;
    const implicitNegation = events.find((e) => e.gate === "implicit_negation")!;
    expect(implicitNegation).toMatchObject({ verdictBefore: "unsupported", verdictAfter: "contradicted", overridden: true });
    // reason_consistency runs first and doesn't catch this bare negation (no contradiction verb) — abstains.
    expect(events.find((e) => e.gate === "reason_consistency")).toMatchObject({ overridden: false });
  });
});
