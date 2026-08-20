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
  // D028 — the claim's own verbatim source context, or null if EXTRACT didn't produce one; see D030 §3b for why.
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

// D030 §3b, tasks.md T013 — any classifier failure fails open to "checkable"/"uncertain", never a basis for exclusion.
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
  // Review finding — try must cover rendering/version lookup too, not just the provider call, or fail-open doesn't hold.
  try {
    const promptVersion = prompts.getGrounnelEligibilityVersion();
    const system = prompts.render("grounnel-eligibility", {
      claim_text: input.claimText,
      source_excerpt: input.sourceExcerpt ?? "(none)",
    });

    return await callLlmForJson({
      provider,
      system,
      user: "Return the JSON now.",
      schema: ClaimVerifiabilityResultSchema,
      expectedKeys: ["category", "certainty", "reason"],
      attempts: ELIGIBILITY_ATTEMPTS,
      module: MODULE,
      operation: "classifyClaimVerifiability",
      // repair.ts nulls an individual invalid field instead of throwing — isValid forces the retry/fail-open path T013 requires.
      isValid: (result) => result.category != null && result.certainty != null && result.reason != null,
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

// Review finding — colocated with isEligibilityExcluded, not extract.service.ts: same D030 §3b policy.
export function eligibilityReason(category: ClaimVerifiabilityResult["category"]): string {
  switch (category) {
    case "personal":
      return "No public record could confirm or deny this — a private, speaker-relative circumstance (D030 §3b).";
    case "opinion":
      return "No checkable referent — opinion, not caught by the existing regex filter (D030 §3b).";
    case "prediction":
      return "No checkable referent — vague prediction, not caught by the existing regex filter (D030 §3b).";
    case "checkable":
      // Unreachable — callers only invoke this for isEligibilityExcluded results, which requires
      // category !== "checkable". Kept for exhaustiveness, not a real runtime path.
      return "No checkable referent (D030 §3b).";
  }
}
