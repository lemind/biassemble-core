import { describe, it, expect } from "vitest";
import {
  INPUT_DUPLICATE_THRESHOLD,
  inputDuplicateScore,
  isInputDuplicate,
  shingles,
} from "../../../../src/orchestrators/grounnel/input-duplicate.js";

const ARTICLE = [
  "Federal debt tops forty trillion dollars, adding to investor concern over fiscal deterioration.",
  "Investors demand higher compensation for holding long dated government securities this quarter.",
  "The change in the market structure has made Treasury bonds more vulnerable to supply shocks.",
  "Those shifts in who acts as the marginal buyer have increased the price sensitivity of yields.",
  "Corporate profits from companies in the benchmark index soared in the second quarter of the year.",
].join(" ");

const INDEPENDENT = [
  "Vanguard research suggests investors should hold a diversified portfolio across asset classes.",
  "Bond duration measures sensitivity to interest rate movements and varies widely by instrument.",
  "Advisors often recommend rebalancing annually rather than reacting to short term volatility.",
  "Historical returns are not a guarantee of future performance in any market environment at all.",
].join(" ");

describe("shingles", () => {
  it("produces 5-word sequences", () => {
    expect([...shingles("one two three four five six")]).toEqual([
      "one two three four five",
      "two three four five six",
    ]);
  });

  it("normalizes case and typographic punctuation", () => {
    const a = shingles("The Market — It Changed Sharply This Year, Analysts Said");
    const b = shingles("the market it changed sharply this year analysts said");
    expect([...a]).toEqual([...b]);
  });

  // Known limitation, accepted: every punctuation mark is a separator, so "U.S." tokenizes as two
  // words and never matches "US", and "market's" becomes "market s". Harmless at document scale —
  // a handful of shingles cannot move a score across the 0.5 threshold.
  it("splits abbreviations and possessives rather than folding them", () => {
    expect([...shingles("The U.S. fiscal picture is deteriorating")]).not.toEqual(
      [...shingles("the us fiscal picture is deteriorating")],
    );
    expect([...shingles("the market's structure changed a lot")]).not.toEqual(
      [...shingles("the markets structure changed a lot")],
    );
  });

  it("returns empty for text shorter than the shingle width", () => {
    expect(shingles("one two three four").size).toBe(0);
  });
});

describe("inputDuplicateScore", () => {
  it("scores a verbatim republication at 1.0", () => {
    expect(inputDuplicateScore(ARTICLE, ARTICLE)).toBe(1);
  });

  it("scores a wholly independent page at 0", () => {
    expect(inputDuplicateScore(INDEPENDENT, ARTICLE)).toBe(0);
  });

  it("scores a page that quotes one sentence low, not high", () => {
    const quoting = `${INDEPENDENT} As one report put it, ${ARTICLE.split(". ")[2]}. Analysts disagree on the cause.`;
    expect(inputDuplicateScore(quoting, ARTICLE)).toBeLessThan(INPUT_DUPLICATE_THRESHOLD);
  });

  it("scores a truncated republication high — the metric is page-relative, not input-relative", () => {
    // Half the article, i.e. what a capped excerpt of a syndicated copy looks like.
    const half = ARTICLE.slice(0, Math.floor(ARTICLE.length / 2));
    // Not exactly 1.0: the slice cuts mid-word, so the boundary shingle has no counterpart.
    expect(inputDuplicateScore(half, ARTICLE)).toBeGreaterThan(0.95);
  });

  it("is not symmetric — a long input quoting a short page is not a duplicate page", () => {
    const shortPage = "Analysts disagree sharply about the underlying cause of the recent move.";
    const inputQuoting = `${ARTICLE} ${shortPage}`;
    // The page is fully inside the input, but the page is too short to identify a document.
    expect(inputDuplicateScore(shortPage, inputQuoting)).toBe(0);
  });

  it("returns 0 when the page is too short to identify a document", () => {
    expect(inputDuplicateScore("Federal debt tops forty trillion dollars today.", ARTICLE)).toBe(0);
  });

  it("returns 0 when the input is too short to identify a document", () => {
    expect(inputDuplicateScore(ARTICLE, "Federal debt tops forty trillion.")).toBe(0);
  });

  it("returns 0 for empty strings on either side", () => {
    expect(inputDuplicateScore("", ARTICLE)).toBe(0);
    expect(inputDuplicateScore(ARTICLE, "")).toBe(0);
  });

  it("ignores whitespace and line-break differences between the two copies", () => {
    const reflowed = ARTICLE.replace(/ /g, "\n  ");
    expect(inputDuplicateScore(reflowed, ARTICLE)).toBe(1);
  });
});

describe("isInputDuplicate", () => {
  it("fires on a verbatim republication", () => {
    expect(isInputDuplicate(ARTICLE, ARTICLE)).toBe(true);
  });

  it("does not fire on an independent source", () => {
    expect(isInputDuplicate(INDEPENDENT, ARTICLE)).toBe(false);
  });

  it("does not fire on a page that merely shares a quotation", () => {
    const quoting = `${INDEPENDENT} As one report put it, ${ARTICLE.split(". ")[2]}.`;
    expect(isInputDuplicate(quoting, ARTICLE)).toBe(false);
  });

  it("respects an explicit threshold override", () => {
    const quoting = `${INDEPENDENT} ${ARTICLE.split(". ")[2]}.`;
    expect(isInputDuplicate(quoting, ARTICLE, 0.01)).toBe(true);
    expect(isInputDuplicate(quoting, ARTICLE, 0.99)).toBe(false);
  });

  it("uses 0.5 as the default threshold, the band the simulation returned", () => {
    expect(INPUT_DUPLICATE_THRESHOLD).toBe(0.5);
  });
});
