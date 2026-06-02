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

describe("normalizeBiasName", () => {
  it("should exact match by catalog id (kebab-case)", () => {
    const result = normalizeBiasName("confirmation-bias", mockCatalog);
    expect(result.id).toBe("confirmation-bias");
    expect(result.name).toBe("Confirmation Bias");
    expect(result.confidence).toBe(1.0);
  });

  it("should exact match by catalog name (case-insensitive)", () => {
    const result = normalizeBiasName("confirmation bias", mockCatalog);
    expect(result.id).toBe("confirmation-bias");
    expect(result.name).toBe("Confirmation Bias");
    expect(result.confidence).toBe(1.0);
  });

  it("should match with different casing", () => {
    const result = normalizeBiasName("CONFIRMATION BIAS", mockCatalog);
    expect(result.id).toBe("confirmation-bias");
    expect(result.confidence).toBe(1.0);
  });

  it("should match via token overlap", () => {
    const result = normalizeBiasName("Confirmation of Bias", mockCatalog);
    expect(result.id).toBe("confirmation-bias");
    expect(result.confidence).toBe(0.8);
  });

  it("should match via Levenshtein distance", () => {
    const result = normalizeBiasName("Confirmation Biass", mockCatalog);
    expect(result.id).toBe("confirmation-bias");
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThan(1);
  });

  it("should return null id for unknown bias names", () => {
    const result = normalizeBiasName("Some Random Bias", mockCatalog);
    expect(result.id).toBeNull();
    expect(result.name).toBe("Some Random Bias");
    expect(result.confidence).toBe(0);
  });

  it("should handle empty string", () => {
    const result = normalizeBiasName("", mockCatalog);
    expect(result.id).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it("should match 'Sunk Cost' to 'Sunk Cost Fallacy' via token overlap", () => {
    const result = normalizeBiasName("Sunk Cost", mockCatalog);
    expect(result.id).toBe("sunk-cost-fallacy");
    expect(result.confidence).toBe(0.8);
  });

  it("should match 'Halo' to 'Halo Effect' via token overlap", () => {
    const result = normalizeBiasName("Halo", mockCatalog);
    expect(result.id).toBe("halo-effect");
    expect(result.confidence).toBe(0.8);
  });
});
