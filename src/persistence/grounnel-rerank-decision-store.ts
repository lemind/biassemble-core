import { waitUntil } from "@vercel/functions";
import { insertGrounnelRerankDecisions, getSelectedPassagesForClaim } from "../db/queries.js";
import { logger } from "../observability/logger.js";

export interface RerankDecisionInput {
  url: string;
  lexicalScore: number;
  llmScore: number;
  combinedScore: number;
  selected: boolean;
}

export interface GrounnelRerankDecisionStore {
  /** Fire-and-forget (D023 §7, same convention as recordGateEvents). Only called on rerankPassages'
   * success path — a failed rerank call falls back to lexical+gate#4 alone, nothing was decided. */
  recordRerankDecisions(runId: string, claimId: string, decisions: RerankDecisionInput[]): void;
}

export class DrizzleGrounnelRerankDecisionStore implements GrounnelRerankDecisionStore {
  recordRerankDecisions(runId: string, claimId: string, decisions: RerankDecisionInput[]): void {
    if (decisions.length === 0) return;
    const rows = decisions.map((d) => ({ runId, claimId, ...d }));
    waitUntil(
      insertGrounnelRerankDecisions(rows).catch((err) => {
        logger.warn({ module: "grounnel-rerank-decision-store", operation: "recordRerankDecisions", runId, claimId, err }, "Failed to write grounnel_rerank_decisions rows");
      })
    );
  }
}

/** Spec 013 T22 — reads back what recordRerankDecisions/insertGrounnelSearchPage wrote for one
 * claim, so the T22 A/B job can reconstruct passage text by (runId, claimId) instead of carrying it
 * through Inngest step outputs (the 413 root cause — Inngest replays every prior step's return
 * value on each new invocation, and full passage text across dozens of steps blew past Vercel's
 * request size limit). Both writes are fire-and-forget (waitUntil, D023 §7), so a short retry
 * covers the gap between the fixture step's response and its background writes actually landing —
 * sized generously (5 × 400ms) since this runs once per VERIFY replay, not on a user-facing path. */
export async function readSelectedPassages(runId: string, claimId: string): Promise<Array<{ url: string; text: string }>> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const rows = await getSelectedPassagesForClaim(runId, claimId);
    if (rows.length > 0) return rows;
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 400));
  }
  // Review finding, fixed: this used to return [] silently. Indistinguishable from "genuinely no
  // evidence" without this — a claim with a real subject_entity mismatch or dead search results
  // looks identical in the caller's data to one whose fixture write simply hadn't landed yet.
  logger.warn({ module: "grounnel-rerank-decision-store", operation: "readSelectedPassages", runId, claimId }, "No selected passages found after 5 retries (2s) — either genuinely no evidence, or the fixture write hasn't landed yet");
  return [];
}

/** D026 §19 — GrounnelPipelineService's constructor defaults to this rather than requiring every
 * one of its ~40 existing test/production call sites to start passing a store for a purely
 * additive, best-effort telemetry feature (D023 §7's own philosophy: never on the critical path).
 * Lives here, not in tests/mocks/ — a production default must not import test-only code. */
export class NoopGrounnelRerankDecisionStore implements GrounnelRerankDecisionStore {
  recordRerankDecisions(): void {}
}
