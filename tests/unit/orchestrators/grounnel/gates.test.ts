import { describe, it, expect } from "vitest";
import { applyContradictionEvidenceGate, applyNumericGate } from "../../../../src/orchestrators/grounnel/gates.js";

describe("gate #1 — contradiction evidence gate (T003)", () => {
  it("passes through non-contradicted verdicts unchanged", () => {
    const result = applyContradictionEvidenceGate({
      verdict: "supported",
      evidence: "anything",
      passageText: "some other text entirely",
    });
    expect(result).toEqual({ verdict: "supported", evidence: "anything" });
  });

  it("keeps a contradicted verdict whose evidence is a real substring of the passage", () => {
    const result = applyContradictionEvidenceGate({
      verdict: "contradicted",
      evidence: "attended Los Angeles City College",
      passageText: "Bukowski attended Los Angeles City College for two years.",
    });
    expect(result).toEqual({
      verdict: "contradicted",
      evidence: "attended Los Angeles City College",
    });
  });

  it("matches after whitespace/punctuation normalization, not exact byte-for-byte", () => {
    const result = applyContradictionEvidenceGate({
      verdict: "contradicted",
      evidence: "attended Los Angeles City College!",
      passageText: "  Bukowski   attended Los Angeles City College for two years.",
    });
    expect(result.verdict).toBe("contradicted");
  });

  it("downgrades to unsupported and nulls the evidence when evidence is absent from the passage", () => {
    const result = applyContradictionEvidenceGate({
      verdict: "contradicted",
      evidence: "attended Harvard University",
      passageText: "Bukowski attended Los Angeles City College for two years.",
    });
    expect(result).toEqual({ verdict: "unsupported", evidence: null });
  });

  it("downgrades a contradicted verdict with null evidence", () => {
    const result = applyContradictionEvidenceGate({
      verdict: "contradicted",
      evidence: null,
      passageText: "Bukowski attended Los Angeles City College for two years.",
    });
    expect(result).toEqual({ verdict: "unsupported", evidence: null });
  });

  it("never uses fuzzy/semantic matching — a paraphrase that isn't a substring still downgrades", () => {
    const result = applyContradictionEvidenceGate({
      verdict: "contradicted",
      evidence: "went to college in Los Angeles",
      passageText: "Bukowski attended Los Angeles City College for two years.",
    });
    expect(result.verdict).toBe("unsupported");
  });

  it("matches across straight vs smart quote style, not just whitespace/basic punctuation", () => {
    const result = applyContradictionEvidenceGate({
      verdict: "contradicted",
      evidence: "the world's largest museum",
      passageText: "The Louvre is often called “the world’s largest museum” by visitors.",
    });
    expect(result.verdict).toBe("contradicted");
  });
});

describe("gate #2 — numeric normalization/comparison in code (T004)", () => {
  it("does nothing when the claim has no numeric fact", () => {
    const result = applyNumericGate({
      claimText: "Bukowski attended Los Angeles City College.",
      verdict: "supported",
      evidence: "Bukowski attended Los Angeles City College for two years.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false });
  });

  it("does nothing when there is no evidence to compare against", () => {
    const result = applyNumericGate({
      claimText: "The grant was worth $350,000.",
      verdict: "unsupported",
      evidence: null,
    });
    expect(result).toEqual({ verdict: "unsupported", overridden: false });
  });

  it("overrides to supported when the numbers are equal but VERIFY said otherwise", () => {
    const result = applyNumericGate({
      claimText: "UC Riverside received a $350,000 grant.",
      verdict: "unsupported",
      evidence: "The NEH awarded UC Riverside a $350,000 grant to expand the project.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: true });
  });

  it("overrides to contradicted when the numbers genuinely differ beyond tolerance (wrong scale)", () => {
    const result = applyNumericGate({
      claimText: "UC Riverside received a $1.2 million grant.",
      verdict: "supported",
      evidence: "The NEH awarded UC Riverside a $350,000 grant to expand the project.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true });
  });

  it("overrides an inverted-sign case (negative vs positive)", () => {
    const result = applyNumericGate({
      claimText: "The fund reported a loss of $(52) million.",
      verdict: "supported",
      evidence: "The fund reported net income of $52 million.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true });
  });

  it("leaves the verdict unchanged when code and VERIFY already agree", () => {
    const result = applyNumericGate({
      claimText: "UC Riverside received a $350,000 grant.",
      verdict: "supported",
      evidence: "The NEH awarded UC Riverside a $350,000 grant to expand the project.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false });
  });

  it("does nothing when claim and evidence units aren't comparable (percent vs currency)", () => {
    const result = applyNumericGate({
      claimText: "Enrollment grew by 12%.",
      verdict: "supported",
      evidence: "The university received a $12 million endowment.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false });
  });
});
