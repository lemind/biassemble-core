import { describe, it, expect } from "vitest";
import { hasSubjectEntity, isPassageRelevant } from "../../../../src/orchestrators/grounnel/passage-filter.js";

describe("gate #4 — passage relevance pre-filter (T006)", () => {
  it("drops a passage missing the claim's key entity", () => {
    const claim = "The Eiffel Tower was completed in 1889.";
    const passage = "The Great Wall of China spans thousands of miles.";
    expect(isPassageRelevant(claim, passage)).toBe(false);
  });

  it("keeps a passage containing the claim's key entity", () => {
    const claim = "The Eiffel Tower was completed in 1889.";
    const passage = "Construction of the Eiffel Tower finished ahead of the World's Fair.";
    expect(isPassageRelevant(claim, passage)).toBe(true);
  });

  it("keeps a passage containing the claim's number even without matching the entity name", () => {
    const claim = "UC Riverside received a $350,000 grant.";
    const passage = "The award, worth $350,000, will fund the project over three years.";
    expect(isPassageRelevant(claim, passage)).toBe(true);
  });

  it("does not drop a claim with no extractable key terms — fails open, nothing to check", () => {
    // D026 §21 — extractKeyTerms now falls back to stopword-filtered common nouns/adjectives when
    // there's no entity/number, so a genuinely empty term set needs an all-stopword claim to test.
    const claim = "It was there before that.";
    const passage = "completely unrelated text";
    expect(isPassageRelevant(claim, passage)).toBe(true);
  });

  it("still extracts the claim's subject when it's the first word, not just a common sentence-starter", () => {
    const claim = "Shakespeare wrote sonnets.";
    const relevant = "Shakespeare was a prolific poet as well as a playwright.";
    const unrelated = "The weather in London was mild that spring.";
    expect(isPassageRelevant(claim, relevant)).toBe(true);
    expect(isPassageRelevant(claim, unrelated)).toBe(false);
  });

  // D019 §2's named, open gap — no fix designed yet. Visible in every run's summary as pending,
  // not silently passing or failing (never promote without a real fix — see D019 §2).
  it.todo("passage filter drops valid pronoun-only evidence — D019 §2, no fix designed yet");
});

describe("code-enforced entity anchor (g17)", () => {
  it("drops the real g17 repro: a passage that shares the claim's number but is about a different entity", () => {
    const subjectEntity = "Marwick";
    const passage = "Prof Foster believes Mr Gray's repair work resulted in as many as 34 numbered fragments of the original stone.";
    expect(hasSubjectEntity(subjectEntity, passage)).toBe(false);
  });

  it("keeps a passage that actually mentions the subject entity", () => {
    const subjectEntity = "Marwick";
    const passage = "Marwick's field notes describe three layers of pottery deposits.";
    expect(hasSubjectEntity(subjectEntity, passage)).toBe(true);
  });

  it("matches on a surname alone even when subjectEntity is a fuller form", () => {
    const subjectEntity = "Helen Marwick";
    const passage = "Marwick led the 1924 excavation at Larkspur Hill.";
    expect(hasSubjectEntity(subjectEntity, passage)).toBe(true);
  });

  it("no-ops (returns true) on an empty subjectEntity — claim genuinely names no distinguishing entity", () => {
    const passage = "completely unrelated text";
    expect(hasSubjectEntity("", passage)).toBe(true);
  });

  it("no-ops (returns true) on an undefined subjectEntity — pre-g17 fixtures/callers degrade instead of throwing", () => {
    const passage = "completely unrelated text";
    // @ts-expect-error — exercising the runtime guard for callers that predate this required field.
    expect(hasSubjectEntity(undefined, passage)).toBe(true);
  });
});
