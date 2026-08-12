import { describe, it, expect } from "vitest";
import {
  GrounnelVerdictEnum,
  ClaimSchema,
  ClaimResultSchema,
  ClaimSourceSchema,
  ScoreSchema,
} from "../../../src/contracts/grounnel.schemas.js";
import { VerdictEnum } from "../../../src/contracts/audit.schemas.js";

const baseSource = {
  kind: "web" as const,
  title: "Wikipedia",
  domain: "en.wikipedia.org",
  url: "https://en.wikipedia.org/wiki/Example",
  status: "ok" as const,
};

const baseClaim = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  text: "Bukowski attended Los Angeles City College.",
  status: "done" as const,
  verdict: "supported" as const,
  evidence: "Bukowski attended Los Angeles City College for two years",
  confidence: 0.92,
  reason: "Wikipedia and OAC archives both confirm attendance dates.",
  sources: [baseSource],
};

// GrounnelVerdictEnum is deliberately a separate enum from audit's VerdictEnum
// (grounnel.schemas.ts header comment), not imported — this test is the drift
// guard: if one gains/loses/renames a value without the other, this fails.
describe("GrounnelVerdictEnum — drift guard against audit.schemas.ts's VerdictEnum", () => {
  it("has the exact same values as audit's VerdictEnum", () => {
    expect([...GrounnelVerdictEnum.options].sort()).toEqual([...VerdictEnum.options].sort());
  });
});

describe("ClaimSourceSchema", () => {
  it("rejects a non-URL string in url", () => {
    expect(() => ClaimSourceSchema.parse({ ...baseSource, url: "not-a-url" })).toThrow();
  });

  it("requires a status — a source with no status is rejected, not defaulted to ok", () => {
    const { status: _omit, ...withoutStatus } = baseSource;
    expect(() => ClaimSourceSchema.parse(withoutStatus)).toThrow();
  });

  it("accepts each documented failure status (initial-context.md §4.4)", () => {
    for (const status of ["ok", "paywalled", "unreachable", "blocked"] as const) {
      expect(() => ClaimSourceSchema.parse({ ...baseSource, status })).not.toThrow();
    }
  });

  it("accepts the attached-document variant (P1, spec.md's Not in P0) — no url/domain/status needed", () => {
    expect(() =>
      ClaimSourceSchema.parse({ kind: "attached", title: "user-uploaded.pdf", documentId: "doc-123" })
    ).not.toThrow();
  });
});

describe("ClaimResultSchema — derived from ClaimSchema via .omit(), not hand-duplicated", () => {
  it("accepts the same verdict fields as ClaimSchema minus id/text", () => {
    const { id: _id, text: _text, ...claimResult } = baseClaim;
    expect(() => ClaimResultSchema.parse(claimResult)).not.toThrow();
  });

  it("does not require id or text", () => {
    const { id: _id, text: _text, ...claimResult } = baseClaim;
    const parsed = ClaimResultSchema.parse(claimResult);
    expect(parsed).not.toHaveProperty("id");
    expect(parsed).not.toHaveProperty("text");
  });
});

describe("ClaimSchema", () => {
  it("parses a full valid claim", () => {
    expect(() => ClaimSchema.parse(baseClaim)).not.toThrow();
  });
});

// D027 §2 — one direction only: a null-evidence claim must never carry citations pointing at
// evidence the gate chain rejected. The converse (non-null evidence, empty citations) is legitimate
// (attachCitationUrls can drop a citation defensively) and must NOT be rejected.
describe("ClaimSchema/ClaimResultSchema — citations must be empty when evidence is null (D027 §2)", () => {
  it("accepts a claim with real evidence and matching citations", () => {
    const claim = { ...baseClaim, citations: [{ source: "A", sentence: 1, url: "https://example.com", text: "some text" }] };
    expect(() => ClaimSchema.parse(claim)).not.toThrow();
  });

  it("accepts a claim with real evidence and NO citations — a legitimate defensive-drop case, not an error", () => {
    expect(() => ClaimSchema.parse({ ...baseClaim, citations: [] })).not.toThrow();
  });

  it("accepts a null-evidence claim with empty citations", () => {
    expect(() => ClaimSchema.parse({ ...baseClaim, evidence: null, citations: [] })).not.toThrow();
  });

  it("rejects a null-evidence claim that still carries citations", () => {
    const claim = { ...baseClaim, evidence: null, citations: [{ source: "A", sentence: 1, url: "https://example.com", text: "some text" }] };
    expect(() => ClaimSchema.parse(claim)).toThrow();
  });

  it("applies the same rule to ClaimResultSchema (the writeClaimResult-facing shape)", () => {
    const { id: _id, text: _text, ...rest } = baseClaim;
    const result = { ...rest, evidence: null, citations: [{ source: "A", sentence: 1, url: "https://example.com", text: "some text" }] };
    expect(() => ClaimResultSchema.parse(result)).toThrow();
  });
});

const baseScore = {
  grounded_pct: 24,
  grounded_n: 20,
  unclear_n: 31,
  no_evidence_n: 28,
  contradicted_n: 6,
  not_checked_n: 0,
  eligible: 85,
};

// initial-context.md's own erratum (progress.total: 55 next to score.eligible:
// 85, buckets summing to 85) shipped this exact mismatch once, undetected, in
// prose — this is the regression test for the schema-level guard against it.
describe("ScoreSchema — verdict-bucket counts must sum to eligible", () => {
  it("accepts counts that sum to eligible", () => {
    expect(() => ScoreSchema.parse(baseScore)).not.toThrow();
  });

  it("rejects counts that don't sum to eligible", () => {
    expect(() => ScoreSchema.parse({ ...baseScore, eligible: 55 })).toThrow();
  });

  it("rejects grounded_pct outside 0-100", () => {
    expect(() => ScoreSchema.parse({ ...baseScore, grounded_pct: 101 })).toThrow();
  });

  it("rejects a non-integer grounded_pct", () => {
    expect(() => ScoreSchema.parse({ ...baseScore, grounded_pct: 23.5 })).toThrow();
  });
});
