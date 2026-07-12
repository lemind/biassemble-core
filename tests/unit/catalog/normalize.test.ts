import { describe, it, expect } from "vitest";
import { normalizeBiasName } from "../../../src/catalog/normalize.js";
import type { BiasEntry } from "../../../src/catalog/bias-catalog.js";

const mockCatalog: BiasEntry[] = [
  {
    id: "confirmation-bias",
    name: "Confirmation Bias",
    category: "information-processing",
    definition: "Seeking or interpreting information that confirms existing beliefs.",
    detectionSignals: ["only looked for supporting evidence"],
  },
  {
    id: "anchoring",
    name: "Anchoring Bias",
    category: "decision-making",
    definition: "Over-relying on the first piece of information.",
    detectionSignals: ["first number drove decision"],
  },
  {
    id: "sunk-cost-fallacy",
    name: "Sunk Cost Fallacy",
    category: "decision-making",
    definition: "Continuing because of invested resources.",
    detectionSignals: ["already invested too much"],
  },
  {
    id: "halo-effect",
    name: "Halo Effect",
    category: "social",
    definition: "One positive trait colors everything.",
    detectionSignals: ["one good quality colored everything"],
  },
];

// normalizeBiasName matches by NAME only (fuzzy token-overlap + edit-distance against
// entry.name), never by raw catalog id — exact id lookup was never implemented (see
// commit a51a75b). It returns { name: string, id?: string }; there is no confidence field
// on the public return value (findBestMatch computes one internally for ranking, but
// normalizeBiasName doesn't expose it).
describe("normalizeBiasName", () => {
  it("should exact match by catalog name (case-insensitive)", () => {
    const result = normalizeBiasName("confirmation bias", mockCatalog);
    expect(result.id).toBe("confirmation-bias");
    expect(result.name).toBe("Confirmation Bias");
  });

  it("should match with different casing", () => {
    const result = normalizeBiasName("CONFIRMATION BIAS", mockCatalog);
    expect(result.id).toBe("confirmation-bias");
  });

  it("should match via token overlap", () => {
    const result = normalizeBiasName("Confirmation of Bias", mockCatalog);
    expect(result.id).toBe("confirmation-bias");
  });

  it("should match via Levenshtein distance", () => {
    const result = normalizeBiasName("Confirmation Biass", mockCatalog);
    expect(result.id).toBe("confirmation-bias");
  });

  it("should return undefined id for unknown bias names", () => {
    const result = normalizeBiasName("Some Random Bias", mockCatalog);
    expect(result.id).toBeUndefined();
    expect(result.name).toBe("Some Random Bias");
  });

  it("should handle empty string", () => {
    const result = normalizeBiasName("", mockCatalog);
    expect(result.id).toBeUndefined();
  });

  it("should match 'Sunk Cost' to 'Sunk Cost Fallacy' via token overlap", () => {
    const result = normalizeBiasName("Sunk Cost", mockCatalog);
    expect(result.id).toBe("sunk-cost-fallacy");
  });

  it("should NOT match a single truncated word ('Halo') to a two-word phrase — below the 0.5 confidence threshold", () => {
    // overlap=0.5, editDistance~0.64 -> confidence~0.45, under the > 0.5 threshold in
    // normalizeBiasName. Weak single-word-to-phrase matching isn't something the current
    // simple scorer supports; this documents that boundary rather than asserting a match
    // the algorithm doesn't actually produce.
    const result = normalizeBiasName("Halo", mockCatalog);
    expect(result.id).toBeUndefined();
  });
});
