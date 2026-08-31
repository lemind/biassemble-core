import type { ZodSchema } from "zod";
import { waitUntil } from "@vercel/functions";
import { logger } from "../../observability/logger.js";
import { callLlmForJson } from "../llm-json-call.js";
import { hasSubjectEntity, isPassageRelevant } from "./passage-filter.js";
import { buildPassageSentences, buildPassageSentencesMulti, resolveEvidenceFromCitations, type PassageSentence } from "./passage-sentences.js";
import { composeUserFacingReason, evidenceMatchesPassage, rewriteUngroundedAffirmativeReason, type InstanceAttribution } from "./gates.js";
import { runGateChain, type Diagnostic } from "./pipeline-gate-chain.js";
import {
  buildGeminiRateLimitMessage,
  hasPassage,
  hasValidEvidence,
  toClaimSources,
  passageLabelForIndex,
  originatingContradictionGate,
  PROTECTED_CONTRADICTION_GATES,
  logReconciliationDowngrade,
  attachCitationUrls,
  type PipelineClaimInput,
  type ResolvedEvidence,
  type ResolvedWithPassage,
  type Verdict,
} from "./pipeline-helpers.js";
import { VerifyRawResponseSchema, ConsistencyCheckResponseSchema, InstanceAttributionResponseSchema, PassageRerankResponseSchema, type VerifyProcessedResult } from "./pipeline-schemas.js";
import { extractInstanceSelector } from "../../lib/instance-selector.js";
import { extractKeyTerms, scoreKeyTermMatches } from "../../lib/claim-terms.js";
import { RateLimitError } from "../../providers/gemini.js";
import { env } from "../../lib/env.js";
import type { ClaimResult } from "../../contracts/grounnel.schemas.js";
import type { Provider } from "../../providers/types.js";
import type { PromptRegistry } from "../../prompts/registry.js";
import type { GrounnelStore } from "../../persistence/grounnel-store.js";
import type { GrounnelHistoryStore } from "../../persistence/grounnel-history-store.js";
import type { GrounnelLlmCallStore } from "../../persistence/grounnel-llm-call-store.js";
import type { GrounnelGateEventStore, GateEventInput } from "../../persistence/grounnel-gate-event-store.js";
import type { GateReason } from "../../persistence/types.js";
import { NoopGrounnelRerankDecisionStore, type GrounnelRerankDecisionStore } from "../../persistence/grounnel-rerank-decision-store.js";
import type { SearchProvider, SearchPassage } from "../../providers/search/search-provider.js";

// Re-exported for backward compatibility — extract.service.ts and routes/grounnel.ts import these
// from this file. Implementations moved to pipeline-helpers.ts (D031 file-size split).
export { buildGeminiRateLimitMessage, type PipelineClaimInput };

// D030 §3h — what an escalation tier's write is compared against; see hasValidEvidence in pipeline-helpers.ts.
interface PriorResult {
  verdict: Verdict | null;
  hasValidEvidence: boolean;
}

const MODULE = "grounnel-pipeline-service";
// D018 §2.3 — lowered from 10 to 8 there: batch size, not verdict logic, was why VERDICT/NOTE
// CONSISTENCY got ignored at ~10 claims/call. Same tuned value reused here (D019 §1 batching convention).
const BATCH_MAX = 8;
// resolveEvidence runs in waves of this size, not one flat Promise.all — caps wasted Tavily round-trips after a 429 while keeping typical articles fully parallel (found via /code-review high, T012).
const SEARCH_CONCURRENCY = 20;
/** VERIFY responses are intermittently unparseable, matches audit's own retry count (D018 §5.10). */
const VERIFY_ATTEMPTS = 3;
/** Matches audit's DEFAULT_THRESHOLD (audit.schemas.ts) — below this, verdict goes to unverifiable. */
const CONFIDENCE_THRESHOLD = 0.6;
// D030 §3i Mode B — checkRetryContradiction's downgrade targets, keyed by the retry's own verdict.
// One table, not parallel ternaries, so target/reason-code can't drift apart if a verdict is added.
// `contradicted` reverts to "no evidence" (unsupported); `supported`/`partially_supported` revert to
// "uncertain" (unverifiable), never `contradicted` — this signal alone isn't grounds for that.
const RETRY_DOWNGRADE: Partial<Record<Verdict, { target: Verdict; reason: GateReason }>> = {
  contradicted: { target: "unsupported", reason: "retry_contradiction_invalidated" },
  supported: { target: "unverifiable", reason: "retry_affirmation_invalidated" },
  partially_supported: { target: "unverifiable", reason: "retry_affirmation_invalidated" },
};
// D026 §11 (T049) — Phase 1 multi-passage evidence, fixed cap; §13 (T053) built the escalation this deferred.
const MAX_VERIFY_PASSAGES = 3;
// Verdicts applyInstanceAttributionGate can actually move — no gate ahead of it lifts `unverifiable`, so checking those claims buys nothing (spec 013 T21).
const ATTRIBUTION_ACTIONABLE_VERDICTS: ReadonlySet<Verdict> = new Set<Verdict>(["supported", "partially_supported", "unsupported"]);
// D026 §13 — a claim still unsupported/unverifiable (or zero evidence) after the normal pipeline
// gets re-tried against a wider DIY candidate pool, one tier at a time, bounded at 2 escalations.
const ESCALATION_TIERS = [5, 8];

// D032 §5/T7 — states both that evidence is missing AND that this isn't a falsehood finding (SC-2).
const NO_EVIDENCE_REASON =
  "No relevant source found for this claim. This is not a finding that the claim is false — it means no supporting or refuting evidence was located.";
const TAVILY_RATE_LIMITED_REASON = "This claim could not be checked right now — our search provider's rate limit was reached. Try again later.";

/** Per-claim loop: search -> gate #4 -> VERIFY (batched) -> gates #1/#2 -> store (D019 §1, T010). No-evidence claims skip VERIFY (cost saving, §4.1). Gemini/Tavily rate limits get distinct messages. */
export class GrounnelPipelineService {
  constructor(
    private readonly searchProvider: SearchProvider,
    private readonly provider: Provider,
    private readonly prompts: PromptRegistry,
    private readonly grounnelStore: GrounnelStore,
    private readonly historyStore: GrounnelHistoryStore,
    private readonly llmCallStore: GrounnelLlmCallStore,
    private readonly gateEventStore: GrounnelGateEventStore,
    // D026 §19 — defaulted so existing call sites keep compiling unchanged.
    private readonly rerankDecisionStore: GrounnelRerankDecisionStore = new NoopGrounnelRerankDecisionStore()
  ) {}

  /** Spec 013 T22 — exposes resolveAllEvidence (search + rerank, no VERIFY call) for the fixture-generation
   * step of the verdict/reason field-order A/B: snapshots the exact {claim, subjectEntity, passages} VERIFY
   * would receive, without running VERIFY itself, so the fixture is reusable across both schema orders. */
  async resolveEvidenceForClaims(auditId: string, claims: PipelineClaimInput[], searchEngine: "defaultFlow" | "tavily" = "defaultFlow"): Promise<ResolvedEvidence[]> {
    return this.resolveAllEvidence(auditId, claims, searchEngine);
  }

  async run(auditId: string, claims: PipelineClaimInput[], searchEngine: "defaultFlow" | "tavily" = "defaultFlow"): Promise<void> {
    try {
      // D026 §14/§15 — set before the verify loop to avoid a "done" poll race; stays inside this try so a Redis failure still hits the catch below.
      await this.grounnelStore.setEscalating(auditId, true);
      try {
        const resolved = await this.resolveAllEvidence(auditId, claims, searchEngine);

        const noEvidence = resolved.filter((r) => !hasPassage(r));
        await Promise.all(noEvidence.map((r) => this.writeNoEvidence(auditId, r)));

        const needsVerify = resolved.filter(hasPassage);
        // T32 — without this, Postgres status jumps extracting -> done, so a maxDuration kill (which
        // skips the terminal write) is indistinguishable from a run that never started.
        if (needsVerify.length > 0) waitUntil(this.historyStore.updateRun(auditId, { status: "verifying" }));
        // D030 §3d — run-scoped so reason_ordinal-protected claim ids survive across escalation tiers.
        const protectedContradictionClaimIds = new Set<string>();
        let rateLimitedMidRun = false;
        for (let i = 0; i < needsVerify.length; i += BATCH_MAX) {
          const batch = needsVerify.slice(i, i + BATCH_MAX);
          const geminiRateLimit = await this.runBatch(auditId, batch, protectedContradictionClaimIds);
          if (geminiRateLimit) {
            rateLimitedMidRun = true;
            const remaining = needsVerify.slice(i + BATCH_MAX);
            if (remaining.length > 0) {
              logger.warn(
                { module: MODULE, operation: "run", auditId, remaining: remaining.length },
                "Gemini rate-limited mid-run — stopping remaining batches instead of attempting each one"
              );
              await this.degradeBatch(auditId, remaining, buildGeminiRateLimitMessage(geminiRateLimit));
            }
            break;
          }
        }

        // D026 §13 — skip escalation entirely if the primary pass already hit a rate limit.
        if (!rateLimitedMidRun) {
          const escalationT0 = Date.now();
          await this.escalateUnresolved(auditId, claims, searchEngine, protectedContradictionClaimIds);
          logger.info({ module: MODULE, operation: "run", auditId, durationMs: Date.now() - escalationT0 }, "Escalation phase finished");
        }
      } finally {
        // D026 §15 — must clear on every path or the run sticks at "verifying" forever.
        await this.grounnelStore.setEscalating(auditId, false);
      }
    } catch (err) {
      // Otherwise status never reaches "failed" on an uncaught error — stuck at its prior status forever.
      waitUntil(this.historyStore.updateRun(auditId, { status: "failed", completedAt: new Date() }));
      throw err;
    }

    // Best-effort (D023 §7) — Redis is already fully settled; Postgres just needs to catch up.
    await this.historyStore.updateRun(auditId, { status: "done", completedAt: new Date() });
  }

  /** D026 §13 — re-tries an unresolved claim against a wider DIY candidate pool; widens evidence only, no new verification logic. Bounded at 2 tiers. */
  private async escalateUnresolved(
    auditId: string,
    claims: PipelineClaimInput[],
    searchEngine: "defaultFlow" | "tavily",
    protectedContradictionClaimIds: Set<string>
  ): Promise<void> {
    const byId = new Map(claims.map((c) => [c.id, c]));
    let pending = await this.findUnresolvedClaims(auditId, byId, protectedContradictionClaimIds);

    for (const tier of ESCALATION_TIERS) {
      if (pending.length === 0) return;
      logger.info({ module: MODULE, operation: "escalateUnresolved", auditId, tier, claimCount: pending.length }, "Escalating unresolved claims to a wider candidate pool");

      // D026 §17/D030 §3h — one snapshot before this tier overwrites anything, feeding both guardEscalatedContradictionReversals (verdict) and the escalation-replacement floor (verdict+evidence-validity).
      const preTierStatus = await this.grounnelStore.getStatus(auditId);
      const priorResultById = new Map((preTierStatus?.claims ?? []).map((c) => [c.id, { verdict: c.verdict, hasValidEvidence: hasValidEvidence(c.citations) }]));
      const preVerdictById = new Map([...priorResultById].map(([id, r]) => [id, r.verdict]));

      // Waved by SEARCH_CONCURRENCY like resolveAllEvidence; stops early on a Tavily rate limit.
      const reResolved: ResolvedEvidence[] = [];
      let tavilyRateLimitedThisTier = false;
      for (let i = 0; i < pending.length; i += SEARCH_CONCURRENCY) {
        const chunk = pending.slice(i, i + SEARCH_CONCURRENCY);
        const chunkResolved = await Promise.all(chunk.map((claim) => this.resolveEvidence(auditId, claim, searchEngine, tier)));
        reResolved.push(...chunkResolved);
        if (chunkResolved.some((r) => r.sources.some((s) => s.status === "rate_limited"))) {
          tavilyRateLimitedThisTier = true;
          break;
        }
      }

      const needsVerify = reResolved.filter(hasPassage);
      // Still zero evidence at this tier — nothing new to write; the pre-escalation result already
      // stands (writeNoEvidence's original "unsupported: no evidence found" remains accurate).

      for (let i = 0; i < needsVerify.length; i += BATCH_MAX) {
        const geminiRateLimit = await this.runBatch(auditId, needsVerify.slice(i, i + BATCH_MAX), protectedContradictionClaimIds, priorResultById);
        if (geminiRateLimit) {
          logger.warn({ module: MODULE, operation: "escalateUnresolved", auditId, tier }, "Gemini rate-limited during escalation — stopping further tiers");
          return;
        }
      }

      // D026 §17 — symmetric check: a claim that WAS contradicted can flip off this tier's noisier pool; re-verify that too.
      await this.guardEscalatedContradictionReversals(auditId, needsVerify.map((v) => v.claim), preVerdictById);

      if (tavilyRateLimitedThisTier) {
        logger.warn({ module: MODULE, operation: "escalateUnresolved", auditId, tier }, "Tavily rate-limited during escalation — stopping further tiers");
        return;
      }

      pending = await this.findUnresolvedClaims(auditId, byId, protectedContradictionClaimIds);
    }
  }

  /** Reads current Redis state rather than tracking in-memory. Excludes rate-limited claims (D026 §17) and reason_ordinal-protected ones (D030 §3d). */
  private async findUnresolvedClaims(
    auditId: string,
    byId: Map<string, PipelineClaimInput>,
    protectedContradictionClaimIds: Set<string>
  ): Promise<PipelineClaimInput[]> {
    const status = await this.grounnelStore.getStatus(auditId);
    if (!status) return [];
    return status.claims
      .filter(
        (c) =>
          c.status === "done" &&
          (c.verdict === "unsupported" || c.verdict === "unverifiable" || c.verdict === "contradicted" || c.verdict === "partially_supported") &&
          !protectedContradictionClaimIds.has(c.id) &&
          c.reason !== TAVILY_RATE_LIMITED_REASON &&
          !c.reason?.includes("AI usage limit") &&
          !c.reason?.includes("being rate-limited")
      )
      .map((c) => byId.get(c.id))
      .filter((c): c is PipelineClaimInput => c !== undefined);
  }

  /** D026 §22/T064 — scrutinizes every fresh "contradicted" verdict (needsRetry alone doesn't catch a well-evidenced but logically-wrong one); same classifier as checkRetryContradiction. */
  private async reconcileContradictedVerdicts(
    auditId: string,
    scope: PipelineClaimInput[],
    gateEventsByClaimId: Map<string, GateEventInput[]>,
    // D030 §3d — mutable output param: adds reason_ordinal-protected claim ids so findUnresolvedClaims can skip them too.
    protectedContradictionClaimIds: Set<string>
  ): Promise<void> {
    const status = await this.grounnelStore.getStatus(auditId);
    if (!status) return;
    const byId = new Map(scope.map((c) => [c.id, c]));
    // D030 §3h review finding — also excludes ids the escalation-replacement floor just protected THIS pass, or they'd be immediately re-scrutinized here off a gateEventsByClaimId entry that never shows "contradicted".
    const contradicted = status.claims.filter((c) => byId.has(c.id) && c.status === "done" && c.verdict === "contradicted" && !protectedContradictionClaimIds.has(c.id));
    if (contradicted.length === 0) return;

    // D030 §3d — a reason_ordinal contradiction is grounded in VERIFY's own textual mismatch; excluded from the classifier call entirely, not just from acting on it.
    const protectedClaims = contradicted.filter((c) => PROTECTED_CONTRADICTION_GATES.has(originatingContradictionGate(gateEventsByClaimId.get(c.id) ?? [])?.gate ?? ""));
    for (const c of protectedClaims) protectedContradictionClaimIds.add(c.id);
    const nowContradicted = contradicted.filter((c) => !protectedClaims.some((p) => p.id === c.id));
    if (nowContradicted.length === 0) return;

    const consistencyMap = await this.checkReasonVerdictConsistency(
      auditId,
      nowContradicted.map((c) => ({ id: c.id, claim: c.text, reason: c.reason, verdict: "contradicted" as const }))
    );

    await Promise.all(
      nowContradicted.map(async (c) => {
        const consistent = consistencyMap.get(c.id) ?? true; // fail-open, same convention as D025 §2/§5
        if (consistent) return;
        // D031 (review finding) — same incoherence class as the primary VERIFY write site; user-facing only, historyStore keeps raw.
        const userFacingReason = rewriteUngroundedAffirmativeReason("unsupported", 0, c.reason);
        await this.grounnelStore.writeClaimResult(auditId, c.id, { status: "done", verdict: "unsupported", evidence: null, confidence: c.confidence, reason: userFacingReason, sources: c.sources, citations: [] });
        await this.historyStore.createClaim({ claimId: c.id, runId: auditId, claimText: c.text, sourceExcerpt: null /* row exists, upsert keeps original */, verdict: "unsupported", evidence: null, confidence: c.confidence, reason: c.reason, sources: c.sources, status: "done" });
        this.gateEventStore.recordGateEvents(auditId, c.id, [
          { gate: "retry_reconciliation", verdictBefore: "contradicted", verdictAfter: "unsupported", overridden: true, reason: "retry_contradiction_invalidated" },
        ]);
        logReconciliationDowngrade("reconcileContradictedVerdicts", auditId, c.id, "contradicted", "unsupported", originatingContradictionGate(gateEventsByClaimId.get(c.id) ?? []));
      })
    );
  }

  /** D026 §17 — symmetric counterpart to reconcileContradictedVerdicts: re-checks a flip AWAY from
   * "contradicted" off a noisier escalation pool. Downgrades to "unsupported", not "unverifiable" —
   * unlike RETRY_DOWNGRADE's supported/partially_supported branch, this reacts to a REAL prior
   * grounded contradiction being overturned, so reverting to the stronger "no evidence" state is
   * warranted; RETRY_DOWNGRADE has no such prior in the general case (see D030 §3i Mode B). */
  private async guardEscalatedContradictionReversals(
    auditId: string,
    escalated: PipelineClaimInput[],
    preVerdictById: Map<string, Verdict | null>
  ): Promise<void> {
    const status = await this.grounnelStore.getStatus(auditId);
    if (!status) return;
    const byId = new Map(escalated.map((c) => [c.id, c]));
    const flippedAway = status.claims.filter(
      (c) =>
        byId.has(c.id) &&
        c.status === "done" &&
        preVerdictById.get(c.id) === "contradicted" &&
        (c.verdict === "supported" || c.verdict === "partially_supported")
    );
    if (flippedAway.length === 0) return;

    const consistencyMap = await this.checkReasonVerdictConsistency(
      auditId,
      flippedAway.map((c) => ({ id: c.id, claim: c.text, reason: c.reason, verdict: c.verdict as Verdict }))
    );

    await Promise.all(
      flippedAway.map(async (c) => {
        const consistent = consistencyMap.get(c.id) ?? true; // fail-open, same convention as D025 §2/§5
        if (consistent) return;
        const verdictBefore = c.verdict as Verdict;
        // D031 (review finding) — same incoherence class, and c.reason here most likely of all to be affirmative (was supported).
        const userFacingReason = rewriteUngroundedAffirmativeReason("unsupported", 0, c.reason);
        await this.grounnelStore.writeClaimResult(auditId, c.id, { status: "done", verdict: "unsupported", evidence: null, confidence: c.confidence, reason: userFacingReason, sources: c.sources, citations: [] });
        await this.historyStore.createClaim({ claimId: c.id, runId: auditId, claimText: c.text, sourceExcerpt: null /* row exists, upsert keeps original */, verdict: "unsupported", evidence: null, confidence: c.confidence, reason: c.reason, sources: c.sources, status: "done" });
        this.gateEventStore.recordGateEvents(auditId, c.id, [
          { gate: "retry_reconciliation", verdictBefore, verdictAfter: "unsupported", overridden: true, reason: "escalation_reversal_invalidated" },
        ]);
        // Review finding — was its own inline logger.info, missed the checkRetryContradiction/
        // reconcileContradictedVerdicts consolidation into one aggregatable log stream (tasks.md backlog).
        logReconciliationDowngrade("guardEscalatedContradictionReversals", auditId, c.id, verdictBefore, "unsupported", null);
      })
    );
  }

  /** Waves of SEARCH_CONCURRENCY, not one flat Promise.all — lets a Tavily rate limit detected in
   * one wave stop the next wave's claims from ever calling SearchProvider.search() at all. */
  private async resolveAllEvidence(
    auditId: string,
    claims: PipelineClaimInput[],
    searchEngine: "defaultFlow" | "tavily"
  ): Promise<ResolvedEvidence[]> {
    const resolved: ResolvedEvidence[] = [];
    for (let i = 0; i < claims.length; i += SEARCH_CONCURRENCY) {
      const chunk = claims.slice(i, i + SEARCH_CONCURRENCY);
      const chunkResolved = await Promise.all(chunk.map((claim) => this.resolveEvidence(auditId, claim, searchEngine)));
      resolved.push(...chunkResolved);

      const tavilyRateLimited = chunkResolved.some((r) => r.sources.some((s) => s.status === "rate_limited"));
      if (tavilyRateLimited) {
        const remaining = claims.slice(i + SEARCH_CONCURRENCY);
        if (remaining.length > 0) {
          logger.warn(
            { module: MODULE, operation: "resolveAllEvidence", auditId, remaining: remaining.length },
            "Tavily rate-limited mid-run — stopping remaining search calls instead of attempting each one"
          );
          const rateLimitedSource: SearchPassage = { url: "https://tavily.com", title: "Tavily", domain: "tavily.com", status: "rate_limited", text: null };
          resolved.push(...remaining.map((claim) => ({ claim, passages: [], sources: [rateLimitedSource] })));
        }
        break;
      }
    }
    return resolved;
  }

  private async resolveEvidence(
    auditId: string,
    claim: PipelineClaimInput,
    searchEngine: "defaultFlow" | "tavily",
    // D026 §13 — escalation-only; omitted on the normal pass (HybridSearchProvider defaults it).
    maxCandidates?: number
  ): Promise<ResolvedEvidence> {
    // context (D023 §6) attributes grounnel_search_calls rows to this run/claim; D026 §8 — full claim sentence, not a keyword rewrite (that's Tavily-only, buildSearchQuery/T046).
    const sources = await this.searchProvider.search(claim.text, {
      runId: auditId,
      claimId: claim.id,
      searchFlow: searchEngine,
      maxCandidates,
    });
    for (const s of sources) {
      if (s.status !== "ok") {
        // Granular per-source failure logging already happens one layer down (SearchProvider) — this is the pipeline-level summary, tying a failed source to the claim it belonged to (D021).
        logger.info(
          { module: MODULE, operation: "resolveEvidence", claimId: claim.id, url: s.url, status: s.status },
          "Source attempt did not yield usable text for this claim"
        );
      }
    }

    const okSources = sources.filter((s) => s.status === "ok" && s.text);
    if (okSources.length === 0) {
      logger.info({ module: MODULE, operation: "resolveEvidence", claimId: claim.id }, "No source resolved to usable text — no evidence found");
      return { claim, passages: [], sources };
    }

    // D026 §6/§11/§18 — pools up to MAX_VERIFY_PASSAGES relevant sources, not just the first; rerankPassages falls back to gate #4 on error.
    const relevantSources = (await this.rerankPassages(auditId, claim, okSources)).slice(0, MAX_VERIFY_PASSAGES);
    if (relevantSources.length === 0) {
      logger.info(
        { module: MODULE, operation: "resolveEvidence", claimId: claim.id, checkedUrls: okSources.map((s) => s.url) },
        "No already-fetched source passed gate #4's relevance filter"
      );
      return { claim, passages: [], sources };
    }

    return { claim, passages: relevantSources, sources };
  }

  /** D026 §18 — LLM scores "is this candidate actually about the claim" (lexical presence can't); averaged with lexical rank. Fails open to gate #4 alone on error. */
  private async rerankPassages(auditId: string, claim: PipelineClaimInput, sources: SearchPassage[]): Promise<SearchPassage[]> {
    // g17 — hasSubjectEntity joins isPassageRelevant only on this degraded path, not as a hard gate ahead of the LLM call (see the rerank prompt's SUBJECT ENTITY line).
    if (sources.length <= 1) {
      return sources.filter((s) => isPassageRelevant(claim.text, s.text!) && hasSubjectEntity(claim.subjectEntity, s.text!));
    }

    const labeled = sources.map((s, i) => ({ label: String.fromCharCode(65 + i), source: s }));
    try {
      // D026 §20 — select by relevance (VERIFY's own sentence scoring), not a blind character prefix (captured nav chrome on long pages).
      const candidates = labeled.map(({ label, source }) => ({
        id: label,
        title: source.title,
        excerpt: buildPassageSentences(claim.text, source.text ?? "")
          .map((s) => s.text)
          .join(" "),
      }));
      const system = this.prompts.render("grounnel-passage-rerank", {
        claim: claim.text,
        // g17 — explicit entity signal so the LLM can judge entity-anchoring (coreference included), not just literal name repetition.
        subjectEntity: claim.subjectEntity ?? "",
        candidates: JSON.stringify(candidates),
      });
      const parsed = await this.callGrounnelJson(
        auditId,
        system,
        "Return the JSON now.",
        PassageRerankResponseSchema,
        "rerankPassages",
        "passage_rerank",
        this.prompts.getGrounnelPassageRerankVersion(),
        [],
        claim.id
      );
      const llmScoreByLabel = new Map(parsed.results.map((r) => [r.id, r.score]));

      const scored = labeled.map(({ label, source }, i) => {
        const lexicalScore = 100 * (1 - i / labeled.length);
        // Missing answer for this label (a short/malformed LLM response) falls back to the lexical
        // score alone for just this candidate — fail-open per-candidate, not per-call.
        const llmScore = llmScoreByLabel.get(label) ?? lexicalScore;
        return { source, lexicalScore, llmScore, combined: (lexicalScore + llmScore) / 2 };
      });
      const ranked = scored.sort((a, b) => b.combined - a.combined);
      // D026 §19 — "selected" mirrors resolveEvidence's own MAX_VERIFY_PASSAGES slice.
      this.rerankDecisionStore.recordRerankDecisions(
        auditId,
        claim.id,
        ranked.map((r, i) => ({ url: r.source.url, lexicalScore: r.lexicalScore, llmScore: r.llmScore, combinedScore: r.combined, selected: i < MAX_VERIFY_PASSAGES }))
      );
      return ranked.map((s) => s.source);
    } catch (err) {
      // A RateLimitError here doesn't stop other in-flight claims (unlike other call sites) — acceptable, fail-open still degrades correctly; tagged so it's observable.
      logger.warn(
        { module: MODULE, operation: "rerankPassages", auditId, claimId: claim.id, rateLimited: err instanceof RateLimitError, err },
        "Passage reranking failed — falling back to lexical order + gate #4's relevance filter"
      );
      return sources.filter((s) => isPassageRelevant(claim.text, s.text!) && hasSubjectEntity(claim.subjectEntity, s.text!));
    }
  }

  private async writeNoEvidence(auditId: string, r: ResolvedEvidence): Promise<void> {
    const rateLimited = r.sources.some((s) => s.status === "rate_limited");
    const reason = rateLimited ? TAVILY_RATE_LIMITED_REASON : NO_EVIDENCE_REASON;
    const sources = toClaimSources(r.sources);
    await this.grounnelStore.writeClaimResult(auditId, r.claim.id, {
      status: "done",
      verdict: "unsupported",
      evidence: null,
      confidence: null,
      reason,
      sources,
      citations: [],
    });
    await this.historyStore.createClaim({
      claimId: r.claim.id,
      runId: auditId,
      claimText: r.claim.text,
      sourceExcerpt: r.claim.sourceExcerpt,
      verdict: "unsupported",
      evidence: null,
      confidence: null,
      reason,
      sources,
      status: "done",
    });
  }

  private async degradeBatch(auditId: string, batch: ResolvedWithPassage[], reason: string | null = null): Promise<void> {
    await Promise.all(
      batch.map(async (b) => {
        const sources = toClaimSources(b.sources);
        await this.grounnelStore.writeClaimResult(auditId, b.claim.id, {
          status: "failed",
          verdict: null,
          evidence: null,
          confidence: null,
          reason,
          sources,
          citations: [],
        });
        await this.historyStore.createClaim({
          claimId: b.claim.id,
          runId: auditId,
          claimText: b.claim.text,
          sourceExcerpt: b.claim.sourceExcerpt,
          verdict: null,
          evidence: null,
          confidence: null,
          reason,
          sources,
          status: "failed",
        });
      })
    );
  }

  /** Shared by callVerify and checkReasonVerdictConsistency — avoids drift between two near-identical callLlmForJson invocations. */
  private async callGrounnelJson<T extends { results: unknown[] }>(
    auditId: string,
    system: string,
    user: string,
    schema: ZodSchema<T>,
    operation: string,
    callType: "primary" | "consistency_retry" | "consistency_check" | "fill_in" | "passage_rerank" | "instance_attribution",
    promptVersion: string,
    // Excludes verbatim-quote fields from the injection-marker scan (a scraped page's own boilerplate false-positived it once).
    quotedFields: string[] = [],
    // D026 §19 — only set by a genuinely single-claim caller; batched calls pass undefined.
    claimId?: string
  ): Promise<T> {
    return callLlmForJson({
      provider: this.provider,
      system,
      user,
      schema,
      expectedKeys: ["results"],
      quotedFields,
      attempts: VERIFY_ATTEMPTS,
      module: MODULE,
      operation,
      // repair.ts nulls a field it can't salvage rather than throwing (D018 §5.15) — without this, a null `results` crashes .map() below, uncaught.
      isValid: (result) => Array.isArray(result.results),
      onComplete: this.llmCallStore.recordCall({
        runId: auditId,
        claimId,
        stage: "verify",
        callType,
        provider: this.provider.mode,
        model: env.GEMINI_MODEL,
        promptVersion,
      }),
    });
  }

  /** Shared by runBatch's primary call and retryVerifyClaim's single-claim call — reviewed finding: these two were near-duplicated inline before, risking drift if the call shape ever changes. */
  private async callVerify(
    auditId: string,
    // D026 §6 — no source_url (model doesn't need it). D026 §11 — up to MAX_VERIFY_PASSAGES texts, rank-ordered.
    pairs: Array<{ id: string; claim: string; subjectEntity: string; passages: Array<{ text: string }> }>,
    operation: string,
    callType: "primary" | "consistency_retry" | "fill_in",
    verifyVersion: string,
    // D025 §2 — the reconciliation retry needs a dynamic message; same system prompt either way.
    user: string = "Return the JSON now."
  ): Promise<{ results: VerifyProcessedResult[] }> {
    // D026 §7/§11 — each passage becomes a source-labeled, numbered sentence set; the model cites {source, n}, never generates a quote.
    const sentencesByClaim = new Map<string, Record<string, PassageSentence[]>>(
      pairs.map((p) => [p.id, buildPassageSentencesMulti(p.claim, p.passages.map((passage, i) => ({ label: passageLabelForIndex(i), text: passage.text })))])
    );
    // g17 — subject_entity threaded through so VERIFY itself can notice a passage about a different real entity, not just the reranker.
    const renderedPairs = pairs.map((p) => ({ id: p.id, claim: p.claim, subject_entity: p.subjectEntity, passage_sentences: sentencesByClaim.get(p.id) ?? {} }));
    // Telemetry — distinguishes "pooling didn't help" from "few passages were ever pooled."
    logger.info(
      {
        module: MODULE,
        operation: "callVerify",
        auditId,
        claimCount: pairs.length,
        totalPassages: pairs.reduce((sum, p) => sum + p.passages.length, 0),
        totalSentences: [...sentencesByClaim.values()].reduce((sum, bySource) => sum + Object.values(bySource).reduce((s, arr) => s + arr.length, 0), 0),
      },
      "VERIFY call built — passage/sentence pooling stats"
    );
    const system = this.prompts.render("grounnel-verify", {
      claim_passage_pairs: JSON.stringify(renderedPairs),
      threshold: String(CONFIDENCE_THRESHOLD),
    });
    // No quotedFields needed — the raw response only ever contains citations, not scraped text.
    // D026 §19 — a single-claim call attributes claimId; a batch stays undefined.
    const claimId = pairs.length === 1 ? pairs[0]!.id : undefined;
    const raw = await this.callGrounnelJson(auditId, system, user, VerifyRawResponseSchema, operation, callType, verifyVersion, [], claimId);
    return {
      results: raw.results.map((r) => {
        const resolved = resolveEvidenceFromCitations(r.evidenceCitations, sentencesByClaim.get(r.id) ?? {});
        return {
          id: r.id,
          verdict: r.verdict,
          evidence: resolved.evidence,
          citations: resolved.citations,
          reason: r.reason,
          confidence: r.confidence,
        };
      }),
    };
  }

  /** D025 §2 — one shared reconciliation prompt for every diagnostic, not one prompt per diagnostic code. Shows the model its own previous answer plainly, instructs deterministic repair, not a second guess. */
  private buildReconciliationUser(previous: { verdict: Verdict; evidence: string | null; reason: string | null }, diagnostics: Diagnostic[]): string {
    const diagnosticsText = diagnostics.map((d) => `- ${d.code}: ${d.details}`).join("\n");
    return [
      "Your previous answer for this claim was:",
      `verdict: ${previous.verdict}`,
      `evidence: ${previous.evidence ?? "null"}`,
      `reason: ${previous.reason ?? "null"}`,
      "",
      "Diagnostics:",
      diagnosticsText,
      "",
      "Treat the passage_sentences given below as the only source of truth. Resolve every diagnostic listed above. Replace your previous answer entirely unless it remains fully consistent with those sentences. If contradicted, evidence_citations must cite real {source, n} pairs from the passage_sentences given for this pair; otherwise evidence_citations must be null.",
      "",
      "Return the JSON now.",
    ].join("\n");
  }

  /** T034/D025 — one bounded retry for a single claim, fired only when runGateChain flags a self-inconsistent VERIFY output. Never blocks the batch: a retry failure just keeps the original (already gate-processed) result. */
  private async retryVerifyClaim(
    auditId: string,
    item: ResolvedWithPassage,
    verifyVersion: string,
    previous: { verdict: Verdict; evidence: string | null; reason: string | null },
    diagnostics: Diagnostic[]
  ): Promise<VerifyProcessedResult | RateLimitError | null> {
    const pairs = [{ id: item.claim.id, claim: item.claim.text, subjectEntity: item.claim.subjectEntity, passages: item.passages.map((p) => ({ text: p.text! })) }];
    const user = this.buildReconciliationUser(previous, diagnostics);
    try {
      const parsed = await this.callVerify(auditId, pairs, "retryVerifyClaim", "consistency_retry", verifyVersion, user);
      return parsed.results.find((r) => r.id === item.claim.id) ?? null;
    } catch (err) {
      // Propagate, don't swallow — a retry hitting the same rate limit needs the same fail-fast treatment as runBatch's primary call.
      if (err instanceof RateLimitError) {
        logger.error({ module: MODULE, operation: "retryVerifyClaim", auditId, claimId: item.claim.id, limitType: err.limitType }, "Gemini rate-limited during a T034 retry");
        return err;
      }
      logger.warn({ module: MODULE, operation: "retryVerifyClaim", auditId, claimId: item.claim.id, err }, "VERIFY retry failed — keeping the original gate-processed result");
      return null;
    }
  }

  /** One batched call per VERIFY batch, not one per claim — a safety net, so any failure just skips this batch's check rather than blocking the run (D025 §2). */
  private async checkReasonVerdictConsistency(
    auditId: string,
    items: Array<{ id: string; claim: string; reason: string | null; verdict: Verdict }>
  ): Promise<Map<string, boolean>> {
    if (items.length === 0) return new Map();
    const pairs = items.map((i) => ({ id: i.id, claim: i.claim, reason: i.reason, verdict: i.verdict }));
    const system = this.prompts.render("grounnel-consistency-check", { reason_verdict_pairs: JSON.stringify(pairs) });
    // D026 §19 — same convention as callVerify: single-item batch attributes claimId.
    const claimId = items.length === 1 ? items[0]!.id : undefined;
    try {
      const parsed = await this.callGrounnelJson(
        auditId,
        system,
        "Return the JSON now.",
        ConsistencyCheckResponseSchema,
        "checkReasonVerdictConsistency",
        "consistency_check",
        this.prompts.getGrounnelConsistencyCheckVersion(),
        [],
        claimId
      );
      // Schema-valid but empty is indistinguishable from "the model ignored every candidate" — worth a log line.
      if (parsed.results.length === 0) {
        logger.warn({ module: MODULE, operation: "checkReasonVerdictConsistency", auditId, requested: items.length }, "Consistency check returned zero results for a non-empty candidate batch");
      }
      return new Map(parsed.results.map((r) => [r.id, r.consistent]));
    } catch (err) {
      logger.warn({ module: MODULE, operation: "checkReasonVerdictConsistency", auditId, err }, "Consistency check failed — skipping this batch's reconciliation check, gate #1 still covers evidence-groundedness");
      return new Map();
    }
  }

  /** Spec 013 T21 — the second call for claims that select an instance: asks which member the PASSAGES attribute the fact to. Same batched safety-net shape as the consistency classifier. */
  private async checkInstanceAttribution(
    auditId: string,
    items: Array<{ id: string; claim: string; passages: string[] }>
  ): Promise<Map<string, InstanceAttribution>> {
    if (items.length === 0) return new Map();
    // `fact` is the claim itself — production has no separate asserted-value field; see t21-results.md for the fixtures' shape.
    const checks = items.map((i) => ({ id: i.id, claim: i.claim, fact: i.claim, passages: i.passages }));
    const system = this.prompts.render("grounnel-instance-attribution", { instance_checks: JSON.stringify(checks) });
    const claimId = items.length === 1 ? items[0]!.id : undefined;
    try {
      const parsed = await this.callGrounnelJson(
        auditId,
        system,
        "Return the JSON now.",
        InstanceAttributionResponseSchema,
        "checkInstanceAttribution",
        "instance_attribution",
        this.prompts.getGrounnelInstanceAttributionVersion(),
        // Both fields quote passage text verbatim; isSuspectedInjection hard-stops (never repairs) on a false positive.
        ["citation", "working"],
        claimId
      );
      if (parsed.results.length === 0) {
        logger.warn({ module: MODULE, operation: "checkInstanceAttribution", auditId, requested: items.length }, "Instance-attribution check returned zero results for a non-empty candidate batch");
      }
      // Verdict-moving answers must be grounded by construction (D026 §7) — the prompt promises a
      // verbatim citation, so verify it really is one instead of trusting the field's presence.
      const passagesById = new Map(items.map((i) => [i.id, i.passages.join("\n\n")]));
      const accepted = new Map<string, InstanceAttribution>();
      for (const r of parsed.results) {
        const movesVerdict = r.attribution === "different" || r.attribution === "conflict";
        const grounded = !!r.citation?.trim() && evidenceMatchesPassage(r.citation, passagesById.get(r.id) ?? "");
        if (movesVerdict && !grounded) {
          logger.warn({ module: MODULE, operation: "checkInstanceAttribution", auditId, claimId: r.id, attribution: r.attribution, citation: r.citation }, "Dropped an ungrounded instance-attribution answer — citation absent from the passages");
          continue;
        }
        accepted.set(r.id, r.attribution);
      }
      return accepted;
    } catch (err) {
      logger.warn({ module: MODULE, operation: "checkInstanceAttribution", auditId, err }, "Instance-attribution check failed — skipping this batch's check, the gate chain still runs");
      return new Map();
    }
  }

  /** D025 §5 addendum, extended D030 §3i Mode B — re-checks a retry landing on any RETRY_DOWNGRADE
   * key (was `contradicted`-only). Single-claim, no second retry, downgrade-only. See D030 §3i for
   * why `supported`/`partially_supported` never force `contradicted`, and why both branches null
   * evidence rather than just the `contradicted` one. */
  private async checkRetryContradiction(
    auditId: string,
    item: ResolvedWithPassage,
    chain: { verdict: Verdict; evidence: string | null; gateEvents: GateEventInput[] },
    // This pass's gate events only, not chain.gateEvents (see originatingContradictionGate).
    currentPassGateEvents: GateEventInput[],
    reason: string | null,
    previousEvidence: string | null,
    previousReason: string | null
  ): Promise<{ verdict: Verdict; evidence: string | null; gateEvents: GateEventInput[] }> {
    const downgrade = RETRY_DOWNGRADE[chain.verdict];
    if (!downgrade) return chain;

    const consistencyMap = await this.checkReasonVerdictConsistency(auditId, [
      { id: item.claim.id, claim: item.claim.text, reason, verdict: chain.verdict },
    ]);
    // Fail-open on a classifier error, same convention as D025 §2's own catch-and-skip.
    const consistent = consistencyMap.get(item.claim.id) ?? true;

    // Logged only, not gated on yet — a same-evidence/near-identical-reasoning retry smells like relabeling, not re-reasoning.
    const evidenceChanged = (chain.evidence ?? "").trim() !== (previousEvidence ?? "").trim();
    const previousTerms = extractKeyTerms(previousReason ?? "");
    const reasonSimilarity = previousTerms.length > 0 ? scoreKeyTermMatches(previousTerms, reason ?? "") / previousTerms.length : null;
    logger.info(
      { module: MODULE, operation: "checkRetryContradiction", auditId, claimId: item.claim.id, verdictBefore: chain.verdict, consistent, evidenceChanged, reasonSimilarity },
      "Retry landed on a least-scrutinized verdict — logged reconciliation-quality signals"
    );

    if (!consistent) {
      logReconciliationDowngrade("checkRetryContradiction", auditId, item.claim.id, chain.verdict, downgrade.target, originatingContradictionGate(currentPassGateEvents));
    }

    const gateEvent: GateEventInput = {
      gate: "retry_reconciliation",
      verdictBefore: chain.verdict,
      verdictAfter: consistent ? chain.verdict : downgrade.target,
      overridden: !consistent,
      reason: consistent ? null : downgrade.reason,
    };
    if (consistent) {
      return { ...chain, gateEvents: [...chain.gateEvents, gateEvent] };
    }
    return { verdict: downgrade.target, evidence: null, gateEvents: [...chain.gateEvents, gateEvent] };
  }

  /** Runs the gate chain + T034 retry + persistence for one VERIFY response — shared by runBatch's primary and fill-in passes (D026 §8, T045). Mutates answeredIds/retryState/gateEventsByClaimId. */
  private async processVerifyResults(
    auditId: string,
    items: ResolvedWithPassage[],
    parsed: { results: VerifyProcessedResult[] },
    verifyVersion: string,
    retryState: { rateLimit: RateLimitError | null },
    answeredIds: Set<string>,
    gateEventsByClaimId: Map<string, GateEventInput[]>,
    // D030 §3d — same set reconcileContradictedVerdicts populates for reason_ordinal; the
    // escalation-replacement floor below (D030 §3h) adds to it too, for the same reason.
    protectedContradictionClaimIds: Set<string>,
    priorResults?: Map<string, PriorResult>
  ): Promise<void> {
    const byId = new Map(items.map((b) => [b.claim.id, b]));

    // Dedupes a VERIFY response answering one claim id twice.
    const seenIds = new Set<string>();
    const duplicateIds: string[] = [];
    // initialVerdict (what the gate chain operates on, e.g. confidence-downgraded) computed once, before the classifier call.
    const knownResults = parsed.results
      .filter((r) => byId.has(r.id))
      .filter((r) => {
        if (seenIds.has(r.id)) {
          duplicateIds.push(r.id);
          return false;
        }
        seenIds.add(r.id);
        return true;
      })
      .map((r) => ({
        result: r,
        initialVerdict: (r.confidence < CONFIDENCE_THRESHOLD && r.verdict !== "unverifiable" ? "unverifiable" : r.verdict) as Verdict,
      }));
    if (duplicateIds.length > 0) {
      logger.warn({ module: MODULE, operation: "processVerifyResults", auditId, duplicateIds }, "VERIFY response answered the same claim id more than once — keeping the first answer, discarding the rest");
    }

    // D025 §2 — one batched classifier call up front, covering every claim not already
    // "contradicted", so runGateChain (still pure/sync) can just read the result per claim below.
    const secondCallCandidates = knownResults.filter((k) => k.initialVerdict !== "contradicted");
    // Spec 013 T21 — claims naming an instance ("the first flight") get a SECOND auditor that sees the
    // passages, the input the consistency classifier lacks (it can't tell "longest" from "first").
    const attributionCandidates = secondCallCandidates.filter(
      (k) => ATTRIBUTION_ACTIONABLE_VERDICTS.has(k.initialVerdict) && extractInstanceSelector(byId.get(k.result.id)!.claim.text) !== null
    );
    const [consistencyMap, attributionMap] = await Promise.all([
      this.checkReasonVerdictConsistency(
        auditId,
        secondCallCandidates.map((k) => ({ id: k.result.id, claim: byId.get(k.result.id)!.claim.text, reason: k.result.reason, verdict: k.initialVerdict }))
      ),
      this.checkInstanceAttribution(
        auditId,
        attributionCandidates.map((k) => ({ id: k.result.id, claim: byId.get(k.result.id)!.claim.text, passages: byId.get(k.result.id)!.passages.map((p) => p.text!) }))
      ),
    ]);

    await Promise.all(
      knownResults.map(async ({ result, initialVerdict }) => {
        const item = byId.get(result.id)!; // safe — knownResults is already filtered by byId.has
        answeredIds.add(item.claim.id);

        let reason = result.reason;
        let confidence = result.confidence;
        // D027 §2 — reassigned on a successful retry, same as reason/confidence just below.
        let citationsBeforeGates = result.citations;
        // D026 §11 — gate #1's backstop runs on the joined text of every pooled passage; evidence
        // is already grounded per-source by construction, this just answers "is it real text."
        const passageText = item.passages.map((p) => p.text!).join("\n\n");

        const firstPass = runGateChain({
          verdict: initialVerdict,
          reason,
          evidence: result.evidence,
          claimText: item.claim.text,
          passageText,
          subjectEntity: item.claim.subjectEntity,
          reasonSupportsVerdict: consistencyMap.get(result.id) ?? null,
          instanceAttribution: attributionMap.get(result.id) ?? null,
        });
        let chain = firstPass;
        // D030 §3d — originatingContradictionGate must see only the current pass, not the concatenated trail.
        let currentPassGateEvents = firstPass.gateEvents;

        // D030 §3c — a gate-forced "contradicted" skips T034's retry; reconcileContradictedVerdicts grounds it instead.
        if (chain.verdict !== "contradicted" && firstPass.needsRetry) {
          const retried = await this.retryVerifyClaim(
            auditId,
            item,
            verifyVersion,
            { verdict: initialVerdict, evidence: result.evidence, reason },
            firstPass.diagnostics
          );
          if (retried instanceof RateLimitError) {
            retryState.rateLimit = retried;
          } else if (retried) {
            reason = retried.reason;
            confidence = retried.confidence;
            citationsBeforeGates = retried.citations;
            const retryVerdict = confidence < CONFIDENCE_THRESHOLD && retried.verdict !== "unverifiable" ? "unverifiable" : retried.verdict;
            // Capped at one attempt, not re-classified (D025 §2) — deterministic gates still apply.
            const retryPass = runGateChain({
              verdict: retryVerdict,
              reason,
              evidence: retried.evidence,
              claimText: item.claim.text,
              passageText,
              subjectEntity: item.claim.subjectEntity,
              reasonSupportsVerdict: null,
              // Reused, not re-called: this answer depends only on claim + passages, neither of which a retry changes.
              instanceAttribution: attributionMap.get(result.id) ?? null,
            });
            // Reviewed finding: concatenate, don't replace — the original self-inconsistent pass
            // (the override that triggered this retry) stays in the audit trail, not just the retry's.
            chain = { ...retryPass, gateEvents: [...firstPass.gateEvents, ...retryPass.gateEvents] };
            currentPassGateEvents = retryPass.gateEvents;
            // D025 §5 addendum, D030 §3i Mode B — the retry itself gets one bounded check (RETRY_DOWNGRADE's verdicts only).
            const preCheckCount = chain.gateEvents.length;
            chain = { ...chain, ...(await this.checkRetryContradiction(auditId, item, chain, retryPass.gateEvents, reason, result.evidence, result.reason)) };
            // Review finding — checkRetryContradiction appends at most one event; without this,
            // gateEventsByClaimId (current-pass-only, unlike chain.gateEvents) silently drops it.
            currentPassGateEvents = [...currentPassGateEvents, ...chain.gateEvents.slice(preCheckCount)];

            // Telemetry only, never changes verdict — D030 §3k. Before this, "did a retry fire, on
            // what trigger, did it help or hurt" was only reconstructable by parsing raw llm_calls
            // JSON and sorting by timestamp (the exact archaeology that traced bd11759e). The
            // triggering diagnostic's own `code` already reuses GateReason (see Diagnostic's own
            // comment), so no new reason values are needed — `counterfact_ignored` here means the
            // consistency classifier said inconsistent; `evidence_null`/`evidence_not_grounded`/
            // `claim_reason_no_overlap` mean a gate itself raised the ERROR, not the classifier.
            //
            // Review finding — appended to chain.gateEvents (persisted to the DB) ONLY, never to
            // currentPassGateEvents. currentPassGateEvents feeds gateEventsByClaimId, which
            // originatingContradictionGate (pipeline-helpers.ts) scans via
            // `findLast(overridden && verdictAfter === "contradicted")` to find the gate that
            // ACTUALLY produced a contradiction — used by reconcileContradictedVerdicts' reason_ordinal
            // protection (D030 §3d, line ~235) and by logReconciliationDowngrade's telemetry. This
            // event's own overridden/verdictAfter shape matches that predicate whenever a retry lands
            // on "contradicted", so appending it here would shadow the real originating gate — silently
            // disabling reason_ordinal's protection for every retry-produced contradiction.
            const triggeringDiagnostic = firstPass.diagnostics.find((d) => d.severity === "ERROR")?.code ?? null;
            const retryDecisionEvent: GateEventInput = {
              gate: "retry_decision",
              verdictBefore: firstPass.verdict,
              verdictAfter: chain.verdict,
              overridden: firstPass.verdict !== chain.verdict,
              reason: triggeringDiagnostic,
            };
            chain = { ...chain, gateEvents: [...chain.gateEvents, retryDecisionEvent] };
          }
        }

        const { verdict, evidence, gateEvents } = chain;
        const sources = toClaimSources(item.sources);
        // D027 §2 — citations survive iff the evidence they back survived the gate chain.
        const citations = evidence !== null ? attachCitationUrls(citationsBeforeGates, item.passages) : [];

        // D030 §3h — escalation-result validity floor: an evidence-empty tier must not silently overwrite a prior tier's grounded result. Orthogonal to guardEscalatedContradictionReversals (which only re-checks evidence-backed flips away from "contradicted").
        const prior = priorResults?.get(item.claim.id);
        const rejectReplacement = prior?.hasValidEvidence && !hasValidEvidence(citations);
        // One array, appended to the single recordGateEvents call below — D023 §5/T027's "exactly one gate-events batch per claim per pass" convention holds for this event too.
        const finalGateEvents: GateEventInput[] = prior
          ? [
              ...gateEvents,
              {
                gate: "escalation_replacement",
                verdictBefore: prior.verdict,
                verdictAfter: rejectReplacement ? prior.verdict : verdict,
                overridden: Boolean(rejectReplacement),
                reason: rejectReplacement ? "escalation_no_valid_evidence" : null,
              },
            ]
          : gateEvents;

        if (rejectReplacement) {
          // D030 §3h review finding — also stops reconcileContradictedVerdicts (end of this runBatch) and findUnresolvedClaims from re-touching an already-settled claim.
          protectedContradictionClaimIds.add(item.claim.id);
          this.gateEventStore.recordGateEvents(auditId, item.claim.id, finalGateEvents);
          gateEventsByClaimId.set(item.claim.id, currentPassGateEvents);
          logger.info(
            { module: MODULE, operation: "processVerifyResults", auditId, claimId: item.claim.id, priorVerdict: prior!.verdict, attemptedVerdict: verdict },
            "Escalation tier produced no usable evidence — keeping the prior grounded result"
          );
          return;
        }

        // D031/D032 §3f/T6b — user-facing text only; historyStore below keeps VERIFY's raw reason.
        // currentPassGateEvents, not gateEvents (retry-concatenated and stale — see ADR).
        const userFacingReason = composeUserFacingReason(verdict, currentPassGateEvents, citations.length, reason);
        const result_: ClaimResult = { status: "done", verdict, evidence, confidence, reason: userFacingReason, sources, citations };
        await this.grounnelStore.writeClaimResult(auditId, item.claim.id, result_);
        // D027 §4 — deliberately no `citations` here: historyStore's Postgres row doesn't carry it (out of scope for this change).
        await this.historyStore.createClaim({
          claimId: item.claim.id,
          runId: auditId,
          claimText: item.claim.text,
          sourceExcerpt: item.claim.sourceExcerpt,
          verdict,
          evidence,
          confidence,
          reason,
          sources,
          status: "done",
        });
        // Buffered until here, flushed only after the claim row above — grounnel_gate_events.claimId
        // has a real FK, and gates finish before that row exists (D023 §5/T027).
        this.gateEventStore.recordGateEvents(auditId, item.claim.id, finalGateEvents);
        // Current pass only, not the concatenated `gateEvents` above — see the comment where
        // currentPassGateEvents is declared.
        gateEventsByClaimId.set(item.claim.id, currentPassGateEvents);
      })
    );
  }

  /** Returns the RateLimitError if this batch stopped because Gemini itself is rate-limited — the caller uses this to stop early, not just degrade this one batch. */
  private async runBatch(
    auditId: string,
    batch: ResolvedWithPassage[],
    protectedContradictionClaimIds: Set<string>,
    // D030 §3h — only set by escalateUnresolved's tiers; undefined on the primary pass, which has nothing yet to protect.
    priorResults?: Map<string, PriorResult>
  ): Promise<RateLimitError | null> {
    const pairs = batch.map((b) => ({ id: b.claim.id, claim: b.claim.text, subjectEntity: b.claim.subjectEntity, passages: b.passages.map((p) => ({ text: p.text! })) }));
    const verifyVersion = this.prompts.getGrounnelVerifyVersion();
    // Best-effort (D023 §7) — every batch stamps the same value; cheap and idempotent, simpler
    // than tracking "already stamped" across an arbitrary number of batches for one run.
    waitUntil(this.historyStore.updateRun(auditId, { promptVersionVerify: verifyVersion }));

    let parsed: { results: VerifyProcessedResult[] };
    try {
      parsed = await this.callVerify(auditId, pairs, "runBatch", "primary", verifyVersion);
    } catch (err) {
      if (err instanceof RateLimitError) {
        logger.error({ module: MODULE, operation: "runBatch", auditId, limitType: err.limitType }, "Gemini rate-limited during VERIFY — stopping");
        await this.degradeBatch(auditId, batch, buildGeminiRateLimitMessage(err));
        return err;
      }
      // A failed VERIFY batch marks its claims not_checked (status: "failed") and the run
      // continues — never fails the whole audit over one bad batch (spec.md Success Criteria).
      logger.error({ module: MODULE, operation: "runBatch", auditId, err }, "VERIFY batch failed after retries — degrading to not_checked");
      await this.degradeBatch(auditId, batch, "VERIFY failed after retries (provider/parse error) — see grounnel_llm_calls for detail.");
      return null;
    }

    const answeredIds = new Set<string>();
    // Object, not a bare `let`: TS doesn't narrow a closure's mutation across an `await`, so a plain `let` would wrongly narrow to `never`.
    const retryState: { rateLimit: RateLimitError | null } = { rateLimit: null };
    const gateEventsByClaimId = new Map<string, GateEventInput[]>();

    await this.processVerifyResults(auditId, batch, parsed, verifyVersion, retryState, answeredIds, gateEventsByClaimId, protectedContradictionClaimIds, priorResults);

    if (retryState.rateLimit) {
      logger.error({ module: MODULE, operation: "runBatch", auditId, limitType: retryState.rateLimit.limitType }, "Gemini rate-limited during a T034 retry — stopping remaining batches");
      return retryState.rateLimit;
    }

    // D026 §8 (T045) — never trust a batch answered every claim; fire one targeted fill-in call for whatever's missing.
    let missing = batch.filter((b) => !answeredIds.has(b.claim.id));
    if (missing.length > 0) {
      logger.warn(
        { module: MODULE, operation: "runBatch", auditId, missingIds: missing.map((m) => m.claim.id) },
        "VERIFY response omitted some claims — firing a fill-in retry for exactly those"
      );
      const fillInPairs = missing.map((b) => ({ id: b.claim.id, claim: b.claim.text, subjectEntity: b.claim.subjectEntity, passages: b.passages.map((p) => ({ text: p.text! })) }));
      try {
        const fillIn = await this.callVerify(auditId, fillInPairs, "runBatch.fillIn", "fill_in", verifyVersion);
        await this.processVerifyResults(auditId, missing, fillIn, verifyVersion, retryState, answeredIds, gateEventsByClaimId, protectedContradictionClaimIds, priorResults);
        // Cast, not a plain read — TS carries the earlier null-narrowing across the mutating call, wrongly typing this as `never`.
        const fillInRateLimit = retryState.rateLimit as RateLimitError | null;
        if (fillInRateLimit) {
          logger.error(
            { module: MODULE, operation: "runBatch", auditId, limitType: fillInRateLimit.limitType },
            "Gemini rate-limited during a T034 retry fired from the fill-in pass — stopping remaining batches"
          );
          return fillInRateLimit;
        }
      } catch (err) {
        if (err instanceof RateLimitError) {
          logger.error({ module: MODULE, operation: "runBatch", auditId, limitType: err.limitType }, "Gemini rate-limited during the fill-in retry — stopping");
          await this.degradeBatch(auditId, missing, buildGeminiRateLimitMessage(err));
          return err;
        }
        // Falls through to the generic "still missing" degrade below — same message either way,
        // whether the fill-in call errored outright or just didn't answer everything either.
        logger.warn({ module: MODULE, operation: "runBatch", auditId, err }, "Fill-in retry call itself failed");
      }
      missing = batch.filter((b) => !answeredIds.has(b.claim.id));
    }

    if (missing.length > 0) {
      logger.warn(
        { module: MODULE, operation: "runBatch", auditId, missingIds: missing.map((m) => m.claim.id) },
        "VERIFY response omitted some claims even after a fill-in retry — degrading them to not_checked"
      );
      await this.degradeBatch(
        auditId,
        missing,
        "VERIFY's response omitted this claim, even after a fill-in retry — not a provider/parse error, the model simply didn't answer for it."
      );
    }

    // D026 §22/T064 — every fresh contradicted verdict this batch produced gets the same scrutiny as retries/escalation.
    await this.reconcileContradictedVerdicts(
      auditId,
      batch.map((b) => b.claim),
      gateEventsByClaimId,
      protectedContradictionClaimIds
    );

    return null;
  }
}
