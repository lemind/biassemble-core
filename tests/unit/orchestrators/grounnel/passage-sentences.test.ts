import { describe, it, expect } from "vitest";
import { splitIntoSentences, buildPassageSentences, resolveEvidenceFromSentenceIds } from "../../../../src/orchestrators/grounnel/passage-sentences.js";

describe("splitIntoSentences (D026 §7, T043)", () => {
  it("splits on sentence-ending punctuation followed by a new sentence", () => {
    expect(splitIntoSentences("France gave the statue. It was unveiled in 1886.")).toEqual(["France gave the statue.", "It was unveiled in 1886."]);
  });

  it("drops empty fragments from leading/trailing whitespace or repeated punctuation", () => {
    expect(splitIntoSentences("  One sentence.   ")).toEqual(["One sentence."]);
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

describe("resolveEvidenceFromSentenceIds (D026 §7, T043)", () => {
  const sentences = [
    { n: 1, text: "France gave the statue." },
    { n: 2, text: "It was unveiled in 1886." },
  ];

  it("returns null for a null/undefined/empty id list", () => {
    expect(resolveEvidenceFromSentenceIds(null, sentences)).toBeNull();
    expect(resolveEvidenceFromSentenceIds(undefined, sentences)).toBeNull();
    expect(resolveEvidenceFromSentenceIds([], sentences)).toBeNull();
  });

  it("resolves a single valid id to its real sentence text", () => {
    expect(resolveEvidenceFromSentenceIds([1], sentences)).toBe("France gave the statue.");
  });

  it("joins multiple valid ids with the existing '...' multi-excerpt convention", () => {
    expect(resolveEvidenceFromSentenceIds([1, 2], sentences)).toBe("France gave the statue. ... It was unveiled in 1886.");
  });

  it("nulls out the WHOLE answer when any id is out of range, rather than trusting a partial match", () => {
    expect(resolveEvidenceFromSentenceIds([1, 999], sentences)).toBeNull();
    expect(resolveEvidenceFromSentenceIds([999], sentences)).toBeNull();
  });
});
