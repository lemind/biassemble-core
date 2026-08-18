import { describe, it, expect } from "vitest";
import {
  splitIntoSentences,
  buildPassageSentences,
  buildPassageSentencesMulti,
  resolveEvidenceFromCitations,
} from "../../../../src/orchestrators/grounnel/passage-sentences.js";

describe("splitIntoSentences (D026 §7, T043)", () => {
  it("splits on sentence-ending punctuation followed by a new sentence", () => {
    expect(splitIntoSentences("France gave the statue. It was unveiled in 1886.")).toEqual(["France gave the statue.", "It was unveiled in 1886."]);
  });

  it("drops empty fragments from leading/trailing whitespace or repeated punctuation", () => {
    expect(splitIntoSentences("  One sentence.   ")).toEqual(["One sentence."]);
  });

  it("reviewed finding (g05-statue-of-liberty, T050): splits on a newline boundary even with no preceding punctuation — extractTextFromHtml inserts one at HTML block-tag edges", () => {
    expect(splitIntoSentences("Sign In Blog Categories\nThe statue was a gift from France.")).toEqual([
      "Sign In Blog Categories",
      "The statue was a gift from France.",
    ]);
  });
});

describe("buildPassageSentences (D026 §7, T043)", () => {
  it("numbers every sentence, starting at 1, when the passage is short", () => {
    const result = buildPassageSentences("The Eiffel Tower was completed in 1889.", "The Eiffel Tower opened in 1889. It is in Paris.");
    expect(result).toEqual([
      { n: 1, text: "The Eiffel Tower opened in 1889." },
      { n: 2, text: "It is in Paris." },
    ]);
  });

  it("prefers claim-relevant sentences over irrelevant ones when the passage exceeds the cap", () => {
    const relevant = "The Eiffel Tower was completed in 1889 in Paris.";
    const filler = Array.from({ length: 25 }, (_, i) => `Filler sentence number ${i} about something unrelated.`);
    const passage = [...filler.slice(0, 10), relevant, ...filler.slice(10)].join(" ");
    const result = buildPassageSentences("The Eiffel Tower was completed in 1889.", passage, 5);
    expect(result.length).toBeLessThanOrEqual(5);
    expect(result.map((s) => s.text)).toContain(relevant);
  });

  it("preserves original passage order among the selected sentences, not score order", () => {
    const first = "The Eiffel Tower opened to the public in 1889.";
    const second = "The Eiffel Tower was designed by Gustave Eiffel.";
    const passage = `${first} ${second}`;
    const result = buildPassageSentences("The Eiffel Tower was completed in 1889.", passage, 5);
    expect(result.map((s) => s.text)).toEqual([first, second]);
  });

  it("fails open (keeps the first N sentences) when the claim has no extractable key terms", () => {
    const passage = "One thing happened. Another thing happened. A third thing happened.";
    const result = buildPassageSentences("the weather was nice that day", passage, 2);
    expect(result).toHaveLength(2);
    expect(result[0]!.n).toBe(1);
  });
});

describe("buildPassageSentencesMulti (D026 §11, T049)", () => {
  it("numbers each passage independently, grouped by source label", () => {
    const result = buildPassageSentencesMulti("Napoleon Bonaparte was five feet two inches tall.", [
      { label: "A", text: "Napoleon Bonaparte's height is often debated by historians." },
      { label: "B", text: "He is estimated to have been five feet two inches tall." },
    ]);
    expect(result["A"]).toEqual([{ n: 1, text: "Napoleon Bonaparte's height is often debated by historians." }]);
    expect(result["B"]).toEqual([{ n: 1, text: "He is estimated to have been five feet two inches tall." }]);
  });

  it("keeps each passage's own relevance-based selection unaffected by pooling", () => {
    const relevant = "The Eiffel Tower was completed in 1889 in Paris.";
    const filler = Array.from({ length: 25 }, (_, i) => `Filler sentence number ${i} about something unrelated.`);
    const passageA = [...filler.slice(0, 10), relevant, ...filler.slice(10)].join(" ");
    const result = buildPassageSentencesMulti("The Eiffel Tower was completed in 1889.", [{ label: "A", text: passageA }], 5);
    expect(result["A"]!.length).toBeLessThanOrEqual(5);
    expect(result["A"]!.map((s) => s.text)).toContain(relevant);
  });
});

describe("resolveEvidenceFromCitations (D026 §11, T049)", () => {
  const sentencesBySource = {
    A: [{ n: 1, text: "France gave the statue." }],
    B: [{ n: 1, text: "It was unveiled in 1886." }],
  };

  it("returns null evidence and no citations for a null/undefined/empty citation list", () => {
    expect(resolveEvidenceFromCitations(null, sentencesBySource)).toEqual({ evidence: null, citations: [] });
    expect(resolveEvidenceFromCitations(undefined, sentencesBySource)).toEqual({ evidence: null, citations: [] });
    expect(resolveEvidenceFromCitations([], sentencesBySource)).toEqual({ evidence: null, citations: [] });
  });

  it("resolves a single valid citation to its real sentence text and a matching structured citation", () => {
    const result = resolveEvidenceFromCitations([{ source: "A", n: 1 }], sentencesBySource);
    expect(result.evidence).toBe("France gave the statue.");
    expect(result.citations).toEqual([{ source: "A", sentence: 1, text: "France gave the statue." }]);
  });

  it("joins citations from DIFFERENT sources with the existing '...' multi-excerpt convention, and D027: keeps them as separate structured entries", () => {
    const result = resolveEvidenceFromCitations([{ source: "A", n: 1 }, { source: "B", n: 1 }], sentencesBySource);
    expect(result.evidence).toBe("France gave the statue. ... It was unveiled in 1886.");
    expect(result.citations).toEqual([
      { source: "A", sentence: 1, text: "France gave the statue." },
      { source: "B", sentence: 1, text: "It was unveiled in 1886." },
    ]);
  });

  it("D027: preserves citation order exactly, even out of source-alphabetical order", () => {
    const result = resolveEvidenceFromCitations([{ source: "B", n: 1 }, { source: "A", n: 1 }], sentencesBySource);
    expect(result.citations.map((c) => c.source)).toEqual(["B", "A"]);
  });

  it("D027: does not merge two citations from the same source into one entry", () => {
    const twoSentenceSource = { A: [{ n: 1, text: "First." }, { n: 2, text: "Second." }] };
    const result = resolveEvidenceFromCitations([{ source: "A", n: 1 }, { source: "A", n: 2 }], twoSentenceSource);
    expect(result.citations).toHaveLength(2);
    expect(result.citations).toEqual([
      { source: "A", sentence: 1, text: "First." },
      { source: "A", sentence: 2, text: "Second." },
    ]);
  });

  it("nulls out the WHOLE answer — evidence AND citations — when a citation names an unknown source label", () => {
    expect(resolveEvidenceFromCitations([{ source: "Z", n: 1 }], sentencesBySource)).toEqual({ evidence: null, citations: [] });
  });

  it("reviewed finding: a citation naming a JS Object prototype property doesn't resolve to inherited junk or throw", () => {
    // `source` is model output, parsed straight from JSON — a plain `sentencesBySource[source]`
    // lookup without a hasOwnProperty guard would return an inherited function/value here instead
    // of undefined, and `.find` on that would throw, taking down the whole VERIFY batch with it.
    for (const source of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(() => resolveEvidenceFromCitations([{ source, n: 1 }], sentencesBySource)).not.toThrow();
      expect(resolveEvidenceFromCitations([{ source, n: 1 }], sentencesBySource)).toEqual({ evidence: null, citations: [] });
    }
  });

  it("nulls out the WHOLE answer when a citation's n is out of range for its own (real) source", () => {
    expect(resolveEvidenceFromCitations([{ source: "A", n: 999 }], sentencesBySource)).toEqual({ evidence: null, citations: [] });
  });

  it("cannot resolve a citation to the wrong document's text even if n collides across sources — grounded per-source by construction", () => {
    // Both sources have an "n: 1" sentence, but they're different texts — citing {A, 1} must never
    // resolve to B's text or vice versa.
    const result = resolveEvidenceFromCitations([{ source: "A", n: 1 }], sentencesBySource);
    expect(result.evidence).not.toBe("It was unveiled in 1886.");
    expect(result.citations[0]!.text).not.toBe("It was unveiled in 1886.");
  });
});
