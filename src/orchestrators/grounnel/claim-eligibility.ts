import { z } from "zod";
import { callLlmForJson } from "../llm-json-call.js";
import { env } from "../../lib/env.js";
import type { Provider } from "../../providers/types.js";
import type { PromptRegistry } from "../../prompts/registry.js";
import type { GrounnelLlmCallStore } from "../../persistence/grounnel-llm-call-store.js";

const MODULE = "grounnel-claim-eligibility";
const ELIGIBILITY_ATTEMPTS = 3;

export interface ClaimVerifiabilityInput {
  claimText: string;
  // D028 — the claim's own verbatim source context, or null if EXTRACT didn't produce one. Required
  // to tell a private assertion ("I discovered X in 1928") apart from an attributed quote
  // ("'I discovered X in 1928,' said Fleming") — claim text alone can't make that distinction.
  sourceExcerpt: string | null;
}

export interface ClaimVerifiabilityResult {
  category: "checkable" | "personal" | "opinion" | "prediction";
  certainty: "clear" | "uncertain";
  reason: string;
}

const ClaimVerifiabilityResultSchema = z.object({
  category: z.enum(["checkable", "personal", "opinion", "prediction"]),
  certainty: z.enum(["clear", "uncertain"]),
  reason: z.string(),
});

// D030 §3b — any classifier failure (provider error, timeout, rate limit, malformed/schema-invalid
// output) fails open to "checkable"/"uncertain": a wrongly excluded checkable claim is worse than
// searching a claim that turns out unverifiable anyway. Never a basis for exclusion (tasks.md T013).
const FAIL_OPEN_RESULT: ClaimVerifiabilityResult = {
  category: "checkable",
  certainty: "uncertain",
  reason: "Eligibility classification unavailable — failed open to search.",
};

/**
 * D030 §3b, tasks.md T013 — pre-search eligibility classifier, additive to the existing
 * isOpinionClaim regex filter (opinion-filter.ts, unchanged). Only ever called for claims the
 * regex didn't already exclude (extract.service.ts wires it in after that call, not before).
 */
export async function classifyClaimVerifiability(
  provider: Provider,
  prompts: PromptRegistry,
  llmCallStore: GrounnelLlmCallStore,
  runId: string,
  claimId: string,
  input: ClaimVerifiabilityInput
): Promise<ClaimVerifiabilityResult> {
  const promptVersion = prompts.getGrounnelEligibilityVersion();
  const system = prompts.render("grounnel-eligibility", {
    claim_text: input.claimText,
    source_excerpt: input.sourceExcerpt ?? "(none)",
  });

  try {
    return await callLlmForJson({
      provider,
      system,
      user: "Return the JSON now.",
      schema: ClaimVerifiabilityResultSchema,
      expectedKeys: ["category", "certainty", "reason"],
      attempts: ELIGIBILITY_ATTEMPTS,
      module: MODULE,
      operation: "classifyClaimVerifiability",
      // repair.ts's partialParseObject nulls an individual field that fails its own sub-schema
      // (e.g. an invalid enum value) instead of throwing — without this check, a bad `category`
      // silently returns as `null` rather than triggering the retry/fail-open path T013 requires.
      isValid: (result) => result.category != null && result.certainty != null,
      onComplete: llmCallStore.recordCall({
        runId,
        claimId,
        stage: "extract",
        callType: "eligibility_check",
        provider: provider.mode,
        model: env.GEMINI_MODEL,
        promptVersion,
      }),
    });
  } catch {
    // callLlmForJson already logged/recorded every failed attempt — nothing left to do here but
    // fail open. Not re-logged: would just duplicate what callLlmForJson's own retries already emitted.
    return FAIL_OPEN_RESULT;
  }
}

/** D030 §3b policy (data-model.md §2) — conservative: excludes only on a clear non-checkable call. */
export function isEligibilityExcluded(result: ClaimVerifiabilityResult): boolean {
  return result.category !== "checkable" && result.certainty === "clear";
}
