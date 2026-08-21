import { randomUUID } from "node:crypto";
import { z } from "zod";
import { waitUntil } from "@vercel/functions";
import { callLlmForJson } from "../llm-json-call.js";
import { isOpinionClaim } from "./opinion-filter.js";
import { classifyClaimVerifiability, isEligibilityExcluded, eligibilityReason, type ClaimVerifiabilityResult } from "./claim-eligibility.js";
import { env } from "../../lib/env.js";
import type { Provider } from "../../providers/types.js";
import type { PromptRegistry } from "../../prompts/registry.js";
import type { GrounnelStore } from "../../persistence/grounnel-store.js";
import type { GrounnelHistoryStore } from "../../persistence/grounnel-history-store.js";
import type { GrounnelLlmCallStore } from "../../persistence/grounnel-llm-call-store.js";
import type { PipelineClaimInput } from "./pipeline.service.js";

const MODULE = "grounnel-extract-service";
/** Matches audit's EXTRACT retry count (D018 §5.10) — a provider hiccup shouldn't hard-fail the whole run. */
const EXTRACT_ATTEMPTS = 3;
// spec.md Assumption 6 — the real number is still an open, ask-first question. This is a
// placeholder so the service is runnable, not a tuned decision (tasks.md T009).
const MAX_CLAIMS = 100;
// D030 §3b — one Gemini call per claim, unbatched; same value/rationale as SEARCH_CONCURRENCY (pipeline.service.ts).
const ELIGIBILITY_CONCURRENCY = 20;

const ExtractResponseSchema = z.object({
  // .default("") — a missing/malformed excerpt must not drop the whole claim via repair.ts's
  // salvageArrays (D028 §4); empty string reads as no-excerpt below.
  claims: z.array(z.object({ claim: z.string(), source_excerpt: z.string().default("") })),
  truncated: z.boolean(),
});

export interface GrounnelExtractResult {
  id: string;
  // Non-opinion claims only (gate #3, D019 §2) — what the route (T012) hands to
  // GrounnelPipelineService.run() next.
  pendingClaims: PipelineClaimInput[];
}

/** EXTRACT + gate #3 (D019 §1/§2, T009). Cost-observability gap noted here previously is closed by D023/T025's llmCallStore. */
export class GrounnelExtractService {
  constructor(
    private provider: Provider,
    private prompts: PromptRegistry,
    private grounnelStore: GrounnelStore,
    private historyStore: GrounnelHistoryStore,
    private llmCallStore: GrounnelLlmCallStore
  ) {}

  /** source distinguishes real runs from golden-set eval runs (D023 §3); sessionId is null until the caller has one (T028). */
  async run(text: string, source: "production" | "eval" = "production", sessionId: string | null = null): Promise<GrounnelExtractResult> {
    // Minted upfront, not left to createAudit's randomUUID() — one id shared by Redis and Postgres (D023 §3).
    const runId = randomUUID();
    // waitUntil, not void: fire-and-forget alone races the response — nothing guarantees this
    // resolves before reply.send(), and Vercel can freeze the container the instant it does.
    waitUntil(this.historyStore.createRun({ runId, sessionId, text, source, maxClaims: MAX_CLAIMS, truncated: false }));

    const extractVersion = this.prompts.getGrounnelExtractVersion();
    const system = this.prompts.render("grounnel-extract", { text, maxClaims: String(MAX_CLAIMS) });

    let parsed: z.infer<typeof ExtractResponseSchema>;
    try {
      parsed = await callLlmForJson({
        provider: this.provider,
        system,
        user: "Return the JSON now.",
        schema: ExtractResponseSchema,
        expectedKeys: ["claims", "truncated"],
        // D028 — source_excerpt is a verbatim quote of untrusted article text (llm-json-call.ts's
        // quotedFields, same mechanism VERIFY's evidence already uses).
        quotedFields: ["source_excerpt"],
        attempts: EXTRACT_ATTEMPTS,
        module: MODULE,
        operation: "run",
        isValid: (result) => !!result.claims,
        onComplete: this.llmCallStore.recordCall({
          runId,
          stage: "extract",
          callType: "primary",
          provider: this.provider.mode,
          model: env.GEMINI_MODEL,
          promptVersion: extractVersion,
        }),
      });
    } catch (err) {
      // Reviewed finding: status otherwise never reaches "failed" — the row would stay stuck
      // at "extracting" forever on any EXTRACT failure (D023 §3's own enum names this state).
      waitUntil(this.historyStore.updateRun(runId, { status: "failed", completedAt: new Date() }));
      throw err;
    }

    // Belt-and-suspenders cap enforcement (same rationale as audit's) — computed before slicing so it reflects a real cut, not re-derived from a count that could legitimately equal the cap.
    let extractedClaims = parsed.claims;
    const truncated = parsed.truncated || extractedClaims.length > MAX_CLAIMS;
    if (extractedClaims.length > MAX_CLAIMS) {
      extractedClaims = extractedClaims.slice(0, MAX_CLAIMS);
    }

    // D028 — strict, un-normalized substring check. A miss (or empty/missing excerpt, see the
    // schema's .default("") above) degrades to null; the claim itself is still verified either way.
    const claims = extractedClaims.map((c) => ({
      id: randomUUID(),
      text: c.claim,
      sourceExcerpt: c.source_excerpt.length > 0 && text.includes(c.source_excerpt) ? c.source_excerpt : null,
    }));
    const { id } = await this.grounnelStore.createAudit({ id: runId, text, maxClaims: MAX_CLAIMS, claims, truncated });

    // Best-effort (D023 §7) — real truncated value + stamped prompt version, once both are known.
    waitUntil(this.historyStore.updateRun(runId, { truncated, promptVersionExtract: extractVersion }));

    // Gate #3 — resolved immediately, no SearchProvider call ever made for these (D019 §2, T005).
    // Independent per-claim writes (grounnel-store.ts), safe and tested to run concurrently.
    const opinionClaims = claims.filter((claim) => isOpinionClaim(claim.text));
    const pendingClaims = claims.filter((claim) => !isOpinionClaim(claim.text));
    const OPINION_REASON = "No checkable referent — opinion, prediction, or vague claim (gate #3, D019 §2).";
    await Promise.all(opinionClaims.map((claim) => this.writeExcludedClaim(id, claim, OPINION_REASON)));

    return { id, pendingClaims };
  }

  /**
   * D030 §3b (tasks.md T014) — the eligibility classifier runs AFTER the 202 response, unlike gate
   * #3's regex above (review finding: one Gemini call per claim was blocking the response on the
   * client's critical path, the exact cost the rest of this pipeline defers via waitUntil for).
   * Called from routes/grounnel.ts's background phase, before pipelineService.run(). A claim this
   * excludes still shows `pending` in the meantime — same as any claim still being searched/verified,
   * resolved on the next /status poll once writeExcludedClaim below lands.
   */
  async classifyEligibility(auditId: string, claims: PipelineClaimInput[]): Promise<PipelineClaimInput[]> {
    try {
      const eligibilityResults: Array<{ claim: PipelineClaimInput; result: ClaimVerifiabilityResult }> = [];
      for (let i = 0; i < claims.length; i += ELIGIBILITY_CONCURRENCY) {
        const chunk = claims.slice(i, i + ELIGIBILITY_CONCURRENCY);
        const chunkResults = await Promise.all(
          chunk.map(async (claim) => ({
            claim,
            result: await classifyClaimVerifiability(this.provider, this.prompts, this.llmCallStore, auditId, claim.id, {
              claimText: claim.text,
              sourceExcerpt: claim.sourceExcerpt,
            }),
          }))
        );
        eligibilityResults.push(...chunkResults);
      }
      const ineligibleClaims = eligibilityResults.filter((r) => isEligibilityExcluded(r.result));
      const eligibleClaims = eligibilityResults.filter((r) => !isEligibilityExcluded(r.result)).map((r) => r.claim);
      await Promise.all(ineligibleClaims.map(({ claim, result }) => this.writeExcludedClaim(auditId, claim, eligibilityReason(result.category))));
      return eligibleClaims;
    } catch (err) {
      // Review finding: this runs in routes/grounnel.ts's post-202 background phase, before
      // pipelineService.run() ever sets status "verifying" — without this, a throw here (e.g. one
      // flaky writeExcludedClaim) left the run stuck at its prior status forever, same failure
      // mode pipeline.service.ts's own catch (line ~226) already guards against. waitUntil, not
      // await (round-2 review finding): an await here would let a second failure on this same
      // write path replace and obscure the original error `err` being rethrown below.
      waitUntil(this.historyStore.updateRun(auditId, { status: "failed", completedAt: new Date() }));
      throw err;
    }
  }

  /** Shared by gate #3 (regex) and D030 §3b (eligibility classifier) — see D023 §3 for the dual Redis+Postgres write rationale. */
  private async writeExcludedClaim(auditId: string, claim: PipelineClaimInput, reason: string): Promise<void> {
    await this.grounnelStore.writeClaimResult(auditId, claim.id, {
      status: "done",
      verdict: "unverifiable",
      evidence: null,
      confidence: null,
      reason,
      sources: [],
      citations: [],
    });
    await this.historyStore.createClaim({
      claimId: claim.id,
      runId: auditId,
      claimText: claim.text,
      verdict: "unverifiable",
      evidence: null,
      confidence: null,
      reason,
      sources: [],
      status: "done",
    });
  }
}
