import {
  insertGrounnelRun,
  updateGrounnelRun,
  insertGrounnelClaim,
  selectGrounnelRunByShareToken,
  selectGrounnelClaimsByRunId,
} from "../db/queries.js";
import { logger } from "../observability/logger.js";
import { SharedCountsSchema } from "../contracts/grounnel.schemas.js";
import type { ClaimSource, SharedAssessment } from "../contracts/grounnel.schemas.js";

const MODULE = "grounnel-history-store";

export interface GrounnelHistoryStore {
  createRun(data: {
    runId: string;
    shareToken: string;
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
      truncated: boolean;
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
    sourceExcerpt: string | null;
    verdict: "supported" | "partially_supported" | "unsupported" | "contradicted" | "unverifiable" | "excluded" | null;
    evidence: string | null;
    confidence: number | null;
    reason: string | null;
    sources: ClaimSource[];
    status: "done" | "failed";
  }): Promise<void>;

  /** Spec 019 T004 — the one read path. null when no run holds this token (FR-010). */
  readAssessmentByToken(shareToken: string): Promise<SharedAssessment | null>;
}

/**
 * D023 §7 — Postgres history is best-effort analytics, Redis remains the source of truth. Every
 * WRITE here catches and logs internally rather than throwing, so a caller never needs its own
 * try/catch to stay safe — matches executeAndRecordLlmCall's own pattern (llm-call-recorder.ts).
 *
 * `readAssessmentByToken` is the exception and deliberately throws: it is a real read serving a
 * request, so swallowing a database error would return "no such assessment" for a link that
 * exists. Spec 019 is the first thing to read these rows back.
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

  async readAssessmentByToken(shareToken: string): Promise<SharedAssessment | null> {
    const run = await selectGrounnelRunByShareToken(shareToken);
    if (!run) return null;

    // A run that failed, is still verifying, or never reached its first claim returns what exists
    // with its status attached (FR-011) — the state, not a partial dressed up as finished.
    const claims = await selectGrounnelClaimsByRunId(run.runId);
    // Prefer the snapshot written at completion over counting the rows below: those rows are
    // best-effort, and a dropped one would silently shrink the reader's denominators.
    const snapshot = (run.score as { counts?: unknown } | null)?.counts;
    const counts = SharedCountsSchema.safeParse(snapshot);

    return {
      status: run.status,
      text: run.text,
      createdAt: run.createdAt.toISOString(),
      completedAt: run.completedAt?.toISOString() ?? null,
      ...(counts.success ? { counts: counts.data } : {}),
      claims: claims.map((c) => ({
        text: c.claimText,
        verdict: c.verdict,
        evidence: c.evidence,
        confidence: c.confidence,
        reason: c.reason,
        sources: c.sources as ClaimSource[],
        sourceExcerpt: c.sourceExcerpt,
      })),
    };
  }
}
