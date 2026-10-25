import { logger } from "../observability/logger.js";

/** Stages billed to the visitor key. Web search (discovery) uses Grounnel's account and is excluded (T2018). */
export const GROUNNEL_JUDGING_STAGES = ["extract", "verify"] as const;

export interface JudgingTokenRow {
  stage: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface OwnKeyTokens {
  input: number;
  output: number;
}

/** Sum of judging rows only. Null token cells count as 0. Any other stage, including discovery, is skipped. */
export function sumJudgingTokenRows(rows: readonly JudgingTokenRow[]): OwnKeyTokens {
  let input = 0;
  let output = 0;
  const judgingStages: readonly string[] = GROUNNEL_JUDGING_STAGES;
  for (const row of rows) {
    if (!judgingStages.includes(row.stage)) continue;
    input += row.inputTokens ?? 0;
    output += row.outputTokens ?? 0;
  }
  return { input, output };
}

/** Null unless this run spent the visitor's key and has finished. Totals stay hidden while the check is still running. */
export function ownKeyTokensForRun(
  keySource: string | null | undefined,
  status: string,
  totals: OwnKeyTokens | null,
): OwnKeyTokens | null {
  if (keySource !== "own" || (status !== "done" && status !== "failed") || !totals) return null;
  return { input: totals.input, output: totals.output };
}

interface OwnKeyTokenStore {
  hasOwnKey(auditId: string): Promise<boolean>;
  writeOwnKeyTokens(auditId: string, input: number, output: number): Promise<void>;
}

/** One snapshot after the run finishes. A failure leaves the status field null ("not yet known") and does not log a key. */
export async function publishOwnKeyTokens(
  runId: string,
  store: OwnKeyTokenStore,
  sumJudgingTokens: (runId: string) => Promise<OwnKeyTokens>,
): Promise<void> {
  try {
    if (!(await store.hasOwnKey(runId))) return;
    const totals = await sumJudgingTokens(runId);
    await store.writeOwnKeyTokens(runId, totals.input, totals.output);
  } catch (err) {
    logger.warn({ module: "own-key-tokens", operation: "publish", runId, err }, "Own-key token totals were not stored");
  }
}
