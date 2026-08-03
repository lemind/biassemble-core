import { logger } from "../../observability/logger.js";
import type { AuditStore } from "../../persistence/audit-store.js";

const MODULE = "gate-service";

/**
 * Confidence-threshold gating only. Score computation lives in scores.ts (read-time, called from routes/audit.ts);
 * the retrieval-failure gate rule lives in verify.service.ts's runBatch. `rates` = bias-module findings only (D018 §3), always 0 here.
 */
export class GateService {
  constructor(private auditStore: AuditStore) {}

  /** Code-level backstop for D018 §2.3's "never guessed" guarantee, same pattern as EXTRACT's maxClaims cap. */
  async run(auditId: string, threshold: number): Promise<{ gatedCount: number }> {
    const allClaims = await this.auditStore.getClaimsByAudit(auditId);
    let gatedCount = 0;

    for (const claim of allClaims) {
      if (claim.confidence === null) continue; // not yet verified — nothing to gate
      if (claim.verdict === "unverifiable") continue; // already correctly gated
      if (claim.confidence >= threshold) continue;

      logger.info(
        { module: MODULE, operation: "run", auditId, claimId: claim.claimId, confidence: claim.confidence, threshold },
        "Gating claim to unverifiable — confidence below threshold"
      );
      await this.auditStore.updateClaimVerdict(claim.claimId, {
        verdict: "unverifiable",
        evidence: null,
        sourceRefs: [],
        synthesized: false,
        confidence: claim.confidence,
        note: `${claim.note ?? ""} [gated: confidence ${claim.confidence} below threshold ${threshold}]`.trim(),
      });
      gatedCount++;
    }

    return { gatedCount };
  }
}
