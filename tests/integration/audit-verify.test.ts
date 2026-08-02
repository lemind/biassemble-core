import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { MockProvider } from "../mocks/mock-provider.js";
import { MockAuditStore } from "../mocks/mock-audit-store.js";
import { PromptRegistry } from "../../src/prompts/registry.js";
import { VerifyService } from "../../src/orchestrators/audit/verify.service.js";
import type { LlmCallStore } from "../../src/persistence/ports.js";
import type { Claim } from "../../src/db/schema.js";
import type { RetrievedPassage } from "../../src/rag/corpus-client.js";

/**
 * T012 — tests the VERIFY service's plumbing against all 15 golden pairs.
 * Same honest limitation as T011 (tests/integration/audit-extract.test.ts):
 * MockProvider is seeded with each case's own expected_verdict/evidence, so
 * this proves the service correctly persists a correct model response
 * (verdict, synthesized flag, retrieval-failure gate rule, comparability
 * downgrade), not that the real VERIFY prompt elicits it from a live model.
 */

interface GoldenPassage {
  location: string;
  text: string;
}

interface GoldenScenario {
  id: string;
  claim: string;
  passages: GoldenPassage[];
  expected_verdict: string;
  expected_evidence: string | string[] | null;
  expected_note: string;
  expected_synthesized?: boolean;
  // Optional: what the mock LLM's RAW output actually was, when it differs from expected_verdict —
  // added on review after finding that seeding every case with verdict=expected_verdict (the
  // established convention below) meant a golden case for a code-side reconciliation fix could
  // never actually exercise the "wrong raw verdict gets corrected" path; it could only prove an
  // already-correct verdict survives untouched, which would pass identically before and after the
  // fix it claims to pin. When present, these seed the mock's raw response instead of the
  // expected_* fields; the assertions below always still check against expected_verdict/evidence.
  seed_verdict?: string;
  seed_evidence?: string | string[] | null;
  seed_confidence?: number;
}

const goldenSet: { scenarios: GoldenScenario[] } = JSON.parse(
  readFileSync(new URL("../../evaluations/golden/audit/verify-golden-set.json", import.meta.url), "utf-8")
);

const mockLlmCallStore: LlmCallStore = {
  recordCall: vi.fn().mockResolvedValue({ id: "test-llm-call-id" }),
  getCallsBySession: vi.fn().mockResolvedValue([]),
  getCallsByStage: vi.fn().mockResolvedValue([]),
  getCallsByProvider: vi.fn().mockResolvedValue([]),
  getCallsBySessionAndStage: vi.fn().mockResolvedValue([]),
  updateParsedOutput: vi.fn().mockResolvedValue(undefined),
  updateFailure: vi.fn().mockResolvedValue(undefined),
  getCallsForMetrics: vi.fn().mockResolvedValue([]),
};

function buildService() {
  const provider = new MockProvider();
  const prompts = new PromptRegistry();
  const auditStore = new MockAuditStore();
  const service = new VerifyService(provider, prompts, "mock-model", mockLlmCallStore, auditStore);
  return { provider, auditStore, service };
}

function toClaim(auditId: string, claimId: string, claimText: string): Claim {
  return {
    claimId,
    auditId,
    type: "numeric",
    claimText,
    excerpt: claimText,
    locations: ["p1s1"],
    period: null,
    derived: false,
    passagesRetrievedCount: 1,
    retrievalStatus: "ok",
    verdict: null,
    evidence: null,
    sourceRefs: null,
    synthesized: null,
    confidence: null,
    note: null,
  } as Claim;
}

function toPassages(passages: GoldenPassage[]): RetrievedPassage[] {
  return passages.map((p, i) => ({
    passageId: randomUUID(),
    docId: "source-filing",
    location: p.location,
    text: p.text,
    rank: i + 1,
    score: 0.9,
  }));
}

const evidenceArray = (e: string | string[] | null): string[] | null => (e === null ? null : Array.isArray(e) ? e : [e]);

describe("VERIFY service against verify-golden-set.json (T012)", () => {
  // The scenario count itself is asserted by "meets the ≥40/41 pass bar in aggregate" below
  // (expect(total).toBe(41)) — a standalone count-only test here would just duplicate that
  // assertion in its own test slot without exercising VerifyService at all (removed on review).
  let matched = 0;
  const total = goldenSet.scenarios.length;

  for (const scenario of goldenSet.scenarios) {
    it(`${scenario.id} — persists the expected verdict${scenario.expected_synthesized ? " and synthesized flag" : ""}`, async () => {
      const { provider, auditStore, service } = buildService();
      const auditId = randomUUID();
      await auditStore.createAudit({ auditId, inputRef: "test", domain: "finance", threshold: 0.6 });
      const claim = toClaim(auditId, randomUUID(), scenario.claim);
      auditStore.claims.set(claim.claimId, claim);
      const passages = toPassages(scenario.passages);

      provider.setDefault({
        results: [
          {
            claim_id: claim.claimId,
            verdict: scenario.seed_verdict ?? scenario.expected_verdict,
            evidence: evidenceArray(scenario.seed_evidence ?? scenario.expected_evidence),
            source_refs: passages.map((p) => p.passageId),
            synthesized: scenario.expected_synthesized ?? false,
            note: scenario.expected_note,
            confidence: scenario.seed_confidence ?? 0.9,
          },
        ],
        trace: {},
      });

      await service.run(auditId, [{ claim, passages }], 0.6);
      const updated = auditStore.claims.get(claim.claimId)!;

      if (updated.verdict === scenario.expected_verdict) matched++;
      expect(updated.verdict).toBe(scenario.expected_verdict);

      // FR-018: synthesized must round-trip, not just the verdict string —
      // a service that never sets it would pass a verdict-only assertion.
      if (scenario.expected_synthesized !== undefined) {
        expect(updated.synthesized).toBe(scenario.expected_synthesized);
      }

      // Never assign "contradicted" without evidence (data-model.md Verdict validation).
      if (updated.verdict === "contradicted") {
        expect(updated.evidence).toBeTruthy();
      }
    });
  }

  it("meets the ≥40/41 pass bar in aggregate", () => {
    expect(matched).toBeGreaterThanOrEqual(40);
    expect(total).toBe(41);
  });

  it("retrieval-failure gate rule: a claim with retrieval_status=error never resolves to unsupported, even if VERIFY said so", async () => {
    const { provider, auditStore, service } = buildService();
    const auditId = randomUUID();
    await auditStore.createAudit({ auditId, inputRef: "test", domain: "finance", threshold: 0.6 });
    const claim = toClaim(auditId, randomUUID(), "Some claim");
    claim.retrievalStatus = "error";
    claim.passagesRetrievedCount = 0;
    auditStore.claims.set(claim.claimId, claim);

    provider.setDefault({
      results: [{ claim_id: claim.claimId, verdict: "unsupported", evidence: null, source_refs: [], synthesized: false, note: null, confidence: 0.9 }],
      trace: {},
    });

    await service.run(auditId, [{ claim, passages: [] }], 0.6);
    const updated = auditStore.claims.get(claim.claimId)!;
    expect(updated.verdict).toBe("unverifiable");
  });

  it("bug found on review (2026-07-29): a numeric downgrade must not be reversed by the verdict/note consistency check reading the pre-correction note text it inherited", async () => {
    // reconcileVerdictNoteConsistency used to run LAST in the reconciliation chain, seeing
    // whatever reconcileNumericVerdict had already produced — including the ORIGINAL LLM note
    // text, which can itself use contradiction language ("differs from") to justify the verdict
    // being corrected away from. Running the consistency check last meant it could see that
    // leftover language and flip a just-fixed verdict right back to wrong. This claim's raw
    // verdict is "contradicted" with a note that says "differs from", but the actual values
    // (16.99% vs claimed 17%) are within compare.ts's tolerance — the numeric check must
    // downgrade this to "supported" and it must STAY "supported".
    const { provider, auditStore, service } = buildService();
    const auditId = randomUUID();
    await auditStore.createAudit({ auditId, inputRef: "test", domain: "finance", threshold: 0.6 });
    const claim = toClaim(auditId, randomUUID(), "iPhone net sales rose 17% year-over-year");
    auditStore.claims.set(claim.claimId, claim);
    const passages = toPassages([{ location: "products-table", text: "iPhone grew 16.99% year-over-year" }]);

    provider.setDefault({
      results: [
        {
          claim_id: claim.claimId,
          verdict: "contradicted",
          evidence: ["iPhone grew 16.99% year-over-year"],
          source_refs: passages.map((p) => p.passageId),
          synthesized: false,
          note: "The evidence states 16.99%, which differs from the claimed 17% growth rate.",
          confidence: 0.9,
        },
      ],
      trace: {},
    });

    await service.run(auditId, [{ claim, passages }], 0.6);
    const updated = auditStore.claims.get(claim.claimId)!;
    expect(updated.verdict).toBe("supported");
  });

  it("degrades an unparseable VERIFY response to unverifiable instead of failing the whole audit (2026-07-31)", async () => {
    const { provider, auditStore, service } = buildService();
    const auditId = randomUUID();
    await auditStore.createAudit({ auditId, inputRef: "test", domain: "finance", threshold: 0.6 });
    const claim = toClaim(auditId, randomUUID(), "Some claim");
    auditStore.claims.set(claim.claimId, claim);

    // confidence: 1.5 fails VerifyResultSchema's z.number().min(0).max(1); repair.ts nulls the whole
    // `results` array. Live, this hard-failed ~1 audit in 5 and only a human relaunch recovered it.
    provider.setDefault({
      results: [{ claim_id: claim.claimId, verdict: "supported", evidence: null, source_refs: [], synthesized: false, note: null, confidence: 1.5 }],
      trace: {},
    });

    await expect(service.run(auditId, [{ claim, passages: [] }], 0.6)).resolves.toBeUndefined();
    const updated = auditStore.claims.get(claim.claimId)!;
    expect(updated.verdict).toBe("unverifiable");
    expect(updated.confidence).toBe(0);
    expect(updated.note).toContain("failed after");
  });

  it("recovers when the PROVIDER CALL ITSELF throws, not just when it returns unparseable JSON (2026-08-02)", async () => {
    // Found on review: the provider call sat OUTSIDE the try/catch that triggers retry, so a real
    // failure mode (a timeout abort, a malformed-JSON throw from the provider) never reached the retry
    // loop at all and hard-failed the whole audit. The previous test only ever exercised a successful
    // call returning schema-invalid JSON — a materially easier case that this bug slipped past entirely.
    const { provider, auditStore, service } = buildService();
    const auditId = randomUUID();
    await auditStore.createAudit({ auditId, inputRef: "test", domain: "finance", threshold: 0.6 });
    const claim = toClaim(auditId, randomUUID(), "Some claim");
    auditStore.claims.set(claim.claimId, claim);

    provider.failOn(1, "This operation was aborted");
    provider.setDefault({
      results: [{ claim_id: claim.claimId, verdict: "supported", evidence: ["e"], source_refs: [], synthesized: false, note: null, confidence: 0.9 }],
      trace: {},
    });

    await expect(service.run(auditId, [{ claim, passages: [] }], 0.6)).resolves.toBeUndefined();
    expect(auditStore.claims.get(claim.claimId)!.verdict).toBe("supported");
  });

  it("degrades to unverifiable, not a thrown audit failure, when the provider call itself keeps throwing", async () => {
    const { provider, auditStore, service } = buildService();
    const auditId = randomUUID();
    await auditStore.createAudit({ auditId, inputRef: "test", domain: "finance", threshold: 0.6 });
    const claim = toClaim(auditId, randomUUID(), "Some claim");
    auditStore.claims.set(claim.claimId, claim);

    provider.failAll("This operation was aborted");

    await expect(service.run(auditId, [{ claim, passages: [] }], 0.6)).resolves.toBeUndefined();
    const updated = auditStore.claims.get(claim.claimId)!;
    expect(updated.verdict).toBe("unverifiable");
    expect(updated.note).toContain("aborted");
  });

  it("retries an unparseable VERIFY response and keeps the verdict when a later attempt parses", async () => {
    const { provider, auditStore, service } = buildService();
    const auditId = randomUUID();
    await auditStore.createAudit({ auditId, inputRef: "test", domain: "finance", threshold: 0.6 });
    const claim = toClaim(auditId, randomUUID(), "Some claim");
    auditStore.claims.set(claim.claimId, claim);

    let call = 0;
    provider.setResponseFn("You are a verification engine", () => {
      call++;
      const confidence = call === 1 ? 1.5 : 0.9; // first response unparseable, second valid
      return { results: [{ claim_id: claim.claimId, verdict: "supported", evidence: ["e"], source_refs: [], synthesized: false, note: null, confidence }], trace: {} };
    });

    await service.run(auditId, [{ claim, passages: [] }], 0.6);
    expect(call).toBeGreaterThan(1);
    expect(auditStore.claims.get(claim.claimId)!.verdict).toBe("supported");
  });
});
