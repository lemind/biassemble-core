import { randomUUID } from "node:crypto";
import { z } from "zod";
import { callLlmForJson } from "../llm-json-call.js";
import { isOpinionClaim } from "./opinion-filter.js";
import type { Provider } from "../../providers/types.js";
import type { PromptRegistry } from "../../prompts/registry.js";
import type { GrounnelStore } from "../../persistence/grounnel-store.js";

const MODULE = "grounnel-extract-service";
/** Matches audit's EXTRACT retry count (D018 §5.10) — a provider hiccup shouldn't hard-fail the whole run. */
const EXTRACT_ATTEMPTS = 3;
// spec.md Assumption 6 — the real number is still an open, ask-first question. This is a
// placeholder so the service is runnable, not a tuned decision (tasks.md T009).
const MAX_CLAIMS = 100;

const ExtractResponseSchema = z.object({
  claims: z.array(z.object({ claim: z.string() })),
  truncated: z.boolean(),
});

export interface GrounnelExtractResult {
  id: string;
}

/**
 * EXTRACT + gate #3 (D019 §1/§2, tasks.md T009). Deliberately does NOT reuse audit's
 * executeAndRecordLlmCall/LlmCallStore — that path is Drizzle/Postgres-backed, which would
 * violate spec.md's "No Postgres dependency anywhere in this surface" (D019 §4). Cost
 * observability for Grounnel's own LLM calls is a known, named gap, not a silent drop.
 */
export class GrounnelExtractService {
  constructor(
    private provider: Provider,
    private prompts: PromptRegistry,
    private grounnelStore: GrounnelStore
  ) {}

  async run(text: string): Promise<GrounnelExtractResult> {
    const system = this.prompts.render("grounnel-extract", { text, maxClaims: String(MAX_CLAIMS) });

    const parsed = await callLlmForJson({
      provider: this.provider,
      system,
      user: "Return the JSON now.",
      schema: ExtractResponseSchema,
      expectedKeys: ["claims", "truncated"],
      attempts: EXTRACT_ATTEMPTS,
      module: MODULE,
      operation: "run",
      isValid: (result) => !!result.claims,
    });

    // Belt-and-suspenders cap enforcement, same rationale as audit's extract.service.ts — a cap
    // only the model enforces isn't really a cap. Computed before slicing so it reflects an
    // actual cut, not re-derived later from a count that could legitimately equal the cap.
    let claimTexts = parsed.claims.map((c) => c.claim);
    const truncated = parsed.truncated || claimTexts.length > MAX_CLAIMS;
    if (claimTexts.length > MAX_CLAIMS) {
      claimTexts = claimTexts.slice(0, MAX_CLAIMS);
    }

    const claims = claimTexts.map((claimText) => ({ id: randomUUID(), text: claimText }));
    const { id } = await this.grounnelStore.createAudit({ text, maxClaims: MAX_CLAIMS, claims, truncated });

    // Gate #3 — resolved immediately, no SearchProvider call ever made for these (D019 §2, T005).
    // Independent per-claim writes (grounnel-store.ts), safe and tested to run concurrently.
    await Promise.all(
      claims
        .filter((claim) => isOpinionClaim(claim.text))
        .map((claim) =>
          this.grounnelStore.writeClaimResult(id, claim.id, {
            status: "done",
            verdict: "unverifiable",
            evidence: null,
            confidence: null,
            reason: "No checkable referent — opinion, prediction, or vague claim (gate #3, D019 §2).",
            sources: [],
          })
        )
    );

    return { id };
  }
}
