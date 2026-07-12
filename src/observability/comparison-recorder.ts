import { logger } from "../observability/logger";
import type { RetrievalComparisonStore } from "../persistence/ports";
import type { RagCase } from "../rag/context-builder";

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

export async function recordComparison(
  params: RecordComparisonParams,
  store: RetrievalComparisonStore,
): Promise<void> {
  const { sessionId, runId, ragList, sourceLists, llmListRaw, finalList, ragCase, selectionStrategy, llmModel } = params;

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

  try {
    await store.record({
      sessionId,
      runId: runId || null,
      ragList,
      llmList: llmListRaw,
      finalList,
      overlap,
      ragOnly,
      llmOnly,
      ragHitFinal,
      llmHitFinal,
      normalizationAdditions,
      ragStatus: ragCase,
      sourceBreakdown,
      selectionStrategy: selectionStrategy ?? null,
      llmModel: llmModel ?? null,
    });
  } catch (err) {
    logger.warn({ err, sessionId }, "comparison_record_failed");
  }
}
