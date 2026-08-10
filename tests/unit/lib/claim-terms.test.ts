import { describe, it, expect } from "vitest";
import { extractKeyTerms, scoreKeyTermMatches } from "../../../src/lib/claim-terms.js";

describe("claim-terms (D026 §6, T039) — shared scorer for gate #4 and candidate ranking", () => {
  it("scores a candidate containing the claim's specific number higher than one that's merely topical", () => {
    const claim = "Apple's market capitalization surpassed $3.5 trillion in 2024.";
    const terms = extractKeyTerms(claim);
    const numericMatch = "Apple's market cap crossed $3.5 trillion for the first time in 2024, according to filings.";
    const topicalOnly = "Apple released several new products in 2024, including updated iPads.";
    expect(scoreKeyTermMatches(terms, numericMatch)).toBeGreaterThan(scoreKeyTermMatches(terms, topicalOnly));
  });

  it("returns 0 for a candidate matching none of the claim's key terms", () => {
    const terms = extractKeyTerms("The Eiffel Tower was completed in 1889.");
    expect(scoreKeyTermMatches(terms, "The Great Wall of China spans thousands of miles.")).toBe(0);
  });

  it("returns the count of distinct matched terms, not a boolean", () => {
    const terms = extractKeyTerms("The Eiffel Tower was completed in 1889.");
    expect(scoreKeyTermMatches(terms, "The Eiffel Tower, completed in 1889, is in Paris.")).toBe(terms.length);
  });
});
