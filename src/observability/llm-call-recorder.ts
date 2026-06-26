import type { LlmCallStore } from "../persistence/ports";
import type { LlmCallStage, LlmCallType, LlmCallStatus, LlmCallFailureType } from "../persistence/types";
import type { ProviderResponse } from "../providers/types";
import { TimeoutError } from "../providers/types";
import { logger } from "./logger";

const MODULE = "llm-call-recorder";

/**
 * Metadata required to record an LLM call.
 */
export interface LlmCallMetadata {
  sessionId: string | null;
  stage: LlmCallStage;
  callType: LlmCallType;
  provider: string;
  model: string;
  promptVersion: string;
}

/**
 * Executes a provider call and records it to llm_calls table.
 * Handles timing, error capture, and token usage extraction.
 * Returns both the result and the LLM call ID for later parsed_output updates.
 */
export async function executeAndRecordLlmCall<T>(
  call: () => Promise<ProviderResponse<T>>,
  metadata: LlmCallMetadata,
  store: LlmCallStore
): Promise<{ result: T; llmCallId: string | null }> {
  const startedAt = new Date();
  const t0 = Date.now();

  let raw: T | undefined;
  let status: LlmCallStatus = "success";
  let failureType: LlmCallFailureType | null = null;
  let errorMessage: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let totalTokens: number | null = null;
  let llmCallId: string | null = null;

  try {
    const response = await call();
    raw = response.result;
    inputTokens = response.usage?.inputTokens ?? null;
    outputTokens = response.usage?.outputTokens ?? null;
    totalTokens = response.usage?.totalTokens ?? null;
  } catch (err) {
    if (err instanceof TimeoutError) {
      status = "timeout";
      failureType = "timeout";
    } else {
      status = "error";
      failureType = "provider_error";
    }
    errorMessage = (err as Error).message ?? String(err);
    throw err;
  } finally {
    const endedAt = new Date();
    const durationMs = Date.now() - t0;
    try {
      const record = await store.recordCall({
        sessionId: metadata.sessionId,
        stage: metadata.stage,
        callType: metadata.callType,
        provider: metadata.provider,
        model: metadata.model,
        promptVersion: metadata.promptVersion,
        rawResponse: raw !== undefined ? JSON.stringify(raw) : null,
        parsedOutput: null,
        status,
        failureType,
        inputTokens,
        outputTokens,
        totalTokens,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs,
        errorMessage,
      });
      llmCallId = record?.id ?? null;
    } catch (err) {
      logger.warn(
        { module: MODULE, operation: "recordLlmCall", error: err },
        "Failed to record LLM call"
      );
    }
  }

  return { result: raw as T, llmCallId };
}
