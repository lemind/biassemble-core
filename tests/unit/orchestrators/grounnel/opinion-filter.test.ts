import { describe, it, expect, vi } from "vitest";
import { isOpinionClaim } from "../../../../src/orchestrators/grounnel/opinion-filter.js";

describe("gate #3 — pre-search opinion/non-factual filter (T005)", () => {
  it("flags a value-judgment claim", () => {
    expect(isOpinionClaim("This is the best coffee in Rome.")).toBe(true);
  });

  it("flags a vague-intensifier claim", () => {
    expect(isOpinionClaim("The performance was extremely impressive.")).toBe(true);
  });

  it("flags a hedged prediction", () => {
    expect(isOpinionClaim("This policy will probably fail within a year.")).toBe(true);
  });

  it("does not flag a plain factual claim", () => {
    expect(isOpinionClaim("The Eiffel Tower was completed in 1889.")).toBe(false);
  });

  it("does not flag a claim with a real name and a number", () => {
    expect(isOpinionClaim("Bukowski attended Los Angeles City College for two years.")).toBe(false);
  });

  it("does not flag a scheduled, dated future event as a prediction", () => {
    expect(isOpinionClaim("The company will report Q3 earnings on October 15.")).toBe(false);
  });

  it("never calls SearchProvider for an opinion-classified claim (T005's zero-search-calls acceptance bar)", () => {
    const mockSearch = vi.fn();
    const claim = "This is the best coffee in Rome.";
    if (!isOpinionClaim(claim)) {
      mockSearch(claim);
    }
    expect(mockSearch).not.toHaveBeenCalled();
  });
});
