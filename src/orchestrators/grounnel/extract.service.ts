import { randomUUID } from "node:crypto";
import { z } from "zod";
import { waitUntil } from "@vercel/functions";
import { callLlmForJson } from "../llm-json-call.js";
import { isOpinionClaim } from "./opinion-filter.js";
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
    let claimTexts = parsed.claims.map((c) => c.claim);
    const truncated = parsed.truncated || claimTexts.length > MAX_CLAIMS;
    if (claimTexts.length > MAX_CLAIMS) {
      claimTexts = claimTexts.slice(0, MAX_CLAIMS);
    }

    const claims = claimTexts.map((claimText) => ({ id: randomUUID(), text: claimText }));
    const { id } = await this.grounnelStore.createAudit({ id: runId, text, maxClaims: MAX_CLAIMS, claims, truncated });

    // Best-effort (D023 §7) — real truncated value + stamped prompt version, once both are known.
    waitUntil(this.historyStore.updateRun(runId, { truncated, promptVersionExtract: extractVersion }));

    // Gate #3 — resolved immediately, no SearchProvider call ever made for these (D019 §2, T005).
    // Independent per-claim writes (grounnel-store.ts), safe and tested to run concurrently.
    const opinionClaims = claims.filter((claim) => isOpinionClaim(claim.text));
    const pendingClaims = claims.filter((claim) => !isOpinionClaim(claim.text));
    const OPINION_REASON = "No checkable referent — opinion, prediction, or vague claim (gate #3, D019 §2).";
    await Promise.all(
      opinionClaims.map(async (claim) => {
        await this.grounnelStore.writeClaimResult(id, claim.id, {
          status: "done",
          verdict: "unverifiable",
          evidence: null,
          confidence: null,
          reason: OPINION_REASON,
          sources: [],
        });
        // Reviewed finding: gate #3 claims were only ever written to Redis — never to
        // grounnel_claims, permanently absent from history/analytics (D023 §3).
        await this.historyStore.createClaim({
          claimId: claim.id,
          runId,
          claimText: claim.text,
          verdict: "unverifiable",
          evidence: null,
          confidence: null,
          reason: OPINION_REASON,
          sources: [],
          status: "done",
        });
      })
    );

    return { id, pendingClaims };
  }
}
