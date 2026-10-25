import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerGrounnelRoutes } from "../../src/routes/grounnel.js";
import { GrounnelExtractService } from "../../src/orchestrators/grounnel/extract.service.js";
import { GrounnelPipelineService } from "../../src/orchestrators/grounnel/pipeline.service.js";
import { RedisGrounnelStore } from "../../src/persistence/grounnel-store.js";
import { DrizzleGrounnelHistoryStore } from "../../src/persistence/grounnel-history-store.js";
import { InMemoryRateLimiter, RATE_LIMIT_OWN_KEY_PER_IP_PER_HOUR } from "../../src/lib/rate-limit.js";
import { generateShareToken } from "../../src/lib/share-token.js";
import { PromptRegistry } from "../../src/prompts/registry.js";
import { MockProvider } from "../mocks/mock-provider.js";
import { FakeRedisHashClient } from "../mocks/fake-redis-hash-client.js";
import { NoopGrounnelLlmCallStore } from "../mocks/noop-grounnel-llm-call-store.js";
import { NoopGrounnelGateEventStore } from "../mocks/noop-grounnel-gate-event-store.js";
import type { SearchPassage, SearchProvider } from "../../src/providers/search/search-provider.js";
import type { CompletionRequest, Provider } from "../../src/providers/types.js";

const VALID_AUTH = "Bearer dev-secret-change-me";

const state = vi.hoisted(() => ({
  runs: new Map<string, Record<string, any>>(),
  sumCalls: [] as string[],
  doneWrites: 0,
  totals: { input: 0, output: 0 },
}));

vi.mock("../../src/db/queries.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/db/queries.js")>();
  return {
    ...actual,
    insertGrounnelRun: async (data: Record<string, any>) => {
      const row = {
        ...data,
        status: "extracting",
        createdAt: new Date(),
        completedAt: null,
        score: null,
        provider: data.provider ?? "gemini",
        model: data.model ?? null,
      };
      state.runs.set(data.runId, row);
      return row;
    },
    updateGrounnelRun: async (runId: string, data: Record<string, any>) => {
      if (data.status === "done") state.doneWrites += 1;
      const row = state.runs.get(runId);
      if (row) Object.assign(row, data);
    },
    insertGrounnelClaim: async () => undefined,
    selectGrounnelClaimsByRunId: async () => [],
    selectGrounnelRunByShareToken: async (shareToken: string) => {
      for (const row of state.runs.values()) {
        if (row.shareToken === shareToken) return row;
      }
      return null;
    },
    sumGrounnelJudgingTokens: async (runId: string) => {
      state.sumCalls.push(runId);
      return state.totals;
    },
  };
});

function webSource(text: string): SearchPassage {
  return { url: "https://example.com/a", title: "Example", domain: "example.com", status: "ok", text };
}

function idsFrom(request: CompletionRequest, marker: string): string[] {
  const match = request.system.match(new RegExp(`${marker}: (\\[.*\\])`, "s"));
  if (!match?.[1]) return [];
  return (JSON.parse(match[1]) as Array<{ id: string }>).map((row) => row.id);
}

function build(provider: Provider, search: SearchProvider) {
  const server = Fastify();
  const grounnelStore = new RedisGrounnelStore(new FakeRedisHashClient());
  const historyStore = new DrizzleGrounnelHistoryStore();
  const prompts = new PromptRegistry();
  const extractService = new GrounnelExtractService(provider, prompts, grounnelStore, historyStore, new NoopGrounnelLlmCallStore());
  const pipelineService = new GrounnelPipelineService(
    search,
    provider,
    prompts,
    grounnelStore,
    historyStore,
    new NoopGrounnelLlmCallStore(),
    new NoopGrounnelGateEventStore(),
  );
  registerGrounnelRoutes(server, {
    extractService,
    pipelineService,
    grounnelStore,
    historyStore,
    rateLimiter: new InMemoryRateLimiter(1000, 60_000),
    ownKeyRateLimiter: new InMemoryRateLimiter(RATE_LIMIT_OWN_KEY_PER_IP_PER_HOUR, 60_000),
    assessmentRateLimiter: new InMemoryRateLimiter(1000, 60_000),
  });
  return { server, grounnelStore, historyStore, extractService, pipelineService };
}

async function both(server: FastifyInstance, id: string, shareToken: string) {
  const statusRes = await server.inject({ method: "GET", url: `/status/${id}`, headers: { authorization: VALID_AUTH } });
  const shareRes = await server.inject({ method: "GET", url: `/assessment/${shareToken}` });
  expect(statusRes.statusCode).toBe(200);
  expect(shareRes.statusCode).toBe(200);
  return { status: JSON.parse(statusRes.body), share: JSON.parse(shareRes.body) };
}

describe("own-key token totals agree on /status and the share page (T2018)", () => {
  beforeEach(() => {
    state.runs.clear();
    state.sumCalls.length = 0;
    state.doneWrites = 0;
    state.totals = { input: 0, output: 0 };
  });

  it("an all-opinion own-key run reports the extract tokens on both, and a site-paid run reports null", async () => {
    state.totals = { input: 40, output: 9 };
    const provider = new MockProvider();
    provider.setDefault({
      claims: [{ claim: "This is the best coffee in Rome.", source_excerpt: "This is the best coffee in Rome." }],
      truncated: false,
    });
    const { server, extractService } = build(provider, { search: async () => [] });
    const { id, shareToken, pendingClaims } = await extractService.run("Some pasted article text.", "production", null, provider, "own");

    expect(pendingClaims).toHaveLength(0);
    expect(state.runs.get(id)?.status).toBe("done");
    expect(state.doneWrites).toBe(1);
    expect(state.sumCalls).toEqual([]);

    const own = await both(server, id, shareToken);
    expect(own.status.ownKeyTokens).toEqual({ input: 40, output: 9 });
    expect(own.share.ownKeyTokens).toEqual(own.status.ownKeyTokens);
    expect(own.status.ownKeyTokens.input).toBeGreaterThan(0);
    expect(own.status.ownKeyTokens.output).toBeGreaterThan(0);
    expect(JSON.stringify(own.status)).not.toMatch(/key_source|keySource/);
    expect(JSON.stringify(own.share)).not.toMatch(/key_source|keySource/);
    expect(state.sumCalls).toEqual([id, id]);

    state.sumCalls.length = 0;
    const siteProvider = new MockProvider();
    siteProvider.setDefault({
      claims: [{ claim: "This is the best coffee in Rome.", source_excerpt: "This is the best coffee in Rome." }],
      truncated: false,
    });
    const site = build(siteProvider, { search: async () => [] });
    const siteRun = await site.extractService.run("Some pasted article text.");
    const paid = await both(site.server, siteRun.id, siteRun.shareToken);
    expect(state.runs.get(siteRun.id)?.status).toBe("done");
    expect(paid.status.ownKeyTokens).toBeNull();
    expect(paid.share.ownKeyTokens).toBeNull();
    expect(state.sumCalls).toEqual([]);
  });

  it("an all-ineligible own-key run reports the extract and eligibility tokens on both", async () => {
    state.totals = { input: 55, output: 14 };
    const provider = new MockProvider();
    provider.setDefault({
      claims: [{ claim: "My pet cat is named Whiskers.", source_excerpt: "My pet cat is named Whiskers." }],
      truncated: false,
    });
    provider.setResponse("You are a claim-eligibility classifier", {
      category: "personal",
      certainty: "clear",
      reason: "private circumstance",
      hasResolvableReferent: true,
    });
    const { server, extractService } = build(provider, { search: async () => [] });
    const extracted = await extractService.run("Some pasted article text.", "production", null, provider, "own");

    expect(extracted.pendingClaims).toHaveLength(1);
    expect(state.runs.get(extracted.id)?.status).toBe("extracting");
    expect(state.doneWrites).toBe(0);

    const eligible = await extractService.classifyEligibility(extracted.id, extracted.pendingClaims, provider);
    expect(eligible).toHaveLength(0);
    expect(state.runs.get(extracted.id)?.status).toBe("done");
    expect(state.doneWrites).toBe(1);
    expect(state.sumCalls).toEqual([]);

    const pages = await both(server, extracted.id, extracted.shareToken);
    expect(pages.status.ownKeyTokens).toEqual({ input: 55, output: 14 });
    expect(pages.share.ownKeyTokens).toEqual(pages.status.ownKeyTokens);
    expect(pages.status.ownKeyTokens.input).toBeGreaterThan(0);
    expect(state.sumCalls).toEqual([extracted.id, extracted.id]);
  });

  it("a finished pipeline own-key run agrees after the verify batch, and the sum is not taken mid-run", async () => {
    state.totals = { input: 80, output: 21 };
    const claimText = "The Eiffel Tower was completed in 1889.";
    const provider = new MockProvider();
    provider.setResponseFn("You are a verification engine", (request) => {
      const ids = idsFrom(request, "CLAIM_PASSAGE_PAIRS");
      return {
        results: ids.map((id) => ({
          id,
          verdict: "supported",
          evidenceCitations: [{ source: "A", n: 1 }],
          reason: "matches",
          confidence: 0.9,
        })),
      };
    });
    provider.setResponseFn("You are a consistency auditor", (request) => ({
      results: idsFrom(request, "REASON_VERDICT_PAIRS").map((id) => ({ id, consistent: true })),
    }));
    provider.setResponseFn("You are an attribution checker", (request) => ({
      results: idsFrom(request, "INSTANCE_CHECKS").map((id) => ({ id, attribution: "absent", citation: null })),
    }));
    const search: SearchProvider = { search: async () => [webSource(`${claimText} `.repeat(20))] };
    const { server, grounnelStore, historyStore, pipelineService } = build(provider, search);
    const runId = "11111111-1111-4111-8111-111111111111";
    const claimId = "22222222-2222-4222-8222-222222222222";
    const shareToken = generateShareToken();
    await historyStore.createRun({
      runId,
      shareToken,
      sessionId: null,
      text: claimText,
      source: "production",
      maxClaims: 40,
      truncated: false,
      provider: "gemini",
      model: "mock",
      keySource: "own",
    });
    await grounnelStore.createAudit({
      id: runId,
      text: claimText,
      maxClaims: 40,
      claims: [{ id: claimId, text: claimText, sourceExcerpt: claimText }],
      truncated: false,
      provider: "gemini",
      model: "mock",
      keySource: "own",
    });

    await pipelineService.run(runId, [{ id: claimId, text: claimText, sourceExcerpt: claimText }], "defaultFlow", claimText, provider);

    expect(state.sumCalls).toEqual([]);
    expect(state.runs.get(runId)?.status).toBe("done");
    expect(state.doneWrites).toBe(1);
    expect((await grounnelStore.getStatus(runId))!.status).toBe("done");

    const pages = await both(server, runId, shareToken);
    expect(pages.status.status).toBe("done");
    expect(pages.share.status).toBe("done");
    expect(pages.status.ownKeyTokens).toEqual({ input: 80, output: 21 });
    expect(pages.share.ownKeyTokens).toEqual(pages.status.ownKeyTokens);
    expect(state.sumCalls).toEqual([runId, runId]);
  });
});
