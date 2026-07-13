import { logger } from "../observability/logger";
import type { RetrievalComparisonStore } from "../persistence/ports";
import type { RagCase } from "../rag/context-builder";
import { buildBiasWorkspace, buildSourceListsFromWorkspace } from "../rag/workspace-builder";
import type { RagClientResult } from "../rag/engine-client";
import type { BiasEntry } from "../catalog/bias-catalog";

export interface RecordComparisonParams {
  sessionId: string;
  runId: string;
  ragList: string[];
  /** Per-source name lists (D017) — keyed by whatever source name is present; a bias found by
   * two sources appears in both entries' lists. No "both" key. */
  sourceLists: Record<string, string[]>;
  llmListRaw: string[];
  finalList: string[];
  ragCase: RagCase;
  selectionStrategy?: string;
  llmModel?: string;
}

interface DerivedStats {
  overlap: number;
  ragOnly: number;
  llmOnly: number;
  ragHitFinal: number;
  llmHitFinal: number;
  normalizationAdditions: number;
  sourceBreakdown: Record<string, { list: string[]; hitFinal: number }> | null;
}

/**
 * Pure derivation shared by the initial INSERT (recordComparison) and the later UPDATE
 * (backfillComparisonSourceData) paths — both need the exact same math, just against
 * different ragList/sourceLists inputs (empty vs. now-available). Kept in one place so a
 * backfill can never silently compute these differently than the original write did.
 */
function computeDerivedStats(params: {
  ragList: string[];
  sourceLists: Record<string, string[]>;
  llmListRaw: string[];
  finalList: string[];
}): DerivedStats {
  const { ragList, sourceLists, llmListRaw, finalList } = params;

  const ragSet = new Set(ragList);
  const llmSet = new Set(llmListRaw);
  const finalSet = new Set(finalList);

  const overlap = new Set(ragList.filter(n => llmSet.has(n))).size;
  const ragOnly = new Set(ragList.filter(n => !llmSet.has(n))).size;
  const llmOnly = new Set(llmListRaw.filter(n => !ragSet.has(n))).size;
  const ragHitFinal = new Set(ragList.filter(n => finalSet.has(n))).size;
  const llmHitFinal = new Set(llmListRaw.filter(n => finalSet.has(n))).size;
  const normalizationAdditions = new Set(finalList.filter(n => !ragSet.has(n) && !llmSet.has(n))).size;

  // Generic per-source breakdown (D017 Decision 3) — no "vector"/"llm" special-casing, no
  // hardcoded "both" key. A source-name-agnostic loop over whatever sourceLists holds, so a
  // future third source needs no change here. NULL (not {}) when there's nothing to report,
  // so `source_breakdown IS NOT NULL` is a valid quick filter.
  const sourceEntries = Object.entries(sourceLists);
  const sourceBreakdown = sourceEntries.length > 0
    ? Object.fromEntries(
        sourceEntries.map(([source, list]) => [
          source,
          { list, hitFinal: list.filter(n => finalSet.has(n)).length },
        ]),
      )
    : null;

  return { overlap, ragOnly, llmOnly, ragHitFinal, llmHitFinal, normalizationAdditions, sourceBreakdown };
}

export async function recordComparison(
  params: RecordComparisonParams,
  store: RetrievalComparisonStore,
): Promise<void> {
  const { sessionId, runId, ragList, sourceLists, llmListRaw, finalList, ragCase, selectionStrategy, llmModel } = params;

  const stats = computeDerivedStats({ ragList, sourceLists, llmListRaw, finalList });

  try {
    await store.record({
      sessionId,
      runId: runId || null,
      ragList,
      llmList: llmListRaw,
      finalList,
      ...stats,
      ragStatus: ragCase,
      selectionStrategy: selectionStrategy ?? null,
      llmModel: llmModel ?? null,
    });
    // This is the ONLY place that knows whether the write actually landed — the caller's
    // promise always resolves regardless (this function never rethrows), so logging success
    // has to happen here, not at the call site.
    logger.info({ sessionId, runId, ragCase, hasSourceBreakdown: stats.sourceBreakdown !== null }, "comparison_record_ok");
  } catch (err) {
    logger.warn({ err, sessionId, runId, ragCase }, "comparison_record_failed");
  }
}

/**
 * D017 backfill: RAG retrieval regularly takes 35s-120s+ to complete (measured against live
 * production data — see docs/decisions), while recordComparison fires immediately after the
 * assessment LLM call finishes. Most real requests therefore record rag_status="unavailable"
 * even though RAG succeeds moments later — and until this function existed, that data was
 * permanently lost; nothing ever went back to fill it in.
 *
 * Called from the RAG background job (rag-retrieve.ts) right after it successfully stores a
 * result — reuses that same result to patch any comparison row for this session still stuck
 * at "unavailable" with no source_breakdown. llmList/finalList are frozen (the assessment
 * LLM's output doesn't change); only the RAG-derived fields get recomputed and rewritten.
 *
 * Fire-and-forget per row (D011) — one row's write failure doesn't stop the others, and a
 * failure here never propagates back to the RAG job that's calling this.
 */
export async function backfillComparisonSourceData(
  sessionId: string,
  ragResult: RagClientResult,
  catalog: BiasEntry[],
  store: RetrievalComparisonStore,
): Promise<void> {
  const workspace = buildBiasWorkspace(ragResult, catalog);
  if (workspace.workspaceCase !== "retrieved") {
    // Nothing new to backfill with — this RAG attempt didn't produce a usable result either.
    return;
  }

  const candidates = await store.findUnbackfilledBySession(sessionId);
  if (candidates.length === 0) return;

  const ragList = workspace.candidates.map((c) => c.name);
  const sourceLists = buildSourceListsFromWorkspace(workspace);
  const selectionStrategy = ragResult.status === "ok" ? ragResult.data.selection_strategy ?? null : null;
  const llmModel = ragResult.status === "ok" ? ragResult.data.llm_model ?? null : null;

  for (const row of candidates) {
    try {
      const stats = computeDerivedStats({ ragList, sourceLists, llmListRaw: row.llmList, finalList: row.finalList });
      await store.backfillSourceData(row.id, {
        ragList,
        // "backfilled", not "retrieved" — RAG arrived after the assessment already ran and
        // decided finalList without it; this only makes the data usable for retrospective
        // analysis, it did not inform the output. See RagStatus in persistence/types.ts.
        ragStatus: "backfilled",
        ragOnly: stats.ragOnly,
        llmOnly: stats.llmOnly,
        overlap: stats.overlap,
        ragHitFinal: stats.ragHitFinal,
        normalizationAdditions: stats.normalizationAdditions,
        sourceBreakdown: stats.sourceBreakdown,
        selectionStrategy,
        llmModel,
      });
      logger.info({ sessionId, comparisonId: row.id }, "comparison_backfill_ok");
    } catch (err) {
      logger.warn({ err, sessionId, comparisonId: row.id }, "comparison_backfill_failed");
    }
  }
}
