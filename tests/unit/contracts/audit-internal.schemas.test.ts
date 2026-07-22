import { describe, it, expect } from "vitest";
import { VerifyResponseSchema, VerifyResultSchema } from "../../../src/contracts/audit-internal.schemas.js";

/**
 * Regression test for a real production incident (2026-07-22): Gemini
 * returned a `results` array where one item omitted the `note` key entirely
 * (not `note: null` — the key was simply absent). `note: z.string().nullable()`
 * rejects `undefined`, so the whole `results` array failed validation as one
 * unit over this single cosmetic field, killing an otherwise-good batch of
 * 10 real verdicts. Fixed by accepting `undefined` and normalizing to `null`,
 * the same idiom already used for `audit.schemas.ts`'s `source_refs`.
 */
describe("VerifyResultSchema.note — missing key normalizes to null (real production incident)", () => {
  const base = {
    claim_id: "c1",
    verdict: "supported" as const,
    evidence: ["quote"],
    source_refs: ["p1"],
    synthesized: false,
    confidence: 1,
  };

  it("accepts a result object with the `note` key omitted entirely", () => {
    const result = VerifyResultSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.note).toBeNull();
  });

  it("still accepts an explicit null", () => {
    const result = VerifyResultSchema.safeParse({ ...base, note: null });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.note).toBeNull();
  });

  it("still accepts a real string", () => {
    const result = VerifyResultSchema.safeParse({ ...base, note: "a real note" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.note).toBe("a real note");
  });

  it("a results array with one item missing `note` (the exact production shape) validates as a whole", () => {
    const response = {
      results: [
        { ...base, claim_id: "c1", note: "has a note" },
        // This item omits `note` entirely — the exact shape that killed the
        // whole batch in production before this fix.
        { ...base, claim_id: "c2" },
      ],
      trace: {},
    };
    const result = VerifyResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.results).toHaveLength(2);
      expect(result.data.results[1]?.note).toBeNull();
    }
  });
});
