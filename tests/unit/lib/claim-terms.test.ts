import { describe, it, expect } from "vitest";
import { extractKeyTerms, scoreKeyTermMatches, buildSearchQuery } from "../../../src/lib/claim-terms.js";

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

describe("extractKeyTerms (D026 §21) — stopword fallback when the entity/number pass finds nothing", () => {
  it("real live-test bug: a claim built entirely from ordinary lowercase nouns/adjectives (no proper noun, no number) used to return zero terms, silently disabling every relevance-scoring consumer", () => {
    const terms = extractKeyTerms("The blue whale is the largest animal known to have ever existed.");
    expect(terms.length).toBeGreaterThan(0);
    expect(terms).toEqual(expect.arrayContaining(["blue", "whale", "largest", "animal"]));
  });

  it("a real sentence about the claim now clearly outscores a short fragment that merely repeats the subject (e.g. a page title/nav item) — the actual live-test finding", () => {
    const terms = extractKeyTerms("The blue whale is the largest animal known to have ever existed.");
    const realSentence = "The blue whale is the largest animal known to have ever existed, scientists say.";
    const titleFragment = "Blue whale - Wikipedia";
    expect(scoreKeyTermMatches(terms, realSentence)).toBeGreaterThan(scoreKeyTermMatches(terms, titleFragment));
  });

  it("keeps today's narrower entity/number-only term set unchanged when entities exist — doesn't broaden claims that already work", () => {
    // "Republic"/"Nauru" are still the whole term set (capitalized-entity classification), not
    // widened by the stopword fallback, since that fallback only fires when terms.length === 0.
    const terms = extractKeyTerms("The Republic of Nauru is the world's smallest island nation by population.");
    expect(terms).toEqual(["republic", "nauru"]);
  });

  it("still returns empty for a claim that's genuinely all stopwords — the fallback isn't unconditional", () => {
    expect(extractKeyTerms("It was there before that.")).toEqual([]);
  });
});

describe("buildSearchQuery (D026 §8, T046/T050) — deterministic stopword-dropping query, no LLM call", () => {
  it("drops function words, keeps content words in original case and order", () => {
    expect(buildSearchQuery("The Eiffel Tower was completed in 1889.")).toBe("Eiffel Tower completed 1889");
  });

  it("reviewed finding (g11-bloomberg-fallback): keeps ordinary topical nouns, not just entities/numbers", () => {
    expect(buildSearchQuery("Apple's market capitalization surpassed $3.5 trillion in 2024.")).toBe(
      "Apple's market capitalization surpassed $3.5 trillion 2024"
    );
  });

  it("keeps a claim's subject even when it's the first word", () => {
    expect(buildSearchQuery("Shakespeare wrote sonnets.")).toBe("Shakespeare wrote sonnets");
  });

  it("falls back to the raw claim text when nothing survives stopword removal — fail-open, same convention as isPassageRelevant", () => {
    expect(buildSearchQuery("it was that")).toBe("it was that");
  });

  it("deduplicates a repeated word, keeping only its first occurrence", () => {
    expect(buildSearchQuery("Apple's rivals said Apple's growth was strong.")).toBe("Apple's rivals said growth strong");
  });
});
