import { describe, it, expect } from "vitest";
import { computeAuditInputRef, computeCorpusId } from "../../../src/lib/hash.js";

const sourcesA = [{ id: "doc1", name: "A", text: "revenue grew 20%" }];
const sourcesB = [{ id: "doc1", name: "A", text: "revenue grew 30%" }];

describe("computeAuditInputRef", () => {
  it("is deterministic for identical input (FR-013 re-run linkage depends on this)", () => {
    const a = computeAuditInputRef("output", sourcesA, "task");
    const b = computeAuditInputRef("output", sourcesA, "task");
    expect(a).toBe(b);
  });

  it("differs when output_text, sources, or task differ", () => {
    const base = computeAuditInputRef("output", sourcesA, "task");
    expect(computeAuditInputRef("different output", sourcesA, "task")).not.toBe(base);
    expect(computeAuditInputRef("output", sourcesB, "task")).not.toBe(base);
    expect(computeAuditInputRef("output", sourcesA, "different task")).not.toBe(base);
  });
});

describe("computeCorpusId", () => {
  it("is content-addressed — same sources produce the same id (fixes an earlier static-label draft)", () => {
    expect(computeCorpusId(sourcesA)).toBe(computeCorpusId(sourcesA));
  });

  it("differs for genuinely different source sets", () => {
    expect(computeCorpusId(sourcesA)).not.toBe(computeCorpusId(sourcesB));
  });
});
