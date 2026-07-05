import { logger } from "../observability/logger";
import type { RetrievalComparisonStore } from "../persistence/ports";
import type { RagCase } from "../rag/context-builder";

export interface RecordComparisonParams {
  sessionId: string;
  runId: string;
  ragList: string[];
  llmListRaw: string[];
  finalList: string[];
  ragCase: RagCase;
}

export async function recordComparison(
  params: RecordComparisonParams,
  store: RetrievalComparisonStore,
): Promise<void> {
  const { sessionId, runId, ragList, llmListRaw, finalList, ragCase } = params;

  const ragSet = new Set(ragList);
  const llmSet = new Set(llmListRaw);
  const finalSet = new Set(finalList);

  const overlap = new Set(ragList.filter(n => llmSet.has(n))).size;
  const ragOnly = new Set(ragList.filter(n => !llmSet.has(n))).size;
  const llmOnly = new Set(llmListRaw.filter(n => !ragSet.has(n))).size;
  const ragHitFinal = new Set(ragList.filter(n => finalSet.has(n))).size;
  const llmHitFinal = new Set(llmListRaw.filter(n => finalSet.has(n))).size;
  const normalizationAdditions = new Set(finalList.filter(n => !ragSet.has(n) && !llmSet.has(n))).size;

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
    });
  } catch (err) {
    logger.warn({ err, sessionId }, "comparison_record_failed");
  }
}
