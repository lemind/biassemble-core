import { waitUntil } from "@vercel/functions";
import { insertGrounnelRerankDecisions } from "../db/queries.js";
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

/** D026 §19 — GrounnelPipelineService's constructor defaults to this rather than requiring every
 * one of its ~40 existing test/production call sites to start passing a store for a purely
 * additive, best-effort telemetry feature (D023 §7's own philosophy: never on the critical path).
 * Lives here, not in tests/mocks/ — a production default must not import test-only code. */
export class NoopGrounnelRerankDecisionStore implements GrounnelRerankDecisionStore {
  recordRerankDecisions(): void {}
}
