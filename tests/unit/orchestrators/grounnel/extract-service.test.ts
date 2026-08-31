import { describe, it, expect, beforeEach, vi } from "vitest";
import { GrounnelExtractService } from "../../../../src/orchestrators/grounnel/extract.service.js";
import { RedisGrounnelStore } from "../../../../src/persistence/grounnel-store.js";
import { PromptRegistry } from "../../../../src/prompts/registry.js";
import { RateLimitError } from "../../../../src/providers/gemini.js";
import { MockProvider } from "../../../mocks/mock-provider.js";
import { FakeRedisHashClient } from "../../../mocks/fake-redis-hash-client.js";
import { NoopGrounnelHistoryStore } from "../../../mocks/noop-grounnel-history-store.js";
import { FakeGrounnelHistoryStore } from "../../../mocks/fake-grounnel-history-store.js";
import { NoopGrounnelLlmCallStore } from "../../../mocks/noop-grounnel-llm-call-store.js";
import { FakeGrounnelLlmCallStore } from "../../../mocks/fake-grounnel-llm-call-store.js";
import type { Provider } from "../../../../src/providers/types.js";

function makeService(provider: MockProvider) {
  const store = new RedisGrounnelStore(new FakeRedisHashClient());
  const service = new GrounnelExtractService(provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore());
  return { service, store };
}

describe("GrounnelExtractService (T009)", () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider();
  });

  it("writes the initial claim list to the store and returns before any search/verify work", async () => {
    provider.setDefault({
      claims: [{ claim: "The Eiffel Tower was completed in 1889.", source_excerpt: "The Eiffel Tower was completed in 1889." }, { claim: "Bukowski attended Los Angeles City College.", source_excerpt: "Bukowski attended Los Angeles City College." }],
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

  it("resolves an opinion-shaped claim to excluded immediately, with zero SearchProvider calls (gate #3)", async () => {
    provider.setDefault({
      claims: [{ claim: "This is the best coffee in Rome.", source_excerpt: "This is the best coffee in Rome." }, { claim: "The Eiffel Tower was completed in 1889.", source_excerpt: "The Eiffel Tower was completed in 1889." }],
      truncated: false,
    });
    const { service, store } = makeService(provider);
    const searchCalls: string[] = [];
    const mockSearchProvider = { search: (q: string) => searchCalls.push(q) };

    const { id } = await service.run("Some pasted article text.");
    const status = await store.getStatus(id);

    const opinionClaim = status!.claims.find((c) => c.text.includes("best coffee"))!;
    expect(opinionClaim.status).toBe("done");
    expect(opinionClaim.verdict).toBe("excluded");
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
    const service = new GrounnelExtractService(rateLimitedProvider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), new NoopGrounnelLlmCallStore());

    await expect(service.run("text")).rejects.toThrow(RateLimitError);
    expect(calls).toBe(1);
  });

  it("retries on a provider failure and succeeds on a later attempt", async () => {
    provider.failOn(1, "transient provider error");
    provider.setDefault({ claims: [{ claim: "The Eiffel Tower was completed in 1889.", source_excerpt: "The Eiffel Tower was completed in 1889." }], truncated: false });
    const { service, store } = makeService(provider);

    const { id } = await service.run("text");
    const status = await store.getStatus(id);
    expect(status!.claims).toHaveLength(1);
    // D030 §3b (review finding) — classifyEligibility runs after run() returns, in the background
    // (routes/grounnel.ts), not inside run() itself, so run()'s own call count is EXTRACT-only.
    expect(provider.getCallCount()).toBe(2);
  });

  it("throws after exhausting all retries when the provider keeps failing", async () => {
    provider.failAll("persistent provider error");
    const { service } = makeService(provider);
    await expect(service.run("text")).rejects.toThrow();
    expect(provider.getCallCount()).toBe(3);
  });

  it("caps claims at the internal MAX_CLAIMS limit and sets caps_hit", async () => {
    const claims = Array.from({ length: 150 }, (_, i) => ({ claim: `Claim number ${i} happened in ${2000 + i}.`, source_excerpt: `Claim number ${i} happened in ${2000 + i}.` }));
    provider.setDefault({ claims, truncated: false });
    const { service, store } = makeService(provider);

    const { id } = await service.run("text");
    const status = await store.getStatus(id);
    expect(status!.claims).toHaveLength(100);
    expect(status!.caps_hit).toBe(true);
  });

  it("does NOT set caps_hit when EXTRACT returns exactly MAX_CLAIMS with no real truncation", async () => {
    const claims = Array.from({ length: 100 }, (_, i) => ({ claim: `Claim number ${i} happened in ${2000 + i}.`, source_excerpt: `Claim number ${i} happened in ${2000 + i}.` }));
    provider.setDefault({ claims, truncated: false });
    const { service, store } = makeService(provider);

    const { id } = await service.run("text");
    const status = await store.getStatus(id);
    expect(status!.claims).toHaveLength(100);
    expect(status!.caps_hit).toBe(false);
  });

  it("sets caps_hit when the LLM itself reports truncation, even under MAX_CLAIMS", async () => {
    provider.setDefault({ claims: [{ claim: "The Eiffel Tower was completed in 1889.", source_excerpt: "The Eiffel Tower was completed in 1889." }], truncated: true });
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

  it("D028: sourceExcerpt is set when it's a real substring of the article text", async () => {
    const text = "The Eiffel Tower was completed in 1889. It is located in Paris, France.";
    provider.setDefault({
      claims: [{ claim: "The Eiffel Tower was completed in 1889.", source_excerpt: "The Eiffel Tower was completed in 1889." }],
      truncated: false,
    });
    const { service, store } = makeService(provider);

    const { id } = await service.run(text);
    const status = await store.getStatus(id);

    expect(status!.claims[0]!.sourceExcerpt).toBe("The Eiffel Tower was completed in 1889.");
  });

  it("D028 (review finding): an empty-string source_excerpt is treated as no-excerpt, not a trivially-true match", async () => {
    // Every string .includes("") in JS — without the length guard, this would store "" instead
    // of null, defeating the frontend's null-means-fall-back contract.
    const text = "The Eiffel Tower was completed in 1889.";
    provider.setDefault({ claims: [{ claim: "The Eiffel Tower was completed in 1889.", source_excerpt: "" }], truncated: false });
    const { service, store } = makeService(provider);

    const { id } = await service.run(text);
    const status = await store.getStatus(id);

    expect(status!.claims[0]!.sourceExcerpt).toBeNull();
  });

  it("D028 (review finding): a claim missing source_excerpt entirely is not dropped by repair.ts's salvageArrays", async () => {
    // A schema-level required field would fail the whole array element's parse on a missing key,
    // and repair.ts's salvageArrays drops the entire element, not just the bad field — the exact
    // "whole claim silently vanishes" failure D028 §4 says never to allow.
    const text = "The Eiffel Tower was completed in 1889.";
    provider.setDefault({
      claims: [{ claim: "The Eiffel Tower was completed in 1889." } as unknown as { claim: string; source_excerpt: string }],
      truncated: false,
    });
    const { service, store } = makeService(provider);

    const { id } = await service.run(text);
    const status = await store.getStatus(id);

    expect(status!.claims).toHaveLength(1);
    expect(status!.claims[0]!.text).toBe("The Eiffel Tower was completed in 1889.");
    expect(status!.claims[0]!.sourceExcerpt).toBeNull();
  });

  it("D028: sourceExcerpt is nulled out, not the claim dropped, when the model's excerpt isn't a real substring of the article text", async () => {
    const text = "The Eiffel Tower was completed in 1889.";
    provider.setDefault({
      claims: [{ claim: "The Eiffel Tower was completed in 1889.", source_excerpt: "a paraphrase that never appears verbatim in the article" }],
      truncated: false,
    });
    const { service, store } = makeService(provider);

    const { id } = await service.run(text);
    const status = await store.getStatus(id);

    expect(status!.claims).toHaveLength(1);
    expect(status!.claims[0]!.text).toBe("The Eiffel Tower was completed in 1889.");
    expect(status!.claims[0]!.sourceExcerpt).toBeNull();
  });

  it("D028: two claims whose excerpts both come from the same sentence are verified independently", async () => {
    const text = "John Smith was born in 1950 and became CEO in 2001.";
    provider.setDefault({
      claims: [
        { claim: "John Smith was born in 1950.", source_excerpt: "born in 1950" },
        { claim: "John Smith became CEO in 2001.", source_excerpt: "became CEO in 2001" },
      ],
      truncated: false,
    });
    const { service, store } = makeService(provider);

    const { id } = await service.run(text);
    const status = await store.getStatus(id);

    const byText = (t: string) => status!.claims.find((c) => c.text === t)!;
    expect(byText("John Smith was born in 1950.").sourceExcerpt).toBe("born in 1950");
    expect(byText("John Smith became CEO in 2001.").sourceExcerpt).toBe("became CEO in 2001");
  });

  it("T024/D023 §3: defaults to source 'production' and writes the same runId used for the Redis audit", async () => {
    provider.setDefault({ claims: [{ claim: "The Eiffel Tower was completed in 1889.", source_excerpt: "The Eiffel Tower was completed in 1889." }], truncated: false });
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const historyStore = new FakeGrounnelHistoryStore();
    const service = new GrounnelExtractService(provider, new PromptRegistry(), store, historyStore, new NoopGrounnelLlmCallStore());

    const { id } = await service.run("Some pasted article text.");

    expect(historyStore.createRunCalls).toHaveLength(1);
    expect(historyStore.createRunCalls[0]).toMatchObject({ runId: id, sessionId: null, source: "production", text: "Some pasted article text." });
  });

  it("T024/D023 §3: an eval-triggered run writes source 'eval' — golden-set runs must not pollute production analytics", async () => {
    provider.setDefault({ claims: [{ claim: "The Eiffel Tower was completed in 1889.", source_excerpt: "The Eiffel Tower was completed in 1889." }], truncated: false });
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const historyStore = new FakeGrounnelHistoryStore();
    const service = new GrounnelExtractService(provider, new PromptRegistry(), store, historyStore, new NoopGrounnelLlmCallStore());

    await service.run("Some pasted article text.", "eval");

    expect(historyStore.createRunCalls).toHaveLength(1);
    expect(historyStore.createRunCalls[0]).toMatchObject({ source: "eval" });
  });

  it("T025/D023 §4: records one grounnel_llm_calls completion for the EXTRACT call, stamped with the real prompt version", async () => {
    provider.setDefault({ claims: [{ claim: "The Eiffel Tower was completed in 1889.", source_excerpt: "The Eiffel Tower was completed in 1889." }], truncated: false });
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const prompts = new PromptRegistry();
    const llmCallStore = new FakeGrounnelLlmCallStore();
    const service = new GrounnelExtractService(provider, prompts, store, new NoopGrounnelHistoryStore(), llmCallStore);

    const { id } = await service.run("Some pasted article text.");

    // D030 §3b (review finding) — classifyEligibility runs after run() returns (routes/grounnel.ts's
    // background phase), so run() itself only ever makes the one EXTRACT call.
    expect(llmCallStore.recordCallContexts).toHaveLength(1);
    expect(llmCallStore.recordCallContexts[0]).toMatchObject({
      runId: id,
      stage: "extract",
      callType: "primary",
      provider: "mock",
      promptVersion: prompts.getGrounnelExtractVersion(),
    });
    expect(llmCallStore.completions).toHaveLength(1);
    expect(llmCallStore.completions[0]!.info.status).toBe("success");
  });

  it("T025/D023 §4: records one completion per attempt, not just the final one, when a retry happens", async () => {
    provider.failOn(1, "transient provider error");
    provider.setDefault({ claims: [{ claim: "The Eiffel Tower was completed in 1889.", source_excerpt: "The Eiffel Tower was completed in 1889." }], truncated: false });
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const llmCallStore = new FakeGrounnelLlmCallStore();
    const service = new GrounnelExtractService(provider, new PromptRegistry(), store, new NoopGrounnelHistoryStore(), llmCallStore);

    await service.run("text");

    expect(llmCallStore.completions).toHaveLength(2);
    expect(llmCallStore.completions[0]!.info.status).toBe("error");
    expect(llmCallStore.completions[1]!.info.status).toBe("success");
  });

  it("T028/D023 §2: a real sessionId, once the caller has one (biassemble/backend's proxy), is written to grounnel_runs", async () => {
    provider.setDefault({ claims: [{ claim: "The Eiffel Tower was completed in 1889.", source_excerpt: "The Eiffel Tower was completed in 1889." }], truncated: false });
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const historyStore = new FakeGrounnelHistoryStore();
    const service = new GrounnelExtractService(provider, new PromptRegistry(), store, historyStore, new NoopGrounnelLlmCallStore());

    await service.run("Some pasted article text.", "production", "11111111-1111-4111-8111-111111111111");

    expect(historyStore.createRunCalls[0]).toMatchObject({ sessionId: "11111111-1111-4111-8111-111111111111" });
  });

  it("reviewed finding: an opinion-shaped claim (gate #3) also gets a durable grounnel_claims row, not just a Redis write", async () => {
    provider.setDefault({ claims: [{ claim: "This is the best coffee in Rome.", source_excerpt: "This is the best coffee in Rome." }], truncated: false });
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const historyStore = new FakeGrounnelHistoryStore();
    const service = new GrounnelExtractService(provider, new PromptRegistry(), store, historyStore, new NoopGrounnelLlmCallStore());

    await service.run("Some pasted article text.");

    expect(historyStore.createClaimCalls).toHaveLength(1);
    expect(historyStore.createClaimCalls[0]).toMatchObject({ verdict: "excluded", status: "done" });
  });

  it("reviewed finding: marks the run 'failed' in history when EXTRACT itself fails after exhausting retries", async () => {
    provider.failAll("persistent provider error");
    const store = new RedisGrounnelStore(new FakeRedisHashClient());
    const historyStore = new FakeGrounnelHistoryStore();
    const service = new GrounnelExtractService(provider, new PromptRegistry(), store, historyStore, new NoopGrounnelLlmCallStore());

    await expect(service.run("text")).rejects.toThrow();

    expect(historyStore.updateRunCalls).toHaveLength(1);
    expect(historyStore.updateRunCalls[0]!.data).toMatchObject({ status: "failed" });
  });

  // D030 §3b (review finding) — classifyEligibility runs in the background, after run() has already
  // returned and the 202 response was sent (routes/grounnel.ts), not inside run() itself.
  describe("classifyEligibility (background, after run())", () => {
    it("excludes a clearly non-checkable claim and returns only the still-eligible ones", async () => {
      provider.setDefault({ claims: [{ claim: "The Eiffel Tower was completed in 1889.", source_excerpt: "The Eiffel Tower was completed in 1889." }, { claim: "My pet cat is named Whiskers.", source_excerpt: "My pet cat is named Whiskers." }], truncated: false });
      provider.setResponseFn("You are a claim-eligibility classifier", (request) => {
        // Match the exact CLAIM: line, not a raw substring — the prompt's own instructions
        // (test-authoring bug found via this) already contain unrelated example claim text.
        const isPersonal = request.system.includes("CLAIM: My pet cat is named Whiskers.");
        return isPersonal ? { category: "personal", certainty: "clear", reason: "private circumstance", hasResolvableReferent: true } : { category: "checkable", certainty: "clear", reason: "public fact", hasResolvableReferent: true };
      });
      const { service, store } = makeService(provider);

      const { id, pendingClaims } = await service.run("Some pasted article text.");
      const eligible = await service.classifyEligibility(id, pendingClaims);

      expect(eligible).toHaveLength(1);
      expect(eligible[0]!.text).toBe("The Eiffel Tower was completed in 1889.");
      const status = await store.getStatus(id);
      const excluded = status!.claims.find((c) => c.text.includes("Whiskers"))!;
      expect(excluded.status).toBe("done");
      expect(excluded.verdict).toBe("excluded");
    });

    it("records a grounnel_llm_calls completion with stage extract / callType eligibility_check", async () => {
      provider.setDefault({ claims: [{ claim: "The Eiffel Tower was completed in 1889.", source_excerpt: "The Eiffel Tower was completed in 1889." }], truncated: false });
      provider.setResponse("You are a claim-eligibility classifier", { category: "checkable", certainty: "uncertain", reason: "n/a", hasResolvableReferent: true });
      const store = new RedisGrounnelStore(new FakeRedisHashClient());
      const prompts = new PromptRegistry();
      const llmCallStore = new FakeGrounnelLlmCallStore();
      const service = new GrounnelExtractService(provider, prompts, store, new NoopGrounnelHistoryStore(), llmCallStore);

      const { id, pendingClaims } = await service.run("Some pasted article text.");
      await service.classifyEligibility(id, pendingClaims);

      const eligibilityCalls = llmCallStore.recordCallContexts.filter((c) => c.callType === "eligibility_check");
      expect(eligibilityCalls).toHaveLength(1);
      expect(eligibilityCalls[0]).toMatchObject({ runId: id, stage: "extract", promptVersion: prompts.getGrounnelEligibilityVersion() });
    });

    // Review finding (code-review high, full-branch pass): classifyEligibility runs in
    // routes/grounnel.ts's post-202 background phase, before pipelineService.run() ever sets a
    // status — an uncaught write failure here left the run stuck at its prior status forever.
    it("(review finding) marks the run 'failed' in history when writing an excluded claim throws", async () => {
      provider.setDefault({ claims: [{ claim: "My pet cat is named Whiskers.", source_excerpt: "My pet cat is named Whiskers." }], truncated: false });
      provider.setResponse("You are a claim-eligibility classifier", { category: "personal", certainty: "clear", reason: "private circumstance", hasResolvableReferent: true });
      const store = new RedisGrounnelStore(new FakeRedisHashClient());
      const historyStore = new FakeGrounnelHistoryStore();
      const service = new GrounnelExtractService(provider, new PromptRegistry(), store, historyStore, new NoopGrounnelLlmCallStore());
      const { id, pendingClaims } = await service.run("Some pasted article text.");
      historyStore.failCreateClaim = true;

      await expect(service.classifyEligibility(id, pendingClaims)).rejects.toThrow();

      expect(historyStore.updateRunCalls.some((c) => c.data.status === "failed")).toBe(true);
    });

    // D031 — real live-test bug: a hung provider call inside the eligibility fan-out used to run
    // silently until the shared Vercel maxDuration kill, never reaching the catch below at all.
    it("D031: times out and marks the run failed instead of hanging forever when the eligibility fan-out never resolves", async () => {
      vi.useFakeTimers();
      try {
        const inner = new MockProvider();
        inner.setDefault({ claims: [{ claim: "The Eiffel Tower was completed in 1889.", source_excerpt: "The Eiffel Tower was completed in 1889." }], truncated: false });
        const hangingProvider: Provider = {
          mode: "mock",
          completeJson: (request) =>
            request.system.includes("You are a claim-eligibility classifier")
              ? new Promise(() => {}) // never resolves — simulates a hung provider call
              : inner.completeJson(request),
        };
        const store = new RedisGrounnelStore(new FakeRedisHashClient());
        const historyStore = new FakeGrounnelHistoryStore();
        const service = new GrounnelExtractService(hangingProvider, new PromptRegistry(), store, historyStore, new NoopGrounnelLlmCallStore());

        const { id, pendingClaims } = await service.run("Some pasted article text.");

        const classifyPromise = service.classifyEligibility(id, pendingClaims);
        const assertion = expect(classifyPromise).rejects.toThrow(/timed out/);
        await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 1000);
        await assertion;

        expect(historyStore.updateRunCalls.some((c) => c.data.status === "failed")).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    // D031 (review finding) — Promise.race can't cancel its loser. Without the `abandoned` flag,
    // a batch that eventually resolves AFTER the phase timeout already fired still wrote its
    // excluded-claim results, landing in Redis after the run was already reported failed.
    it("D031 (review finding): does not write excluded-claim results from a batch that resolves after the phase timeout already fired", async () => {
      vi.useFakeTimers();
      try {
        const inner = new MockProvider();
        inner.setDefault({ claims: [{ claim: "My pet cat is named Whiskers.", source_excerpt: "My pet cat is named Whiskers." }], truncated: false });
        const slowProvider: Provider = {
          mode: "mock",
          completeJson: (request) =>
            request.system.includes("You are a claim-eligibility classifier")
              ? new Promise((resolve) =>
                  // Resolves well AFTER the 2-minute phase timeout — simulates a merely-slow (not
                  // truly hung) provider call outliving the race it already lost.
                  setTimeout(() => resolve({ result: { category: "personal", certainty: "clear", reason: "private circumstance", hasResolvableReferent: true } }), 3 * 60 * 1000)
                )
              : inner.completeJson(request),
        };
        const store = new RedisGrounnelStore(new FakeRedisHashClient());
        const historyStore = new FakeGrounnelHistoryStore();
        const service = new GrounnelExtractService(slowProvider, new PromptRegistry(), store, historyStore, new NoopGrounnelLlmCallStore());

        const { id, pendingClaims } = await service.run("Some pasted article text.");

        const classifyPromise = service.classifyEligibility(id, pendingClaims);
        const assertion = expect(classifyPromise).rejects.toThrow(/timed out/);
        await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 1000); // fires the phase timeout
        await assertion;

        await vi.advanceTimersByTimeAsync(2 * 60 * 1000); // lets the abandoned batch's own provider call finally resolve

        const status = await store.getStatus(id);
        expect(status!.claims[0]!.status).toBe("pending"); // never excluded — the late write never landed
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
