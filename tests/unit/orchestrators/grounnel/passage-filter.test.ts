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

describe("gate #4 — instance-selector rescue (D030 §3f, g17-wright-brothers-ordinal root cause)", () => {
  it("g17 real repro: admits the refuting sentence for the correct instance even though it shares no key term with the claim", () => {
    // extractKeyTerms("The first flight covered 852 feet.") === ["852"] — this sentence names the
    // real first flight's distance (120ft, not 852), so without the selector rescue this is
    // exactly the sentence that gets dropped, leaving only confirming (wrong-instance) evidence.
    const claim = "The first flight covered 852 feet.";
    const passage = "Orville Wright piloted the first flight, which covered 120 feet in 12 seconds.";
    expect(isPassageRelevant(claim, passage)).toBe(true);
  });

  it("still keeps admitting a passage that matches on the key term alone (unrelated instance, same number)", () => {
    const claim = "The first flight covered 852 feet.";
    const passage = "The fourth and final flight covered 852 feet and lasted 59 seconds.";
    expect(isPassageRelevant(claim, passage)).toBe(true);
  });

  it("still drops a passage about neither the claim's number nor its instance", () => {
    const claim = "The first flight covered 852 feet.";
    const passage = "The second flight covered approximately 175 feet.";
    expect(isPassageRelevant(claim, passage)).toBe(false);
  });

  it("a ranking descriptor ('longest') gets no selector rescue — ordinary key-term filtering only, unchanged from before D030 §3f", () => {
    const claim = "The longest flight covered 852 feet.";
    const passage = "Orville Wright piloted the first flight, which covered 120 feet in 12 seconds.";
    expect(isPassageRelevant(claim, passage)).toBe(false);
  });

  it("does not over-admit on a calendar-period 'first' that isn't a repeated-entity instance", () => {
    const claim = "The first quarter of 2024 saw revenue growth.";
    // Shares no key term (no proper noun/number) and no real selector+anchor overlap with a
    // passage about an unrelated "first" of something else — must not spuriously admit.
    const passage = "She finished first in the marathon last year.";
    expect(isPassageRelevant(claim, passage)).toBe(false);
  });

  it("ordinary numeric retrieval (no selector in the claim at all) is unaffected", () => {
    const claim = "Apple's market capitalization surpassed $3.5 trillion in 2024.";
    const passage = "Apple's market cap crossed $3.5 trillion for the first time in 2024, according to filings.";
    expect(isPassageRelevant(claim, passage)).toBe(true);
  });
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
