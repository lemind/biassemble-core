import { waitUntil } from "@vercel/functions";
import { insertGrounnelLlmCall } from "../db/queries.js";
import { logger } from "../observability/logger.js";
import type { LlmCallCompletionInfo } from "../orchestrators/llm-json-call.js";

const MODULE = "grounnel-llm-call-store";

export interface GrounnelLlmCallStore {
  recordCall(data: {
    runId: string;
    // D026 §19 — omit for a batched call covering multiple claims (primary VERIFY, batched
    // consistency_check); only genuinely single-claim calls should ever pass this.
    claimId?: string;
    stage: "extract" | "verify";
    callType: "primary" | "fallback" | "consistency_retry" | "consistency_check" | "fill_in" | "passage_rerank" | "eligibility_check" | "instance_attribution" | "attribution_experiment";
    provider: string;
    model: string;
    promptVersion: string;
  }): (info: LlmCallCompletionInfo) => void;
}

/**
 * D023 §4 — own table, mirrors core.llm_calls' shape. recordCall returns a closure meant to be
 * passed directly as callLlmForJson's `onComplete` — the caller only needs to supply the
 * call-level context (runId/stage/etc) once, not repeat it on every attempt.
 */
export class DrizzleGrounnelLlmCallStore implements GrounnelLlmCallStore {
  recordCall(context: {
    runId: string;
    claimId?: string;
    stage: "extract" | "verify";
    callType: "primary" | "fallback" | "consistency_retry" | "consistency_check" | "fill_in" | "passage_rerank" | "eligibility_check" | "instance_attribution" | "attribution_experiment";
    provider: string;
    model: string;
    promptVersion: string;
  }): (info: LlmCallCompletionInfo) => void {
    return (info: LlmCallCompletionInfo) => {
      waitUntil(insertGrounnelLlmCall({
        ...context,
        rawResponse: info.raw !== null ? JSON.stringify(info.raw) : null,
        parsedOutput: info.parsedOutput,
        status: info.status,
        failureType: info.failureType,
        inputTokens: info.inputTokens,
        outputTokens: info.outputTokens,
        totalTokens: info.totalTokens,
        startedAt: info.startedAt,
        endedAt: info.endedAt,
        durationMs: info.durationMs,
        errorMessage: info.errorMessage,
      }).catch((err) => {
        logger.warn({ module: MODULE, operation: "recordCall", runId: context.runId, err }, "Failed to write grounnel_llm_calls row — Redis remains authoritative (D023 §7)");
      }));
    };
  }
}
