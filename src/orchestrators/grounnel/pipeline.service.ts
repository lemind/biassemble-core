import { z } from "zod";
import { logger } from "../../observability/logger.js";
import { callLlmForJson } from "../llm-json-call.js";
import { isPassageRelevant } from "./passage-filter.js";
import { applyContradictionEvidenceGate, applyNumericGate } from "./gates.js";
import { GrounnelVerdictEnum, type ClaimResult, type ClaimSource } from "../../contracts/grounnel.schemas.js";
import type { Provider } from "../../providers/types.js";
import type { PromptRegistry } from "../../prompts/registry.js";
import type { GrounnelStore } from "../../persistence/grounnel-store.js";
import type { SearchProvider, SearchPassage } from "../../providers/search/search-provider.js";

const MODULE = "grounnel-pipeline-service";
// D018 §2.3 — lowered from 10 to 8 there: batch size, not verdict logic, was why VERDICT/NOTE
// CONSISTENCY got ignored at ~10 claims/call. Same tuned value reused here (D019 §1 batching convention).
const BATCH_MAX = 8;
/** VERIFY responses are intermittently unparseable, matches audit's own retry count (D018 §5.10). */
const VERIFY_ATTEMPTS = 3;
/** Matches audit's DEFAULT_THRESHOLD (audit.schemas.ts) — below this, verdict goes to unverifiable. */
const CONFIDENCE_THRESHOLD = 0.6;

const VerifyResultSchema = z.object({
  id: z.string(),
  verdict: GrounnelVerdictEnum,
  // Gemini sometimes omits a null-valued key entirely rather than sending `null` — same
  // normalization idiom as audit-internal.schemas.ts's VerifyResultSchema (D018 §5, production incident).
  evidence: z.string().nullable().optional().transform((v) => v ?? null),
  reason: z.string().nullable().optional().transform((v) => v ?? null),
  confidence: z.number().min(0).max(1),
});
const VerifyResponseSchema = z.object({ results: z.array(VerifyResultSchema) });

export interface PipelineClaimInput {
  id: string;
  text: string;
}

interface ResolvedEvidence {
  claim: PipelineClaimInput;
  passage: SearchPassage | null;
  sources: SearchPassage[];
}

interface ResolvedWithPassage extends ResolvedEvidence {
  passage: SearchPassage;
}

function hasPassage(r: ResolvedEvidence): r is ResolvedWithPassage {
  return r.passage !== null;
}

function toClaimSources(sources: SearchPassage[]): ClaimSource[] {
  return sources.map((s) => ({ kind: "web" as const, title: s.title, domain: s.domain, url: s.url, status: s.status }));
}

/**
 * Per-claim loop: SearchProvider → gate #4 → VERIFY (batched) → gates #1/#2 → GrounnelStore write
 * (D019 §1, tasks.md T010). Claims with no usable passage never reach VERIFY at all — a real,
 * deliberate cost saving (§4.1), not a shortcut: "no evidence found" is a legitimate, correct
 * verdict a model call adds nothing to.
 */
export class GrounnelPipelineService {
  constructor(
    private readonly searchProvider: SearchProvider,
    private readonly provider: Provider,
    private readonly prompts: PromptRegistry,
    private readonly grounnelStore: GrounnelStore
  ) {}

  async run(auditId: string, claims: PipelineClaimInput[]): Promise<void> {
    const resolved = await Promise.all(claims.map((claim) => this.resolveEvidence(claim)));

    const noEvidence = resolved.filter((r) => !hasPassage(r));
    await Promise.all(noEvidence.map((r) => this.writeNoEvidence(auditId, r)));

    const needsVerify = resolved.filter(hasPassage);
    for (let i = 0; i < needsVerify.length; i += BATCH_MAX) {
      await this.runBatch(auditId, needsVerify.slice(i, i + BATCH_MAX));
    }
  }

  private async resolveEvidence(claim: PipelineClaimInput): Promise<ResolvedEvidence> {
    const sources = await this.searchProvider.search(claim.text);
    for (const s of sources) {
      if (s.status !== "ok") {
        // Granular per-source failure logging (D021 "Do not," last bullet) already happens one
        // layer down inside SearchProvider (discoverUrls/fetchCandidate) — this is the
        // pipeline-level summary, distinguishing which claim a given failed source belonged to.
        logger.info(
          { module: MODULE, operation: "resolveEvidence", claimId: claim.id, url: s.url, status: s.status },
          "Source attempt did not yield usable text for this claim"
        );
      }
    }

    const okSource = sources.find((s) => s.status === "ok" && s.text);
    if (!okSource) {
      logger.info({ module: MODULE, operation: "resolveEvidence", claimId: claim.id }, "No source resolved to usable text — no evidence found");
      return { claim, passage: null, sources };
    }

    if (!isPassageRelevant(claim.text, okSource.text!)) {
      logger.info(
        { module: MODULE, operation: "resolveEvidence", claimId: claim.id, url: okSource.url },
        "Passage dropped by gate #4 relevance filter"
      );
      return { claim, passage: null, sources };
    }

    return { claim, passage: okSource, sources };
  }

  private async writeNoEvidence(auditId: string, r: ResolvedEvidence): Promise<void> {
    await this.grounnelStore.writeClaimResult(auditId, r.claim.id, {
      status: "done",
      verdict: "unsupported",
      evidence: null,
      confidence: null,
      reason: "No relevant source found for this claim.",
      sources: toClaimSources(r.sources),
    });
  }

  private async degradeBatch(auditId: string, batch: ResolvedWithPassage[]): Promise<void> {
    await Promise.all(
      batch.map((b) =>
        this.grounnelStore.writeClaimResult(auditId, b.claim.id, {
          status: "failed",
          verdict: null,
          evidence: null,
          confidence: null,
          reason: null,
          sources: toClaimSources(b.sources),
        })
      )
    );
  }

  private async runBatch(auditId: string, batch: ResolvedWithPassage[]): Promise<void> {
    const pairs = batch.map((b) => ({ id: b.claim.id, claim: b.claim.text, passage: b.passage.text, source_url: b.passage.url }));
    const system = this.prompts.render("grounnel-verify", {
      claim_passage_pairs: JSON.stringify(pairs),
      threshold: String(CONFIDENCE_THRESHOLD),
    });

    let parsed: z.infer<typeof VerifyResponseSchema>;
    try {
      parsed = await callLlmForJson({
        provider: this.provider,
        system,
        user: "Return the JSON now.",
        schema: VerifyResponseSchema,
        expectedKeys: ["results"],
        attempts: VERIFY_ATTEMPTS,
        module: MODULE,
        operation: "runBatch",
      });
    } catch (err) {
      // A failed VERIFY batch marks its claims not_checked (status: "failed") and the run
      // continues — never fails the whole audit over one bad batch (spec.md Success Criteria).
      logger.error({ module: MODULE, operation: "runBatch", auditId, err }, "VERIFY batch failed after retries — degrading to not_checked");
      await this.degradeBatch(auditId, batch);
      return;
    }

    const byId = new Map(batch.map((b) => [b.claim.id, b]));
    const answeredIds = new Set<string>();
    await Promise.all(
      parsed.results.map(async (result) => {
        const item = byId.get(result.id);
        if (!item) return; // model echoed an id we didn't send — ignore, don't persist (matches audit's own precedent)
        answeredIds.add(item.claim.id);

        let verdict = result.confidence < CONFIDENCE_THRESHOLD && result.verdict !== "unverifiable" ? "unverifiable" : result.verdict;

        // Gate #1 — never reaches the store without passing this (D019 §2, T003, tasks.md acceptance).
        const gate1 = applyContradictionEvidenceGate({ verdict, evidence: result.evidence, passageText: item.passage.text! });
        verdict = gate1.verdict;
        const evidence = gate1.evidence;

        // Gate #2 — numeric normalization/comparison in code (D019 §2, T004).
        const gate2 = applyNumericGate({ claimText: item.claim.text, verdict, evidence });
        verdict = gate2.verdict;

        const result_: ClaimResult = {
          status: "done",
          verdict,
          evidence,
          confidence: result.confidence,
          reason: result.reason,
          sources: toClaimSources(item.sources),
        };
        await this.grounnelStore.writeClaimResult(auditId, item.claim.id, result_);
      })
    );

    const missing = batch.filter((b) => !answeredIds.has(b.claim.id));
    if (missing.length > 0) {
      logger.warn(
        { module: MODULE, operation: "runBatch", auditId, missingIds: missing.map((m) => m.claim.id) },
        "VERIFY response omitted some claims in this batch — degrading them to not_checked"
      );
      await this.degradeBatch(auditId, missing);
    }
  }
}
