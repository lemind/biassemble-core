import { randomUUID } from "node:crypto";
import { z } from "zod";
import { logger } from "../../observability/logger.js";
import { repairWithFallback } from "../../parsers/repair.js";
import { isSuspectedInjection, InjectionSuspectedError } from "../audit/injection-guard.js";
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
    const user = "Return the JSON now.";

    let parsed: z.infer<typeof ExtractResponseSchema> | null = null;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= EXTRACT_ATTEMPTS; attempt++) {
      let raw: unknown;
      try {
        ({ result: raw } = await this.provider.completeJson<unknown>({ system, user, options: { temperature: 0 } }));
      } catch (err) {
        lastError = err as Error;
        logger.warn({ module: MODULE, operation: "run", attempt, err }, "EXTRACT provider call failed — retrying");
        continue;
      }

      if (isSuspectedInjection(JSON.stringify(raw), ["claims", "truncated"])) {
        logger.error({ module: MODULE, operation: "run", raw }, "EXTRACT response flagged as injection-suspected — hard stop, not repaired");
        throw new InjectionSuspectedError("grounnel-extract");
      }

      try {
        const { result } = await repairWithFallback(JSON.stringify(raw), ExtractResponseSchema, null, { salvageArrays: true });
        if (!result.claims) {
          throw new Error("EXTRACT response failed schema validation: claims could not be parsed (see repair warnings)");
        }
        parsed = result;
        break;
      } catch (err) {
        lastError = err as Error;
        logger.warn({ module: MODULE, operation: "run", attempt, err }, "EXTRACT response unparseable — retrying");
      }
    }
    if (!parsed) {
      throw lastError ?? new Error("EXTRACT failed after retries with no captured error");
    }

    // Belt-and-suspenders cap enforcement, same rationale as audit's extract.service.ts —
    // a cap only the model enforces isn't really a cap.
    let claimTexts = parsed.claims.map((c) => c.claim);
    if (claimTexts.length > MAX_CLAIMS) {
      claimTexts = claimTexts.slice(0, MAX_CLAIMS);
    }

    const claims = claimTexts.map((claimText) => ({ id: randomUUID(), text: claimText }));
    const { id } = await this.grounnelStore.createAudit({ text, maxClaims: MAX_CLAIMS, claims });

    // Gate #3 — resolved immediately, no SearchProvider call ever made for these (D019 §2, T005).
    for (const claim of claims) {
      if (isOpinionClaim(claim.text)) {
        await this.grounnelStore.writeClaimResult(id, claim.id, {
          status: "done",
          verdict: "unverifiable",
          evidence: null,
          confidence: null,
          reason: "No checkable referent — opinion, prediction, or vague claim (gate #3, D019 §2).",
          sources: [],
        });
      }
    }

    return { id };
  }
}
