import { describe, it, expect } from "vitest";
import { isPassageRelevant } from "../../../../src/orchestrators/grounnel/passage-filter.js";

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

  it("does not drop a claim with no extractable entities/numbers — fails open, nothing to check", () => {
    const claim = "the weather was nice that day";
    const passage = "completely unrelated text";
    expect(isPassageRelevant(claim, passage)).toBe(true);
  });

  // D019 §2's named, open gap — no fix designed yet. Visible in every run's summary as pending,
  // not silently passing or failing (never promote without a real fix — see D019 §2).
  it.todo("passage filter drops valid pronoun-only evidence — D019 §2, no fix designed yet");
});
