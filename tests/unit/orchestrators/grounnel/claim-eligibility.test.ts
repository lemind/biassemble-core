import { describe, it, expect, beforeEach } from "vitest";
import { classifyClaimVerifiability, isEligibilityExcluded, eligibilityReason, type ClaimVerifiabilityResult } from "../../../../src/orchestrators/grounnel/claim-eligibility.js";
import { PromptRegistry } from "../../../../src/prompts/registry.js";
import { MockProvider } from "../../../mocks/mock-provider.js";
import { FakeGrounnelLlmCallStore } from "../../../mocks/fake-grounnel-llm-call-store.js";
import { TimeoutError } from "../../../../src/providers/types.js";
import { RateLimitError } from "../../../../src/providers/gemini.js";

// T011 (D030 tasks.md) — orchestration/wiring tests only, mocked provider. This proves the pipeline
// applies a given classification correctly and fails open on every error shape; it does NOT prove
// the model classifies real claims correctly — that's T016/T017's job (live/golden-set evaluation).
describe("classifyClaimVerifiability (T011)", () => {
  let provider: MockProvider;
  let prompts: PromptRegistry;
  let llmCallStore: FakeGrounnelLlmCallStore;

  beforeEach(() => {
    provider = new MockProvider();
    prompts = new PromptRegistry();
    llmCallStore = new FakeGrounnelLlmCallStore();
  });

  async function classify(claimText: string, sourceExcerpt: string | null) {
    return classifyClaimVerifiability(provider, prompts, llmCallStore, "run-1", "claim-1", { claimText, sourceExcerpt });
  }

  it("passes through a checkable classification unchanged", async () => {
    provider.setResponse("You are a claim-eligibility classifier", { category: "checkable", certainty: "clear", reason: "public figure's documented history", hasResolvableReferent: true });
    const result = await classify("I served as CEO from 2015 to 2020.", "the article's subject said: I served as CEO from 2015 to 2020.");
    expect(result).toEqual({ category: "checkable", certainty: "clear", reason: "public figure's documented history", hasResolvableReferent: true });
  });

  it("passes through a personal/clear classification unchanged", async () => {
    provider.setResponse("You are a claim-eligibility classifier", { category: "personal", certainty: "clear", reason: "private circumstance, no public record", hasResolvableReferent: true });
    const result = await classify("I was in need of a new laptop.", null);
    expect(result).toEqual({ category: "personal", certainty: "clear", reason: "private circumstance, no public record", hasResolvableReferent: true });
  });

  it("passes through an uncertain classification unchanged, regardless of category", async () => {
    provider.setResponse("You are a claim-eligibility classifier", { category: "personal", certainty: "uncertain", reason: "speaker's identity unclear", hasResolvableReferent: true });
    const result = await classify("I was born in 1987.", null);
    expect(result).toEqual({ category: "personal", certainty: "uncertain", reason: "speaker's identity unclear", hasResolvableReferent: true });
  });

  it("fails open on a malformed/schema-invalid response — treated as checkable, never excluded", async () => {
    // "category" isn't one of the enum values — every repair/retry attempt fails schema validation.
    provider.setResponse("You are a claim-eligibility classifier", { category: "not-a-real-category", certainty: "clear", reason: "bogus" });
    const result = await classify("Some claim.", null);
    expect(result.category).toBe("checkable");
    expect(isEligibilityExcluded(result)).toBe(false);
  });

  it("fails open on a provider error — treated as checkable, never excluded", async () => {
    provider.failAll("provider is down");
    const result = await classify("Some claim.", null);
    expect(result.category).toBe("checkable");
    expect(isEligibilityExcluded(result)).toBe(false);
  });

  it("fails open on a timeout — treated as checkable, never excluded", async () => {
    provider.setResponseFn("You are a claim-eligibility classifier", () => {
      throw new TimeoutError("provider call timed out");
    });
    const result = await classify("Some claim.", null);
    expect(result.category).toBe("checkable");
    expect(isEligibilityExcluded(result)).toBe(false);
  });

  it("fails open on a rate-limit error — treated as checkable, never excluded", async () => {
    provider.setResponseFn("You are a claim-eligibility classifier", () => {
      throw new RateLimitError("quota exhausted", "daily");
    });
    const result = await classify("Some claim.", null);
    expect(result.category).toBe("checkable");
    expect(isEligibilityExcluded(result)).toBe(false);
  });

  it("records a grounnel_llm_calls completion for a successful call", async () => {
    provider.setResponse("You are a claim-eligibility classifier", { category: "checkable", certainty: "uncertain", reason: "n/a", hasResolvableReferent: true });
    await classify("Some claim.", null);
    expect(llmCallStore.recordCallContexts).toHaveLength(1);
    expect(llmCallStore.recordCallContexts[0]).toMatchObject({ runId: "run-1", claimId: "claim-1", stage: "extract", callType: "eligibility_check" });
    expect(llmCallStore.completions[0]!.info.status).toBe("success");
  });

  it("records a grounnel_llm_calls completion even on fail-open (status reflects the real failure, not silently dropped)", async () => {
    provider.failAll("provider is down");
    await classify("Some claim.", null);
    expect(llmCallStore.completions.length).toBeGreaterThan(0);
    expect(llmCallStore.completions.every((c) => c.info.status !== "success")).toBe(true);
  });
});

// Policy table (data-model.md §2) — pure function, no I/O.
describe("isEligibilityExcluded (D030 §3b policy)", () => {
  it("never excludes category: checkable, regardless of certainty", () => {
    expect(isEligibilityExcluded({ category: "checkable", certainty: "clear", reason: "", hasResolvableReferent: true })).toBe(false);
    expect(isEligibilityExcluded({ category: "checkable", certainty: "uncertain", reason: "", hasResolvableReferent: true })).toBe(false);
  });

  it("excludes a non-checkable category only when certainty is clear", () => {
    expect(isEligibilityExcluded({ category: "personal", certainty: "clear", reason: "", hasResolvableReferent: true })).toBe(true);
    expect(isEligibilityExcluded({ category: "opinion", certainty: "clear", reason: "", hasResolvableReferent: true })).toBe(true);
    expect(isEligibilityExcluded({ category: "prediction", certainty: "clear", reason: "", hasResolvableReferent: true })).toBe(true);
  });

  it("does not exclude a non-checkable category when certainty is uncertain — defaults to search", () => {
    expect(isEligibilityExcluded({ category: "personal", certainty: "uncertain", reason: "", hasResolvableReferent: true })).toBe(false);
    expect(isEligibilityExcluded({ category: "opinion", certainty: "uncertain", reason: "", hasResolvableReferent: true })).toBe(false);
    expect(isEligibilityExcluded({ category: "prediction", certainty: "uncertain", reason: "", hasResolvableReferent: true })).toBe(false);
  });

  // Spec 013 T27 (D032 §13) — the referent axis is independent of the category/certainty axis above.
  it("excludes on a missing referent even when the claim is checkable/uncertain — D032 §13 Finding C", () => {
    expect(isEligibilityExcluded({ category: "checkable", certainty: "uncertain", reason: "", hasResolvableReferent: false })).toBe(true);
    expect(isEligibilityExcluded({ category: "checkable", certainty: "clear", reason: "", hasResolvableReferent: false })).toBe(true);
  });

  it("fails open when the referent field is absent or null — never a basis for exclusion", () => {
    // Guards the runtime path, not the type: repair.ts nulls an invalid field rather than throwing,
    // and inverting D030 §3b via a schema hiccup would turn one bad affirmation into mass exclusion.
    const absent = { category: "checkable", certainty: "uncertain", reason: "" } as unknown as ClaimVerifiabilityResult;
    const nulled = { category: "checkable", certainty: "uncertain", reason: "", hasResolvableReferent: null } as unknown as ClaimVerifiabilityResult;
    expect(isEligibilityExcluded(absent)).toBe(false);
    expect(isEligibilityExcluded(nulled)).toBe(false);
  });
});

// Spec 013 T27 — the referent exclusion fires with category "checkable", which the pre-T27
// category-only signature rendered as the unreachable "Not a checkable claim." string.
describe("eligibilityReason (T27 referent branch)", () => {
  it("explains a missing referent rather than falling through to the category text", () => {
    const reason = eligibilityReason({ category: "checkable", certainty: "uncertain", reason: "", hasResolvableReferent: false });
    expect(reason).toContain("who or what");
    expect(reason).not.toBe("Not a checkable claim.");
  });

  it("still returns the category text when a referent exists", () => {
    expect(eligibilityReason({ category: "opinion", certainty: "clear", reason: "", hasResolvableReferent: true })).toContain("subjective opinion");
    expect(eligibilityReason({ category: "personal", certainty: "clear", reason: "", hasResolvableReferent: true })).toContain("private, personal");
    expect(eligibilityReason({ category: "prediction", certainty: "clear", reason: "", hasResolvableReferent: true })).toContain("prediction about the future");
  });
});
