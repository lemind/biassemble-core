import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../../../src/orchestrators/audit/audit.service.js";
import { MockAuditStore } from "../../../mocks/mock-audit-store.js";
import type { ExtractService } from "../../../../src/orchestrators/audit/extract.service.js";
import type { VerifyService } from "../../../../src/orchestrators/audit/verify.service.js";
import type { GateService } from "../../../../src/orchestrators/audit/gate.service.js";
import type { LlmCallStore, LlmCallRecord } from "../../../../src/persistence/ports.js";

/**
 * T040 — per-audit token/call cost telemetry. extract.service.ts and
 * verify.service.ts now record LLM calls with sessionId = auditId (not
 * null), so getCallsBySession(auditId) can attribute cost back to a run;
 * AuditService logs a summary once the audit completes.
 */
describe("AuditService — per-audit cost telemetry (T040)", () => {
  it("fetches this audit's LLM calls via getCallsBySession(auditId) once the run completes", async () => {
    const auditStore = new MockAuditStore();
    const auditId = randomUUID();
    await auditStore.createAudit({ auditId, inputRef: "test", domain: "finance", threshold: 0.6 });

    const noOpExtractService = { run: async () => ({ claims: [], truncated: false }) } as unknown as ExtractService;
    const noOpVerifyService = { run: async () => {} } as unknown as VerifyService;
    const noOpGateService = { run: async () => ({ gatedCount: 0 }) } as unknown as GateService;

    const fakeCalls: LlmCallRecord[] = [
      { inputTokens: 100, outputTokens: 50, totalTokens: 150 } as LlmCallRecord,
      { inputTokens: 200, outputTokens: 80, totalTokens: 280 } as LlmCallRecord,
    ];
    const getCallsBySession = vi.fn().mockResolvedValue(fakeCalls);
    const llmCallStore = { getCallsBySession } as unknown as LlmCallStore;

    const auditService = new AuditService(
      noOpExtractService,
      noOpVerifyService,
      noOpGateService,
      auditStore,
      "test-version",
      llmCallStore
    );

    await auditService.run(auditId, { outputText: "text", sources: [], task: undefined, threshold: 0.6, maxClaims: 50 });

    expect(getCallsBySession).toHaveBeenCalledWith(auditId);
    const audit = await auditStore.getAudit(auditId);
    expect(audit?.status).toBe("complete");
  });

  it("a telemetry failure never affects the audit's own completed status", async () => {
    const auditStore = new MockAuditStore();
    const auditId = randomUUID();
    await auditStore.createAudit({ auditId, inputRef: "test", domain: "finance", threshold: 0.6 });

    const noOpExtractService = { run: async () => ({ claims: [], truncated: false }) } as unknown as ExtractService;
    const noOpVerifyService = { run: async () => {} } as unknown as VerifyService;
    const noOpGateService = { run: async () => ({ gatedCount: 0 }) } as unknown as GateService;
    const throwingLlmCallStore = {
      getCallsBySession: vi.fn().mockRejectedValue(new Error("db unavailable")),
    } as unknown as LlmCallStore;

    const auditService = new AuditService(
      noOpExtractService,
      noOpVerifyService,
      noOpGateService,
      auditStore,
      "test-version",
      throwingLlmCallStore
    );

    await expect(
      auditService.run(auditId, { outputText: "text", sources: [], task: undefined, threshold: 0.6, maxClaims: 50 })
    ).resolves.toBeUndefined();

    const audit = await auditStore.getAudit(auditId);
    expect(audit?.status).toBe("complete");
  });
});
