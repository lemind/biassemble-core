import { randomUUID } from "node:crypto";
import { z } from "zod";
import { callLlmForJson } from "../llm-json-call.js";
import { isOpinionClaim } from "./opinion-filter.js";
import type { Provider } from "../../providers/types.js";
import type { PromptRegistry } from "../../prompts/registry.js";
import type { GrounnelStore } from "../../persistence/grounnel-store.js";
import type { GrounnelHistoryStore } from "../../persistence/grounnel-history-store.js";
import type { PipelineClaimInput } from "./pipeline.service.js";

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
  // Non-opinion claims only (gate #3, D019 §2) — what the route (T012) hands to
  // GrounnelPipelineService.run() next.
  pendingClaims: PipelineClaimInput[];
}

/** EXTRACT + gate #3 (D019 §1/§2, T009). Skips audit's executeAndRecordLlmCall/LlmCallStore — Drizzle/Postgres-backed, violates the no-Postgres rule (D019 §4). A named cost-observability gap. */
export class GrounnelExtractService {
  constructor(
    private provider: Provider,
    private prompts: PromptRegistry,
    private grounnelStore: GrounnelStore,
    private historyStore: GrounnelHistoryStore
  ) {}

  /** source distinguishes real user runs from golden-set eval runs (D023 §3) — defaults to
   * "production"; scripts/eval-grounnel.ts and src/jobs/eval-grounnel-run.ts pass "eval". */
  async run(text: string, source: "production" | "eval" = "production"): Promise<GrounnelExtractResult> {
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

    // Belt-and-suspenders cap enforcement (same rationale as audit's) — computed before slicing so it reflects a real cut, not re-derived from a count that could legitimately equal the cap.
    let claimTexts = parsed.claims.map((c) => c.claim);
    const truncated = parsed.truncated || claimTexts.length > MAX_CLAIMS;
    if (claimTexts.length > MAX_CLAIMS) {
      claimTexts = claimTexts.slice(0, MAX_CLAIMS);
    }

    const claims = claimTexts.map((claimText) => ({ id: randomUUID(), text: claimText }));
    const { id } = await this.grounnelStore.createAudit({ text, maxClaims: MAX_CLAIMS, claims, truncated });

    // Fire-and-forget (D023 §7) — must never block the 202 this run() call leads to; the store's
    // own methods catch and log internally, so no await/try-catch is needed here.
    void this.historyStore.createRun({ runId: id, sessionId: null, text, source, maxClaims: MAX_CLAIMS, truncated });

    // Gate #3 — resolved immediately, no SearchProvider call ever made for these (D019 §2, T005).
    // Independent per-claim writes (grounnel-store.ts), safe and tested to run concurrently.
    const opinionClaims = claims.filter((claim) => isOpinionClaim(claim.text));
    const pendingClaims = claims.filter((claim) => !isOpinionClaim(claim.text));
    await Promise.all(
      opinionClaims.map((claim) =>
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

    return { id, pendingClaims };
  }
}
