import { describe, it, expect, beforeAll } from "vitest";
import { BiasCatalogService } from "../../../src/catalog/bias-catalog.js";

describe("BiasCatalogService", () => {
  let catalog: BiasCatalogService;

  beforeAll(() => {
    catalog = new BiasCatalogService();
  });

  it("should load biases from taxonomy file", () => {
    const all = catalog.getAll();
    expect(all.length).toBeGreaterThan(0);
    expect(all.length).toBeGreaterThanOrEqual(28);
  });

  it("should return bias names from getShortlist", () => {
    const shortlist = catalog.getShortlist();
    expect(shortlist.length).toBeGreaterThan(0);
    expect(shortlist).toContain("Confirmation Bias");
    expect(shortlist).toContain("Anchoring Bias");
    expect(shortlist).toContain("Sunk Cost Fallacy");
  });

  it("should return categories from getCategories", () => {
    const categories = catalog.getCategories();
    expect(categories.length).toBeGreaterThan(0);
    // Each bias should belong to a category
    for (const bias of catalog.getAll()) {
      expect(categories).toContain(bias.category);
    }
  });

  it("should group biases by category", () => {
    const grouped = catalog.getBiasesByCategory();
    const categories = Object.keys(grouped);
    expect(categories.length).toBeGreaterThan(0);

    // Verify each group has at least one bias
    for (const category of categories) {
      expect(grouped[category]!.length).toBeGreaterThan(0);
    }
  });

  it("should return unique category names", () => {
    const categories = catalog.getCategories();
    const unique = new Set(categories);
    expect(unique.size).toBe(categories.length);
  });

  it("each bias should have required fields", () => {
    for (const bias of catalog.getAll()) {
      expect(bias.id).toBeTruthy();
      expect(bias.name).toBeTruthy();
      expect(bias.category).toBeTruthy();
      expect(bias.definition).toBeTruthy();
      expect(Array.isArray(bias.detectionSignals)).toBe(true);
    }
  });
});
