import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { VerifyService, batchClaims, type ClaimWithPassages } from "../../../../src/orchestrators/audit/verify.service.js";
import { computeScores } from "../../../../src/orchestrators/audit/scores.js";
import { MockProvider } from "../../../mocks/mock-provider.js";
import { MockAuditStore } from "../../../mocks/mock-audit-store.js";
import { PromptRegistry } from "../../../../src/prompts/registry.js";
import type { LlmCallStore } from "../../../../src/persistence/ports.js";
import type { Claim } from "../../../../src/db/schema.js";

/**
 * T032 — claim/passage identity must be resolved by claim_id/passage_id,
 * never by array position. Also serves as T036's audit of US1 for any
 * array-position-dependent lookup that slipped in — none found; this test
 * proves the invariant rather than fixing a discovered defect.
 */

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

function makeClaim(claimText: string, overrides: Partial<Claim> = {}): Claim {
  return {
    claimId: randomUUID(),
    auditId: randomUUID(),
    type: "numeric",
    claimText,
    excerpt: claimText,
    locations: [],
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
    ...overrides,
  } as Claim;
}

describe("VerifyService — verdicts are assigned by claim_id, not array position (T032)", () => {
  it("shuffled input order and a reversed/reordered LLM response still map each verdict to the correct claim", async () => {
    const provider = new MockProvider();
    const prompts = new PromptRegistry();
    const auditStore = new MockAuditStore();
    const auditId = randomUUID();
    await auditStore.createAudit({ auditId, inputRef: "test", domain: "finance", threshold: 0.6 });

    const claimA = makeClaim("Claim A about revenue", { auditId });
    const claimB = makeClaim("Claim B about margin", { auditId });
    const claimC = makeClaim("Claim C about headcount", { auditId });
    await auditStore.createClaims([claimA, claimB, claimC].map((c) => ({ ...c })));

    const items: ClaimWithPassages[] = [
      { claim: claimC, passages: [] }, // deliberately not insertion order
      { claim: claimA, passages: [] },
      { claim: claimB, passages: [] },
    ];

    // Deliberately returns results in yet another order than the request
    // (reversed), each keyed only by claim_id — proves VerifyService doesn't
    // assume request-order === response-order.
    const expectedVerdict: Record<string, string> = {
      [claimA.claimId]: "supported",
      [claimB.claimId]: "contradicted",
      [claimC.claimId]: "unverifiable",
    };
    provider.setResponseFn("You are a verification engine", () => ({
      results: [claimC, claimA, claimB]
        .slice()
        .reverse()
        .map((c) => ({
          claim_id: c.claimId,
          verdict: expectedVerdict[c.claimId],
          evidence: null,
          source_refs: [],
          synthesized: false,
          note: null,
          confidence: 0.9,
        })),
      trace: {},
    }));

    const verifyService = new VerifyService(provider, prompts, "mock-model", mockLlmCallStore, auditStore);
    await verifyService.run(auditId, items, 0.6);

    const persisted = await auditStore.getClaimsByAudit(auditId);
    const byId = new Map(persisted.map((c) => [c.claimId, c]));
    expect(byId.get(claimA.claimId)?.verdict).toBe("supported");
    expect(byId.get(claimB.claimId)?.verdict).toBe("contradicted");
    expect(byId.get(claimC.claimId)?.verdict).toBe("unverifiable");
  });

  it("batchClaims groups by each item's passage docId, not by its position in the input array", () => {
    const claim1 = makeClaim("Claim 1");
    const claim2 = makeClaim("Claim 2");
    const claim3 = makeClaim("Claim 3");
    const items: ClaimWithPassages[] = [
      { claim: claim1, passages: [{ passageId: randomUUID(), docId: "docB", location: null, text: "x", rank: 1, score: 1 }] },
      { claim: claim2, passages: [{ passageId: randomUUID(), docId: "docA", location: null, text: "y", rank: 1, score: 1 }] },
      { claim: claim3, passages: [{ passageId: randomUUID(), docId: "docA", location: null, text: "z", rank: 1, score: 1 }] },
    ];
    const batches = batchClaims(items);
    // claim2/claim3 share docA and land in the same batch regardless of
    // claim1 (docB) sitting between them positionally in the input array.
    const docABatch = batches.find((b) => b.some((i) => i.claim.claimId === claim2.claimId));
    expect(docABatch?.map((i) => i.claim.claimId).sort()).toEqual([claim2.claimId, claim3.claimId].sort());
  });
});

describe("computeScores — aggregation over claimPassages is order-invariant (T032)", () => {
  it("gives identical results regardless of claimPassages array order", () => {
    const claimA = makeClaim("A", { verdict: "supported", passagesRetrievedCount: 1, retrievalStatus: "ok" });
    const claimB = makeClaim("B", { verdict: "supported", passagesRetrievedCount: 1, retrievalStatus: "ok" });
    const claims = [claimA, claimB];
    const rows = [
      { claimId: claimA.claimId, retrievalScore: 0.9 },
      { claimId: claimB.claimId, retrievalScore: 0.3 },
    ];

    const forward = computeScores(claims, rows);
    const reversed = computeScores(claims, [...rows].reverse());
    expect(forward).toEqual(reversed);
  });
});
