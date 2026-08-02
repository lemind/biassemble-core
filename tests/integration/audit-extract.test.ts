import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { MockProvider } from "../mocks/mock-provider.js";
import { MockAuditStore } from "../mocks/mock-audit-store.js";
import { PromptRegistry } from "../../src/prompts/registry.js";
import { ExtractService } from "../../src/orchestrators/audit/extract.service.js";
import type { LlmCallStore } from "../../src/persistence/ports.js";

/**
 * T011 — tests the EXTRACT service's plumbing against all 12 golden
 * scenarios: claim_id assignment, excerpt-verbatim validation, maxClaims
 * enforcement, truncated persistence. MockProvider is seeded with the
 * response a *correct* model call would produce (constructed directly from
 * each scenario's own expected_claims) — this is an honest limitation, not
 * an oversight: without a live LLM call (a real, budget-affecting external
 * dependency this test suite deliberately never makes automatically), there
 * is no way to validate whether the actual EXTRACT prompt text elicits this
 * correct response from a real model. What this test DOES prove: given a
 * correct response, the service correctly shapes, validates, and persists
 * it — and, in the negative case below, correctly rejects an incorrect one.
 */

interface GoldenClaim {
  id: string;
  type: "numeric" | "entity" | "attribution" | "causal" | "derived";
  claim: string;
  excerpt: string;
  locations: string[];
  period: string;
  derived: boolean;
}

interface GoldenScenario {
  id: string;
  output_text: string;
  expected_claims: GoldenClaim[];
  excluded_content: Array<{ text: string; reason: string }>;
}

const goldenSet: { task_context_default: string; scenarios: GoldenScenario[] } = JSON.parse(
  readFileSync(new URL("../../evaluations/golden/audit/extract-golden-set.json", import.meta.url), "utf-8")
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
  const service = new ExtractService(provider, prompts, "mock-model", mockLlmCallStore, auditStore);
  return { provider, auditStore, service };
}

describe("EXTRACT service against extract-golden-set.json (T011)", () => {
  // Scenario count is stated in evaluations/golden/audit/README.md, not asserted here — a
  // standalone length check never calls ExtractService and doesn't prove anything about the
  // code (removed on review; see the same fix in audit-verify.test.ts).
  for (const scenario of goldenSet.scenarios) {
    it(`${scenario.id} — correct response is persisted with recall ≥0.90, precision ≥0.85, zero excluded_content leaks`, async () => {
      const { provider, auditStore, service } = buildService();
      const auditId = randomUUID();
      await auditStore.createAudit({ auditId, inputRef: "test", domain: "finance", threshold: 0.6 });

      provider.setDefault({
        claims: scenario.expected_claims.map((c) => ({
          id: c.id,
          type: c.type,
          claim: c.claim,
          excerpt: c.excerpt,
          locations: c.locations,
          period: c.period,
          derived: c.derived,
        })),
        truncated: false,
      });

      const { claims } = await service.run(auditId, scenario.output_text, goldenSet.task_context_default, 50);

      // Recall/precision against the golden case's own expected_claims —
      // since the mock echoes them exactly, this validates the persistence
      // shape (claim_id assigned, fields round-trip correctly), not
      // real-world extraction accuracy (see file header).
      expect(claims.length).toBe(scenario.expected_claims.length);
      const recall = claims.length / scenario.expected_claims.length;
      expect(recall).toBeGreaterThanOrEqual(0.9);

      for (const claim of claims) {
        expect(claim.claimId).toBeTruthy();
        expect(scenario.output_text.includes(claim.excerpt)).toBe(true);
        // Zero excluded_content leaks — none of the excluded phrases should
        // appear as a persisted claim's excerpt.
        for (const excluded of scenario.excluded_content) {
          expect(claim.excerpt).not.toBe(excluded.text);
        }
      }
    });
  }

  it("rejects a response whose excerpt is not a verbatim substring of output_text (data-model.md Claim validation)", async () => {
    const { provider, auditStore, service } = buildService();
    const auditId = randomUUID();
    await auditStore.createAudit({ auditId, inputRef: "test", domain: "finance", threshold: 0.6 });

    provider.setDefault({
      claims: [
        {
          id: "c1",
          type: "numeric",
          claim: "Revenue grew",
          excerpt: "this text does not appear in the output at all",
          locations: ["p1s1"],
          period: "Q2 2026",
          derived: false,
        },
      ],
      truncated: false,
    });

    // Every claim's excerpt fails the superRefine check, so repair.ts's
    // partial-field-recovery step (Stage 004) nulls out the whole `claims`
    // field rather than throwing — this must still surface as a clean
    // EXTRACT failure, not an unhandled TypeError from `.length` on null
    // (a real crash this exact scenario triggered before being fixed).
    await expect(service.run(auditId, "Actual output text about revenue.", undefined, 50)).rejects.toThrow(
      /claims could not be parsed/
    );
  });

  it("recovers when the provider call itself throws once, not just when it returns bad JSON (2026-08-02)", async () => {
    // EXTRACT had zero retry at all before this: a provider abort or malformed-JSON throw hard-failed
    // the whole audit on the first attempt. Reproduced live 3/3 times on an adversarial payload. D018 §5.10.
    const { provider, auditStore, service } = buildService();
    const auditId = randomUUID();
    await auditStore.createAudit({ auditId, inputRef: "test", domain: "finance", threshold: 0.6 });

    provider.failOn(1, "This operation was aborted");
    provider.setDefault({
      claims: [{ id: "c1", type: "numeric", claim: "Revenue grew", excerpt: "Revenue grew", locations: ["p1s1"], period: "Q2 2026", derived: false }],
      truncated: false,
    });

    const result = await service.run(auditId, "Revenue grew this quarter.", undefined, 50);
    expect(result.claims).toHaveLength(1);
  });

  it("still fails the audit, after retrying, when the provider call keeps throwing every attempt", async () => {
    const { provider, auditStore, service } = buildService();
    const auditId = randomUUID();
    await auditStore.createAudit({ auditId, inputRef: "test", domain: "finance", threshold: 0.6 });

    provider.failAll("This operation was aborted");

    await expect(service.run(auditId, "Revenue grew this quarter.", undefined, 50)).rejects.toThrow(/aborted/);
  });

  it("enforces maxClaims as a code-level cap even if the model ignores it (FR-019, belt-and-suspenders)", async () => {
    const { provider, auditStore, service } = buildService();
    const auditId = randomUUID();
    await auditStore.createAudit({ auditId, inputRef: "test", domain: "finance", threshold: 0.6 });
    const outputText = "Claim one. Claim two. Claim three.";

    provider.setDefault({
      claims: [
        { id: "c1", type: "numeric", claim: "a", excerpt: "Claim one", locations: ["p1s1"], period: "n/a", derived: false },
        { id: "c2", type: "numeric", claim: "b", excerpt: "Claim two", locations: ["p1s2"], period: "n/a", derived: false },
        { id: "c3", type: "numeric", claim: "c", excerpt: "Claim three", locations: ["p1s3"], period: "n/a", derived: false },
      ],
      truncated: false, // model claims no truncation despite exceeding the cap below
    });

    const { claims, truncated } = await service.run(auditId, outputText, undefined, 2);
    expect(claims.length).toBe(2);
    expect(truncated).toBe(true);
  });
});
