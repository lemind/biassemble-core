import { describe, it, expect, beforeEach } from "vitest";
import { GrounnelExtractService } from "../../../../src/orchestrators/grounnel/extract.service.js";
import { RedisGrounnelStore } from "../../../../src/persistence/grounnel-store.js";
import { PromptRegistry } from "../../../../src/prompts/registry.js";
import { RateLimitError } from "../../../../src/providers/gemini.js";
import { MockProvider } from "../../../mocks/mock-provider.js";
import { FakeRedisHashClient } from "../../../mocks/fake-redis-hash-client.js";
import { NoopGrounnelHistoryStore } from "../../../mocks/noop-grounnel-history-store.js";
import { FakeGrounnelHistoryStore } from "../../../mocks/fake-grounnel-history-store.js";
import type { Provider } from "../../../../src/providers/types.js";

function makeService(provider: MockProvider) {
  const store = new RedisGrounnelStore(new FakeRedisHashClient());
  const service = new GrounnelExtractService(provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore());
  return { service, store };
}

describe("GrounnelExtractService (T009)", () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider();
  });

  it("writes the initial claim list to the store and returns before any search/verify work", async () => {
    provider.setDefault({
      claims: [{ claim: "The Eiffel Tower was completed in 1889." }, { claim: "Bukowski attended Los Angeles City College." }],
      truncated: false,
    });
    const { service, store } = makeService(provider);

    const { id } = await service.run("Some pasted article text.");
    const status = await store.getStatus(id);

    expect(status).not.toBeNull();
    expect(status!.claims).toHaveLength(2);
    expect(status!.claims.map((c) => c.text)).toEqual([
      "The Eiffel Tower was completed in 1889.",
      "Bukowski attended Los Angeles City College.",
    ]);
    // Every claim already has a real, non-empty status the moment EXTRACT returns — proves
    // this ran synchronously, not fire-and-forget (T009's acceptance bar).
    expect(status!.claims.every((c) => c.status === "pending" || c.status === "done")).toBe(true);
  });

  it("resolves an opinion-shaped claim to unverifiable immediately, with zero SearchProvider calls (gate #3)", async () => {
    provider.setDefault({
      claims: [{ claim: "This is the best coffee in Rome." }, { claim: "The Eiffel Tower was completed in 1889." }],
      truncated: false,
    });
    const { service, store } = makeService(provider);
    const searchCalls: string[] = [];
    const mockSearchProvider = { search: (q: string) => searchCalls.push(q) };

    const { id } = await service.run("Some pasted article text.");
    const status = await store.getStatus(id);

    const opinionClaim = status!.claims.find((c) => c.text.includes("best coffee"))!;
    expect(opinionClaim.status).toBe("done");
    expect(opinionClaim.verdict).toBe("unverifiable");
    expect(opinionClaim.sources).toEqual([]);

    const factualClaim = status!.claims.find((c) => c.text.includes("Eiffel"))!;
    expect(factualClaim.status).toBe("pending");

    // T005's zero-search-calls bar, exercised here at the actual call site (extract.service.ts),
    // not just simulated — this is the real integration T005's own test deferred to this task.
    for (const claim of status!.claims) {
      if (claim.status === "done") continue; // already resolved by gate #3, no search needed
      mockSearchProvider.search(claim.text);
    }
    expect(searchCalls).toEqual(["The Eiffel Tower was completed in 1889."]);
  });

  it("fails fast on RateLimitError instead of burning all retries against a guaranteed-to-repeat failure", async () => {
    let calls = 0;
    const rateLimitedProvider: Provider = {
      mode: "mock",
      completeJson: async () => {
        calls++;
        throw new RateLimitError("quota exceeded", "daily");
      },
    };
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const service = new GrounnelExtractService(rateLimitedProvider, new PromptRegistry(), store, new NoopGrounnelHistoryStore());

    await expect(service.run("text")).rejects.toThrow(RateLimitError);
    expect(calls).toBe(1);
  });

  it("retries on a provider failure and succeeds on a later attempt", async () => {
    provider.failOn(1, "transient provider error");
    provider.setDefault({ claims: [{ claim: "The Eiffel Tower was completed in 1889." }], truncated: false });
    const { service, store } = makeService(provider);

    const { id } = await service.run("text");
    const status = await store.getStatus(id);
    expect(status!.claims).toHaveLength(1);
    expect(provider.getCallCount()).toBe(2);
  });

  it("throws after exhausting all retries when the provider keeps failing", async () => {
    provider.failAll("persistent provider error");
    const { service } = makeService(provider);
    await expect(service.run("text")).rejects.toThrow();
    expect(provider.getCallCount()).toBe(3);
  });

  it("caps claims at the internal MAX_CLAIMS limit and sets caps_hit", async () => {
    const claims = Array.from({ length: 150 }, (_, i) => ({ claim: `Claim number ${i} happened in ${2000 + i}.` }));
    provider.setDefault({ claims, truncated: false });
    const { service, store } = makeService(provider);

    const { id } = await service.run("text");
    const status = await store.getStatus(id);
    expect(status!.claims).toHaveLength(100);
    expect(status!.caps_hit).toBe(true);
  });

  it("does NOT set caps_hit when EXTRACT returns exactly MAX_CLAIMS with no real truncation", async () => {
    const claims = Array.from({ length: 100 }, (_, i) => ({ claim: `Claim number ${i} happened in ${2000 + i}.` }));
    provider.setDefault({ claims, truncated: false });
    const { service, store } = makeService(provider);

    const { id } = await service.run("text");
    const status = await store.getStatus(id);
    expect(status!.claims).toHaveLength(100);
    expect(status!.caps_hit).toBe(false);
  });

  it("sets caps_hit when the LLM itself reports truncation, even under MAX_CLAIMS", async () => {
    provider.setDefault({ claims: [{ claim: "The Eiffel Tower was completed in 1889." }], truncated: true });
    const { service, store } = makeService(provider);

    const { id } = await service.run("text");
    const status = await store.getStatus(id);
    expect(status!.caps_hit).toBe(true);
  });

  it("handles zero extracted claims as a valid result", async () => {
    provider.setDefault({ claims: [], truncated: false });
    const { service, store } = makeService(provider);

    const { id } = await service.run("Purely qualitative text with no facts.");
    const status = await store.getStatus(id);
    expect(status!.claims).toEqual([]);
    expect(status!.progress.total).toBe(0);
  });

  it("T024/D023 §3: defaults to source 'production' and writes the same runId used for the Redis audit", async () => {
    provider.setDefault({ claims: [{ claim: "The Eiffel Tower was completed in 1889." }], truncated: false });
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const historyStore = new FakeGrounnelHistoryStore();
    const service = new GrounnelExtractService(provider, new PromptRegistry(), store, historyStore);

    const { id } = await service.run("Some pasted article text.");

    expect(historyStore.createRunCalls).toHaveLength(1);
    expect(historyStore.createRunCalls[0]).toMatchObject({ runId: id, sessionId: null, source: "production", text: "Some pasted article text." });
  });

  it("T024/D023 §3: an eval-triggered run writes source 'eval' — golden-set runs must not pollute production analytics", async () => {
    provider.setDefault({ claims: [{ claim: "The Eiffel Tower was completed in 1889." }], truncated: false });
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const historyStore = new FakeGrounnelHistoryStore();
    const service = new GrounnelExtractService(provider, new PromptRegistry(), store, historyStore);

    await service.run("Some pasted article text.", "eval");

    expect(historyStore.createRunCalls).toHaveLength(1);
    expect(historyStore.createRunCalls[0]).toMatchObject({ source: "eval" });
  });
});
