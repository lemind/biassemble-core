import { logger } from "../../observability/logger.js";
import type { AuditStore } from "../../persistence/audit-store.js";

const MODULE = "gate-service";

/**
 * Verdict-gating (confidence-threshold enforcement) only. Score-summary
 * computation was originally scoped to Phase 4/US2 (T019's own text says so)
 * but was brought forward into this phase — see scores.ts's header comment
 * for why. It's *not* in this file: routes/audit.ts calls computeScores()
 * directly at GET-response-build time, kept separate from this class rather
 * than folded in, since gate.service.ts's job here is a write path (mutating
 * claim rows) and scores.ts's is a pure read-time computation — mixing them
 * would blur that distinction for no benefit.
 *
 * The retrieval-failure gate rule (data-model.md — a claim with
 * retrieval_status="error" must never resolve to "unsupported") is **not**
 * enforced here either, despite T019's text assigning it to this file — it's
 * enforced in verify.service.ts's runBatch, immediately where VERIFY's raw
 * verdict is first read, before persistence. Recorded here so a reader
 * looking for it in this file (per T019's literal wording) finds a pointer
 * instead of nothing.
 *
 * Note on `rates` (also deviates from T019's original text): T019 described
 * this service as populating `rates.findings_count`/`gated_out_count`. A
 * later Phase 1-2 review (contracts/audit-endpoint.md, D018 §2) established
 * that `rates` means bias-module findings specifically (D018 §3, out of
 * scope, always 0 in this feature) — that correction is more authoritative
 * than this task's original wording. Claim-gating counts aren't stuffed into
 * a field already redefined to mean something else; `scores.counts.X` is the
 * real aggregate now (see scores.ts).
 */
export class GateService {
  constructor(private auditStore: AuditStore) {}

  /**
   * Confidence-threshold enforcement is a code-level backstop, not just a
   * prompt instruction — VERIFY is asked to self-report "unverifiable" below
   * threshold, but D018 §2.3's "never guessed" guarantee has to be enforced
   * in code, the same belt-and-suspenders pattern already used for
   * EXTRACT's maxClaims cap (extract.service.ts).
   */
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
