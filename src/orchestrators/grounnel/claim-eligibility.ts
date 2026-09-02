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
  // Spec 013 T27 (D032 §13) — orthogonal to category/certainty: does the claim name WHO/WHAT the
  // predicate attaches to, resolvable from claim + sourceExcerpt. Not "can I personally identify it".
  hasResolvableReferent: boolean;
}

// Field order is load-bearing — hasResolvableReferent LAST so it reads `reason` and can't perturb
// category/certainty (Gemini generates in schema order). See D032 §13.
const ClaimVerifiabilityResultSchema = z.object({
  category: z.enum(["checkable", "personal", "opinion", "prediction"]),
  certainty: z.enum(["clear", "uncertain"]),
  reason: z.string(),
  hasResolvableReferent: z.boolean(),
});

// D030 §3b, tasks.md T013 — any classifier failure fails open to "checkable"/"uncertain", never a basis for exclusion.
// T27: hasResolvableReferent true here for the same reason — a failed call must never exclude.
const FAIL_OPEN_RESULT: ClaimVerifiabilityResult = {
  category: "checkable",
  certainty: "uncertain",
  reason: "Eligibility classification unavailable — failed open to search.",
  hasResolvableReferent: true,
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
  input: ClaimVerifiabilityInput,
  // Experiment seam (T27b) — an already-rendered system prompt to use instead of the registry's.
  // Production never passes this; only the prompt-variant screen does.
  systemOverride?: { text: string; version: string }
): Promise<ClaimVerifiabilityResult> {
  // Review finding — try must cover rendering/version lookup too, not just the provider call, or fail-open doesn't hold.
  try {
    const promptVersion = systemOverride?.version ?? prompts.getGrounnelEligibilityVersion();
    const system = systemOverride?.text ?? prompts.render("grounnel-eligibility", {
      claim_text: input.claimText,
      source_excerpt: input.sourceExcerpt ?? "(none)",
    });

    return await callLlmForJson({
      provider,
      system,
      user: "Return the JSON now.",
      schema: ClaimVerifiabilityResultSchema,
      expectedKeys: ["category", "certainty", "reason", "hasResolvableReferent"],
      attempts: ELIGIBILITY_ATTEMPTS,
      module: MODULE,
      operation: "classifyClaimVerifiability",
      // repair.ts nulls an individual invalid field instead of throwing — isValid forces the retry/fail-open path T013 requires.
      isValid: (result) =>
        result.category != null && result.certainty != null && result.reason != null && typeof result.hasResolvableReferent === "boolean",
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

/** D030 §3b category ground first, then T27's referent ground for checkable claims only (D032 §13). Strict `=== false` so a null/absent field never excludes. */
export function isEligibilityExcluded(result: ClaimVerifiabilityResult): boolean {
  if (result.category !== "checkable" && result.certainty === "clear") return true;
  return result.category === "checkable" && result.hasResolvableReferent === false;
}

// Precedence must match isEligibilityExcluded — category first, or an opinion gets told it
// "doesn't say what it's about", which is false. D032 §13.
export function eligibilityReason(result: ClaimVerifiabilityResult): string {
  switch (result.category) {
    case "personal":
      return "This describes a private, personal circumstance that no public record could confirm or deny.";
    case "opinion":
      return "This is a subjective opinion, not a checkable fact.";
    case "prediction":
      return "This is a prediction about the future, not something that can be checked yet.";
    case "checkable":
      return "This doesn't say who or what it's about, so there's nothing specific to check.";
  }
}
