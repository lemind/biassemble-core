import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { MockProvider } from "../../../mocks/mock-provider.js";
import { MockAuditStore } from "../../../mocks/mock-audit-store.js";
import { PromptRegistry } from "../../../../src/prompts/registry.js";
import { VerifyService } from "../../../../src/orchestrators/audit/verify.service.js";
import type { LlmCallStore } from "../../../../src/persistence/ports.js";
import type { Claim } from "../../../../src/db/schema.js";

/**
 * T018a — FR-020 / D018 §2.3/A6: Verdict.confidence is only ever assigned
 * from VERIFY's own output, never computed from, blended with, or falling
 * back to any SourcePassage.retrieval_score.
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

describe("VERIFY confidence/retrieval-score separation (T018a, FR-020)", () => {
  it("persists VERIFY's own confidence unchanged, regardless of a wildly different retrieval_score on the cited passage", async () => {
    const provider = new MockProvider();
    const prompts = new PromptRegistry();
    const auditStore = new MockAuditStore();
    const service = new VerifyService(provider, prompts, "mock-model", mockLlmCallStore, auditStore);

    const auditId = randomUUID();
    await auditStore.createAudit({ auditId, inputRef: "test", domain: "finance", threshold: 0.6 });
    const claim = {
      claimId: randomUUID(),
      auditId,
      type: "numeric",
      claimText: "Revenue grew 20%",
      excerpt: "Revenue grew 20%",
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
    auditStore.claims.set(claim.claimId, claim);

    // Passage has a low retrieval_score — if confidence were ever derived
    // from it, VERIFY's own high confidence below would get dragged down.
    const passage = { passageId: randomUUID(), docId: "doc1", location: "p1", text: "Revenue grew 20% to $100M", rank: 1, score: 0.12 };

    const VERIFY_OWN_CONFIDENCE = 0.97;
    provider.setDefault({
      results: [
        {
          claim_id: claim.claimId,
          verdict: "supported",
          evidence: ["Revenue grew 20% to $100M"],
          source_refs: [passage.passageId],
          synthesized: false,
          note: null,
          confidence: VERIFY_OWN_CONFIDENCE,
        },
      ],
      trace: {},
    });

    await service.run(auditId, [{ claim, passages: [passage] }], 0.6);

    const updated = auditStore.claims.get(claim.claimId)!;
    expect(updated.confidence).toBe(VERIFY_OWN_CONFIDENCE);
    expect(updated.confidence).not.toBe(passage.score);
  });
});
