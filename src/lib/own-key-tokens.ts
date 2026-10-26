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

/** Live judging totals for a finished own-key run. Site-paid and in-progress stay null. A read failure is null, not a frozen 0. */
export async function ownKeyTokensAtServe(
  runId: string,
  keySource: string | null | undefined,
  status: string,
  sumJudgingTokens: (runId: string) => Promise<OwnKeyTokens>,
): Promise<OwnKeyTokens | null> {
  if (keySource !== "own" || (status !== "done" && status !== "failed")) return null;
  try {
    return ownKeyTokensForRun(keySource, status, await sumJudgingTokens(runId));
  } catch (err) {
    logger.warn({ module: "own-key-tokens", operation: "serve", runId, err }, "Own-key token totals were not read");
    return null;
  }
}
