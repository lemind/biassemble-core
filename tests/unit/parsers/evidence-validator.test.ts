import { describe, it, expect } from "vitest";
import { validateEvidence } from "../../../src/parsers/evidence-validator.js";

describe("T502 — evidence-validator", () => {
  const story = "I went to the store yesterday and bought some milk. The cashier was friendly.";
  const answers = ["I felt happy about the interaction.", "The store was crowded."];

  it("should pass valid verbatim evidence from story", () => {
    const result = validateEvidence(
      { biases: [{ name: "confirmation bias", evidence: [{ source: "story" as const, excerpt: "I went to the store yesterday", relevance: "Shows the event" }] }] },
      { story, answers },
    );
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("should pass valid verbatim evidence from answers", () => {
    const result = validateEvidence(
      { biases: [{ name: "optimism bias", evidence: [{ source: "answer" as const, excerpt: "I felt happy about the interaction.", relevance: "Shows positive outlook" }] }] },
      { story, answers },
    );
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("should reject hallucinated excerpt not in story or answers", () => {
    const result = validateEvidence(
      { biases: [{ name: "confirmation bias", evidence: [{ source: "story" as const, excerpt: "I bought a car yesterday", relevance: "Shows purchase" }] }] },
      { story, answers },
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].biasName).toBe("confirmation bias");
    expect(result.violations[0].excerpt).toBe("I bought a car yesterday");
  });

  it("should reject empty excerpt", () => {
    const result = validateEvidence(
      { biases: [{ name: "confirmation bias", evidence: [{ source: "story" as const, excerpt: "", relevance: "Empty" }] }] },
      { story, answers },
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
  });

  it("should reject bias item with empty evidence array", () => {
    const result = validateEvidence(
      { biases: [{ name: "confirmation bias", evidence: [] }] },
      { story, answers },
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].biasName).toBe("confirmation bias");
  });

  it("should reject bias item with undefined evidence", () => {
    const result = validateEvidence(
      { biases: [{ name: "confirmation bias", evidence: undefined as any }] },
      { story, answers },
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
  });

  it("should report multiple violations across bias items", () => {
    const result = validateEvidence(
      {
        biases: [
          { name: "bias one", evidence: [{ source: "story" as const, excerpt: "I bought a car", relevance: "R1" }] },
          { name: "bias two", evidence: [{ source: "answer" as const, excerpt: "I felt angry", relevance: "R2" }] },
        ],
      },
      { story, answers },
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(2);
  });

  it("should be case-sensitive (verbatim requirement)", () => {
    const result = validateEvidence(
      { biases: [{ name: "case test", evidence: [{ source: "story" as const, excerpt: "i went to the store", relevance: "Case mismatch" }] }] },
      { story, answers },
    );
    expect(result.valid).toBe(false);
  });

  it("should handle mixed valid and invalid evidence in same bias item", () => {
    const result = validateEvidence(
      {
        biases: [{
          name: "mixed",
          evidence: [
            { source: "story" as const, excerpt: "I went to the store yesterday", relevance: "Valid" },
            { source: "story" as const, excerpt: "This is completely made up", relevance: "Invalid" },
          ],
        }],
      },
      { story, answers },
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
  });

  it("should pass when all evidence is valid across multiple bias items", () => {
    const result = validateEvidence(
      {
        biases: [
          {
            name: "bias one",
            evidence: [
              { source: "story" as const, excerpt: "I went to the store yesterday", relevance: "R1" },
              { source: "answer" as const, excerpt: "I felt happy about the interaction.", relevance: "R2" },
            ],
          },
          {
            name: "bias two",
            evidence: [{ source: "story" as const, excerpt: "The cashier was friendly.", relevance: "R3" }],
          },
        ],
      },
      { story, answers },
    );
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});