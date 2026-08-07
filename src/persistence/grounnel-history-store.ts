import { insertGrounnelRun, updateGrounnelRun, insertGrounnelClaim } from "../db/queries.js";
import { logger } from "../observability/logger.js";
import type { ClaimSource } from "../contracts/grounnel.schemas.js";

const MODULE = "grounnel-history-store";

export interface GrounnelHistoryStore {
  createRun(data: {
    runId: string;
    sessionId: string | null;
    text: string;
    source: "production" | "eval";
    maxClaims: number;
    truncated: boolean;
  }): Promise<void>;

  updateRun(
    runId: string,
    data: Partial<{
      status: "extracting" | "verifying" | "done" | "failed";
      promptVersionExtract: string;
      promptVersionVerify: string;
      score: unknown;
      completedAt: Date;
    }>
  ): Promise<void>;

  createClaim(data: {
    claimId: string;
    runId: string;
    claimText: string;
    verdict: "supported" | "partially_supported" | "unsupported" | "contradicted" | "unverifiable" | null;
    evidence: string | null;
    confidence: number | null;
    reason: string | null;
    sources: ClaimSource[];
    status: "done" | "failed";
  }): Promise<void>;
}

/**
 * D023 §7 — Postgres history is best-effort analytics, Redis remains the source of truth. Every
 * method here catches and logs internally rather than throwing, so a caller never needs its own
 * try/catch to stay safe — matches executeAndRecordLlmCall's own pattern (llm-call-recorder.ts).
 */
export class DrizzleGrounnelHistoryStore implements GrounnelHistoryStore {
  async createRun(data: Parameters<GrounnelHistoryStore["createRun"]>[0]): Promise<void> {
    try {
      await insertGrounnelRun(data);
    } catch (err) {
      logger.warn({ module: MODULE, operation: "createRun", runId: data.runId, err }, "Failed to write grounnel_runs row — Redis remains authoritative (D023 §7)");
    }
  }

  async updateRun(runId: string, data: Parameters<GrounnelHistoryStore["updateRun"]>[1]): Promise<void> {
    try {
      await updateGrounnelRun(runId, data);
    } catch (err) {
      logger.warn({ module: MODULE, operation: "updateRun", runId, err }, "Failed to update grounnel_runs row — Redis remains authoritative (D023 §7)");
    }
  }

  async createClaim(data: Parameters<GrounnelHistoryStore["createClaim"]>[0]): Promise<void> {
    try {
      await insertGrounnelClaim(data);
    } catch (err) {
      logger.warn({ module: MODULE, operation: "createClaim", claimId: data.claimId, err }, "Failed to write grounnel_claims row — Redis remains authoritative (D023 §7)");
    }
  }
}
