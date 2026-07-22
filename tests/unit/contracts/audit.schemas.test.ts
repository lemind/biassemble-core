import { describe, it, expect } from "vitest";
import { ClaimSchema, AuditRequestSchema } from "../../../src/contracts/audit.schemas.js";

const baseClaim = {
  claim_id: "550e8400-e29b-41d4-a716-446655440000",
  type: "numeric" as const,
  claim: "Total net sales reached $111,184 million",
  excerpt: "Total net sales reached $111,184 million",
  locations: ["p1s1"],
  period: "Q2 2026",
  derived: false,
  retrieval_status: "ok" as const,
  passages_retrieved_count: 1,
  verdict: "supported" as const,
  evidence: ["Total net sales $111,184"],
  synthesized: false,
  confidence: 0.91,
  note: null,
};

describe("ClaimSchema source_refs — null-vs-undefined fix", () => {
  it("coerces a null source_refs (Drizzle's jsonb null, pre-VERIFY row) to []", () => {
    const parsed = ClaimSchema.parse({ ...baseClaim, source_refs: null });
    expect(parsed.source_refs).toEqual([]);
  });

  it("passes through a real array unchanged", () => {
    const parsed = ClaimSchema.parse({ ...baseClaim, source_refs: ["passage-uuid"] });
    expect(parsed.source_refs).toEqual(["passage-uuid"]);
  });

  it("rejects undefined — source_refs must be explicitly present (null or array), not omitted", () => {
    const { source_refs: _omit, ...withoutSourceRefs } = { ...baseClaim, source_refs: [] };
    expect(() => ClaimSchema.parse(withoutSourceRefs)).toThrow();
  });
});

// T013 — POST /audit request validation. This validates the Zod contract
// AuditRequestSchema directly; routes/audit.ts's ZodError catch turns any
// rejection here into a 400 (the same pattern routes/reflection.ts already
// uses), so testing the schema is testing the 400 behavior.
describe("AuditRequestSchema — POST /audit request validation (T013)", () => {
  const validRequest = {
    domain: "finance" as const,
    output_text: "Apple's total net sales reached $111,184 million.",
    sources: [{ id: "doc1", name: "10-Q", text: "Total net sales $111,184" }],
  };

  it("accepts a minimal valid request, applying option defaults", () => {
    const parsed = AuditRequestSchema.parse(validRequest);
    expect(parsed.options.threshold).toBe(0.6);
    expect(parsed.options.maxClaims).toBe(50);
  });

  it("accepts an empty sources[] — degenerate but valid (D018 §2.3 'sources are silent')", () => {
    expect(() => AuditRequestSchema.parse({ ...validRequest, sources: [] })).not.toThrow();
  });

  it("rejects a missing output_text", () => {
    const { output_text: _omit, ...withoutOutputText } = validRequest;
    expect(() => AuditRequestSchema.parse(withoutOutputText)).toThrow();
  });

  it("rejects an empty output_text", () => {
    expect(() => AuditRequestSchema.parse({ ...validRequest, output_text: "" })).toThrow();
  });

  it("rejects malformed sources[] — missing required fields", () => {
    expect(() => AuditRequestSchema.parse({ ...validRequest, sources: [{ id: "doc1" }] })).toThrow();
  });

  it("rejects malformed sources[] — wrong shape entirely", () => {
    expect(() => AuditRequestSchema.parse({ ...validRequest, sources: "not-an-array" })).toThrow();
  });

  it("rejects an invalid domain value", () => {
    expect(() => AuditRequestSchema.parse({ ...validRequest, domain: "astrology" })).toThrow();
  });

  it("does not require a client-supplied mode field (route is the mode boundary, D018 §1)", () => {
    const parsed = AuditRequestSchema.parse({ ...validRequest, mode: "audit" });
    expect(parsed).not.toHaveProperty("mode");
  });
});
