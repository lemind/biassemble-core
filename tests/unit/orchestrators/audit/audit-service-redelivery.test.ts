import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { AuditService } from "../../../../src/orchestrators/audit/audit.service.js";
import { AuditImmutableError } from "../../../../src/persistence/audit-store.js";
import { MockAuditStore } from "../../../mocks/mock-audit-store.js";
import type { ExtractService } from "../../../../src/orchestrators/audit/extract.service.js";
import type { VerifyService } from "../../../../src/orchestrators/audit/verify.service.js";
import type { GateService } from "../../../../src/orchestrators/audit/gate.service.js";

/**
 * Regression test (found during a code-review pass after Phase 5's T035
 * immutability guard landed): a redelivered pipeline event re-running
 * AuditService.run() for an already-complete audit must fail quietly, not
 * throw a second, uncaught AuditImmutableError out of markFailed()'s own
 * updateAudit() call.
 */
describe("AuditService — redelivered event for an already-complete audit (markFailed self-throw regression)", () => {
  it("run() resolves without throwing when a stage's write is blocked by the immutability guard", async () => {
    const auditStore = new MockAuditStore();
    const auditId = randomUUID();
    await auditStore.createAudit({ auditId, inputRef: "test", domain: "finance", threshold: 0.6 });
    await auditStore.updateAudit(auditId, { status: "complete", completedAt: new Date() });

    const throwingExtractService = {
      run: async () => {
        throw new AuditImmutableError(auditId);
      },
    } as unknown as ExtractService;
    const unusedVerifyService = {} as VerifyService;
    const unusedGateService = {} as GateService;

    const auditService = new AuditService(throwingExtractService, unusedVerifyService, unusedGateService, auditStore, "test-version");

    await expect(auditService.run(auditId, {
      outputText: "text",
      sources: [],
      task: undefined,
      threshold: 0.6,
      maxClaims: 50,
    })).resolves.toBeUndefined();

    // The audit is left exactly as it already was — still "complete", not
    // silently flipped to "failed" by a guard that (correctly) refused to
    // touch an already-terminal audit.
    const audit = await auditStore.getAudit(auditId);
    expect(audit?.status).toBe("complete");
  });

  it("a redelivered event for an already-FAILED audit is also blocked (guard originally only covered 'complete')", async () => {
    const auditStore = new MockAuditStore();
    const auditId = randomUUID();
    await auditStore.createAudit({ auditId, inputRef: "test", domain: "finance", threshold: 0.6 });
    await auditStore.updateAudit(auditId, {
      status: "failed",
      failedStage: "extract",
      errorSummary: "original failure",
      completedAt: new Date(),
    });

    const throwingExtractService = {
      run: async () => {
        throw new AuditImmutableError(auditId);
      },
    } as unknown as ExtractService;

    const auditService = new AuditService(
      throwingExtractService,
      {} as VerifyService,
      {} as GateService,
      auditStore,
      "test-version"
    );

    await expect(
      auditService.run(auditId, { outputText: "text", sources: [], task: undefined, threshold: 0.6, maxClaims: 50 })
    ).resolves.toBeUndefined();

    // Still "failed" with the ORIGINAL error — a redelivered event must not
    // insert a duplicate claim set or silently resurrect a terminal audit.
    const audit = await auditStore.getAudit(auditId);
    expect(audit?.status).toBe("failed");
    expect(audit?.errorSummary).toBe("original failure");
  });

  it("a genuine (non-immutability) failure while recording a failure still propagates, not silently swallowed", async () => {
    const auditStore = new MockAuditStore();
    const auditId = randomUUID();
    await auditStore.createAudit({ auditId, inputRef: "test", domain: "finance", threshold: 0.6 });

    const throwingExtractService = {
      run: async () => {
        throw new Error("genuine extraction failure");
      },
    } as unknown as ExtractService;
    // updateAudit throws something OTHER than AuditImmutableError — e.g. a
    // transient DB error — while markFailed is trying to record the above.
    const brokenAuditStore = {
      ...auditStore,
      getAudit: auditStore.getAudit.bind(auditStore),
      updateAudit: async () => {
        throw new Error("transient DB error");
      },
    };

    const auditService = new AuditService(
      throwingExtractService,
      {} as VerifyService,
      {} as GateService,
      brokenAuditStore as unknown as typeof auditStore,
      "test-version"
    );

    // Must reject with the transient DB error, not resolve silently — a
    // caller (jobs/audit-run.ts) needs to see this as a real failure so
    // Inngest can retry/alert, instead of believing the run finished.
    await expect(
      auditService.run(auditId, { outputText: "text", sources: [], task: undefined, threshold: 0.6, maxClaims: 50 })
    ).rejects.toThrow("transient DB error");
  });
});
