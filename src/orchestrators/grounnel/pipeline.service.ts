import { z, type ZodSchema } from "zod";
import { waitUntil } from "@vercel/functions";
import { logger } from "../../observability/logger.js";
import { callLlmForJson } from "../llm-json-call.js";
import { isPassageRelevant } from "./passage-filter.js";
import { buildPassageSentences, buildPassageSentencesMulti, resolveEvidenceFromCitations, type PassageSentence, type ResolvedCitation } from "./passage-sentences.js";
import { applyClaimReasonOverlapGate, applyContradictionEvidenceGate, applyCounterfactIgnoredGate, applyImplicitNegationGate, applyNumericGate, applyReasonConsistencyGate, applyReasonOrdinalGate, applyReasonYearGate, applyYearGate } from "./gates.js";
import { extractKeyTerms, scoreKeyTermMatches } from "../../lib/claim-terms.js";
import { RateLimitError } from "../../providers/gemini.js";
import { env } from "../../lib/env.js";
import { GrounnelVerdictEnum, type ClaimResult, type ClaimSource, type ClaimCitation } from "../../contracts/grounnel.schemas.js";
import type { Provider } from "../../providers/types.js";
import type { PromptRegistry } from "../../prompts/registry.js";
import type { GrounnelStore } from "../../persistence/grounnel-store.js";
import type { GrounnelHistoryStore } from "../../persistence/grounnel-history-store.js";
import type { GrounnelLlmCallStore } from "../../persistence/grounnel-llm-call-store.js";
import type { GrounnelGateEventStore, GateEventInput } from "../../persistence/grounnel-gate-event-store.js";
import { NoopGrounnelRerankDecisionStore, type GrounnelRerankDecisionStore } from "../../persistence/grounnel-rerank-decision-store.js";
import type { SearchProvider, SearchPassage } from "../../providers/search/search-provider.js";
import type { GateReason } from "../../persistence/types.js";

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
// D026 §11 (T049) — Phase 1 multi-passage evidence, fixed cap; §13 (T053) built the escalation this deferred.
const MAX_VERIFY_PASSAGES = 3;
// D026 §13 — a claim still unsupported/unverifiable (or zero evidence) after the normal pipeline
// gets re-tried against a wider DIY candidate pool, one tier at a time, bounded at 2 escalations.
const ESCALATION_TIERS = [5, 8];
type Verdict = z.infer<typeof GrounnelVerdictEnum>;

const NO_EVIDENCE_REASON = "No relevant source found for this claim.";
const TAVILY_RATE_LIMITED_REASON = "This claim could not be checked right now — our search provider's rate limit was reached. Try again later.";

/** Client-facing message for a Gemini RateLimitError — also reused by the route handler for EXTRACT's own case (no audit exists yet there, so it becomes the /extract response directly). */
export function buildGeminiRateLimitMessage(err: RateLimitError): string {
  if (err.limitType === "daily") {
    return err.resetsAt
      ? `We've hit today's AI usage limit. Please try again after ${err.resetsAt}.`
      : "We've hit today's AI usage limit. Please try again tomorrow.";
  }
  return "We're being rate-limited right now. Please try again in a few minutes.";
}

const VerifyResultSchema = z.object({
  id: z.string(),
  verdict: GrounnelVerdictEnum,
  // Gemini sometimes omits a null-valued key entirely rather than sending `null` — same
  // normalization idiom as audit-internal.schemas.ts's VerifyResultSchema (D018 §5, production incident).
  evidence: z.string().nullable().optional().transform((v) => v ?? null),
  reason: z.string().nullable().optional().transform((v) => v ?? null),
  confidence: z.number().min(0).max(1),
});
// D027 — callVerify's real return shape (see ADR §3 for why citations aren't part of VerifyResultSchema itself).
type VerifyProcessedResult = z.infer<typeof VerifyResultSchema> & { citations: ResolvedCitation[] };

// D026 §7/§11 — cites {source, n} pairs, never free-text quotes. Derived from VerifyResultSchema
// (not copy-pasted) so fields can't drift. `source` names which pooled passage a citation is from.
const VerifyRawResultSchema = VerifyResultSchema.omit({ evidence: true }).extend({
  evidenceCitations: z
    .array(z.object({ source: z.string(), n: z.number().int() }))
    .nullable()
    .optional()
    .transform((v) => v ?? null),
});
const VerifyRawResponseSchema = z.object({ results: z.array(VerifyRawResultSchema) });

// D025/T035 — batched "does reason support verdict?" classifier response.
const ConsistencyCheckResultSchema = z.object({ id: z.string(), consistent: z.boolean() });
const ConsistencyCheckResponseSchema = z.object({ results: z.array(ConsistencyCheckResultSchema) });

// D026 §18 — batched passage-relevance reranker response; score only, no free-text field (nothing
// downstream reads an explanation, so the prompt doesn't ask for one).
const PassageRerankResultSchema = z.object({ id: z.string(), score: z.number().min(0).max(100) });
const PassageRerankResponseSchema = z.object({ results: z.array(PassageRerankResultSchema) });

/** One gate's finding, generalized past a single needsRetry boolean tied to one gate (D025 §2).
 * Reviewed finding: `code` reuses `GateReason` (not a bare string) so it can't drift from what's
 * persisted to grounnel_gate_events.reason for the same finding. */
interface Diagnostic {
  code: GateReason;
  severity: "ERROR" | "WARNING" | "INFO";
  details: string;
}

export interface PipelineClaimInput {
  id: string;
  text: string;
  // D028 — verified verbatim substring of the source text, or null if unproduced/unverified.
  sourceExcerpt: string | null;
}

interface ResolvedEvidence {
  claim: PipelineClaimInput;
  // D026 §11 — up to MAX_VERIFY_PASSAGES ranked sources; array order is rank order, which
  // callVerify's label assignment depends on being meaningful.
  passages: SearchPassage[];
  sources: SearchPassage[];
}

interface ResolvedWithPassage extends ResolvedEvidence {
  passages: SearchPassage[]; // guaranteed non-empty by hasPassage below
}

function hasPassage(r: ResolvedEvidence): r is ResolvedWithPassage {
  return r.passages.length > 0;
}

function toClaimSources(sources: SearchPassage[]): ClaimSource[] {
  return sources.map((s) => ({ kind: "web" as const, title: s.title, domain: s.domain, url: s.url, status: s.status, retrievalMethod: s.retrievalMethod }));
}

// D027 §2 — callVerify's citation label codec ("A"-"Z" over `passages`, rank order); single-letter
// only, coupled by convention to MAX_VERIFY_PASSAGES staying ≤ 26 (guarded below, not just assumed).
function passageLabelForIndex(i: number): string {
  if (i >= 26) throw new Error(`passageLabelForIndex: index ${i} exceeds the single-letter A-Z label scheme`);
  return String.fromCharCode(65 + i);
}
function passageIndexForLabel(label: string): number {
  return label.charCodeAt(0) - 65;
}

// Reconciliation-disagreement telemetry (D030 T010 backlog, 2026-08-19 — see tasks.md for why).
// Caller must pass only the gate events of the PASS whose verdict is currently standing (e.g.
// retryPass, not firstPass ++ retryPass) — reviewed finding: scanning a concatenated audit trail can
// find a stale, already-superseded flip from a discarded earlier pass instead of the real origin.
function originatingContradictionGate(gateEvents: GateEventInput[]): { gate: string; reason: GateReason | null } | null {
  const event = gateEvents.findLast((e) => e.overridden && e.verdictAfter === "contradicted");
  return event ? { gate: event.gate, reason: event.reason } : null;
}

// Shared by checkRetryContradiction and reconcileContradictedVerdicts — one message shape, one set
// of keys, so the two downgrade sites stay aggregatable as a single log stream (tasks.md backlog).
function logReconciliationDowngrade(operation: string, auditId: string, claimId: string, originating: { gate: string; reason: GateReason | null } | null): void {
  logger.info(
    { module: MODULE, operation, auditId, claimId, verdictBefore: "contradicted" as const, originatingGate: originating?.gate ?? null, originatingReason: originating?.reason ?? null },
    "Reconciliation classifier downgraded a contradicted verdict to unsupported"
  );
}

// D027 §2 — out-of-range labels are dropped (logged), not thrown; see ADR §2 for why this is safe by construction today.
function attachCitationUrls(citations: ResolvedCitation[], passages: SearchPassage[]): ClaimCitation[] {
  const result: ClaimCitation[] = [];
  for (const citation of citations) {
    const passage = passages[passageIndexForLabel(citation.source)];
    if (!passage) {
      logger.warn({ module: MODULE, operation: "attachCitationUrls", source: citation.source }, "Citation source label did not resolve to a pooled passage — dropping this citation");
      continue;
    }
    result.push({ source: citation.source, sentence: citation.sentence, url: passage.url, text: citation.text });
  }
  return result;
}

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
    // D026 §19 — defaulted, not required: keeps every pre-existing call site (production wiring in
    // server.ts/run-grounnel-eval.ts aside) compiling unchanged; only tests that specifically assert
    // on rerank-decision telemetry need to pass a real one.
    private readonly rerankDecisionStore: GrounnelRerankDecisionStore = new NoopGrounnelRerankDecisionStore()
  ) {}

  async run(auditId: string, claims: PipelineClaimInput[], searchEngine: "defaultFlow" | "tavily" = "defaultFlow"): Promise<void> {
    try {
      // D026 §14/§15 (reviewed finding, real live-test recurrence 2026-08-10): set BEFORE the main
      // verify loop, not just around escalateUnresolved — the main loop's LAST writeClaimResult can
      // make checked===total true before an await-wrapped setEscalating(true) call after it has
      // actually landed in Redis, leaving a real (if narrow) window where a poll still sees the old
      // premature "done". Setting it here means the flag is already true long before any claim could
      // finish — but it must stay inside this try, not before it, or a Redis failure on this exact
      // call would skip the catch below and never mark the run "failed" in Postgres.
      await this.grounnelStore.setEscalating(auditId, true);
      try {
        const resolved = await this.resolveAllEvidence(auditId, claims, searchEngine);

        const noEvidence = resolved.filter((r) => !hasPassage(r));
        await Promise.all(noEvidence.map((r) => this.writeNoEvidence(auditId, r)));

        const needsVerify = resolved.filter(hasPassage);
        let rateLimitedMidRun = false;
        for (let i = 0; i < needsVerify.length; i += BATCH_MAX) {
          const batch = needsVerify.slice(i, i + BATCH_MAX);
          const geminiRateLimit = await this.runBatch(auditId, batch);
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

        // D026 §13 — escalation needs more Gemini calls; if the primary pass already hit a rate
        // limit, escalating would just fail the same way, so skip it entirely rather than retry into it.
        if (!rateLimitedMidRun) {
          const escalationT0 = Date.now();
          await this.escalateUnresolved(auditId, claims, searchEngine);
          logger.info({ module: MODULE, operation: "run", auditId, durationMs: Date.now() - escalationT0 }, "Escalation phase finished");
        }
      } finally {
        // D026 §15 — must clear on every path (success, rate-limit-skip, or throw below), since
        // setEscalating(true) above is now unconditional; without this the run sticks at "verifying" forever.
        await this.grounnelStore.setEscalating(auditId, false);
      }
    } catch (err) {
      // Reviewed finding: status otherwise never reaches "failed" on an uncaught error here
      // (e.g. a SearchProvider bug) — the row would stay stuck at its prior status forever.
      waitUntil(this.historyStore.updateRun(auditId, { status: "failed", completedAt: new Date() }));
      throw err;
    }

    // Best-effort (D023 §7) — this run's Redis state is already fully settled by this point
    // (every claim above has already been written to Redis); Postgres just needs to catch up.
    await this.historyStore.updateRun(auditId, { status: "done", completedAt: new Date() });
  }

  /**
   * D026 §13 (T053, real measured gap — the blue whale live-test finding, 2026-08-10: the DIY
   * discovery step returned 7 real candidates, but only the first 3 ever got fetched; the one page
   * that actually stated the fact wasn't among them). Re-tries a claim against a wider DIY candidate
   * pool ONLY when it's still `unsupported`/`unverifiable`/`contradicted`/`partially_supported` (D026
   * §17) after the normal pipeline — the majority of claims resolve `supported` and never reach here.
   * Reuses `resolveEvidence`/`runBatch` unchanged (same gate chain, same T034/T051/T052 safety net) —
   * this widens the EVIDENCE pool, it doesn't add new verification logic. Bounded at 2 escalations
   * (`ESCALATION_TIERS`), stops early once a tier resolves a claim or the whole run gets rate-limited.
   */
  private async escalateUnresolved(auditId: string, claims: PipelineClaimInput[], searchEngine: "defaultFlow" | "tavily"): Promise<void> {
    const byId = new Map(claims.map((c) => [c.id, c]));
    let pending = await this.findUnresolvedClaims(auditId, byId);

    for (const tier of ESCALATION_TIERS) {
      if (pending.length === 0) return;
      logger.info({ module: MODULE, operation: "escalateUnresolved", auditId, tier, claimCount: pending.length }, "Escalating unresolved claims to a wider candidate pool");

      // D026 §17 — snapshot each claim's verdict before this tier's runBatch overwrites it;
      // guardEscalatedContradictionReversals needs to know which ones WERE `contradicted` going in.
      const preTierStatus = await this.grounnelStore.getStatus(auditId);
      const preVerdictById = new Map((preTierStatus?.claims ?? []).map((c) => [c.id, c.verdict]));

      // Waved by SEARCH_CONCURRENCY, same as resolveAllEvidence — an unbounded flat Promise.all
      // here would fire one concurrent search() per unresolved claim, which for a large article
      // could be most of it. Stops the tier early on a fresh Tavily rate limit, same convention.
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
        const geminiRateLimit = await this.runBatch(auditId, needsVerify.slice(i, i + BATCH_MAX));
        if (geminiRateLimit) {
          logger.warn({ module: MODULE, operation: "escalateUnresolved", auditId, tier }, "Gemini rate-limited during escalation — stopping further tiers");
          return;
        }
      }

      // D026 §22/T064 — reconcileContradictedVerdicts now runs unconditionally inside runBatch
      // itself (called a few lines up), so it already covered this escalation round's fresh
      // `contradicted` verdicts — no separate call needed here anymore.
      // D026 §17 — symmetric check: a claim that WAS `contradicted` can flip to `supported`/
      // `partially_supported` off this tier's noisier pool; re-verify that flip the same way.
      await this.guardEscalatedContradictionReversals(auditId, needsVerify.map((v) => v.claim), preVerdictById);

      if (tavilyRateLimitedThisTier) {
        logger.warn({ module: MODULE, operation: "escalateUnresolved", auditId, tier }, "Tavily rate-limited during escalation — stopping further tiers");
        return;
      }

      pending = await this.findUnresolvedClaims(auditId, byId);
    }
  }

  /** Reads current Redis state (source of truth) rather than tracking in-memory — escalation runs
   * after every claim in this run has already been written at least once. Excludes claims degraded
   * by a rate limit (Tavily's fixed reason string, or Gemini's mid-run stop) — escalating those
   * would just hit the same wall again, not surface new evidence. D026 §17 — verdict set widened to
   * also include `contradicted`/`partially_supported`; see the ADR for why and for the risk this adds. */
  private async findUnresolvedClaims(auditId: string, byId: Map<string, PipelineClaimInput>): Promise<PipelineClaimInput[]> {
    const status = await this.grounnelStore.getStatus(auditId);
    if (!status) return [];
    return status.claims
      .filter(
        (c) =>
          c.status === "done" &&
          (c.verdict === "unsupported" || c.verdict === "unverifiable" || c.verdict === "contradicted" || c.verdict === "partially_supported") &&
          c.reason !== TAVILY_RATE_LIMITED_REASON &&
          !c.reason?.includes("AI usage limit") &&
          !c.reason?.includes("being rate-limited")
      )
      .map((c) => byId.get(c.id))
      .filter((c): c is PipelineClaimInput => c !== undefined);
  }

  /**
   * D026 §22/T064 (generalized from D026 §13's escalation-only `guardEscalatedContradictions`,
   * self-review finding) — ANY `contradicted` verdict landing straight off a fresh primary VERIFY
   * call (ordinary batch or an escalation round — `runBatch` is the only caller, both paths route
   * through it) gets none of D025 §2/§5's scrutiny by default: `needsRetry` only fires from gate #1's
   * evidence-groundedness check or gate #1b's lexical key-term overlap, neither of which catches a
   * well-evidenced, on-topic, but logically-wrong contradiction (e.g. a nomination misread as a
   * rejection) — exactly the false-positive shape the system's own CORE PRINCIPLE says matters most.
   * Reuses the same batched classifier + downgrade-only-to-`unsupported` convention as D025 §5's
   * `checkRetryContradiction`, scoped to whatever claims the caller just processed.
   */
  private async reconcileContradictedVerdicts(auditId: string, scope: PipelineClaimInput[]): Promise<void> {
    const status = await this.grounnelStore.getStatus(auditId);
    if (!status) return;
    const byId = new Map(scope.map((c) => [c.id, c]));
    const nowContradicted = status.claims.filter((c) => byId.has(c.id) && c.status === "done" && c.verdict === "contradicted");
    if (nowContradicted.length === 0) return;

    const consistencyMap = await this.checkReasonVerdictConsistency(
      auditId,
      nowContradicted.map((c) => ({ id: c.id, claim: c.text, reason: c.reason, verdict: "contradicted" as const }))
    );

    await Promise.all(
      nowContradicted.map(async (c) => {
        const consistent = consistencyMap.get(c.id) ?? true; // fail-open, same convention as D025 §2/§5
        if (consistent) return;
        await this.grounnelStore.writeClaimResult(auditId, c.id, { status: "done", verdict: "unsupported", evidence: null, confidence: c.confidence, reason: c.reason, sources: c.sources, citations: [] });
        await this.historyStore.createClaim({ claimId: c.id, runId: auditId, claimText: c.text, verdict: "unsupported", evidence: null, confidence: c.confidence, reason: c.reason, sources: c.sources, status: "done" });
        this.gateEventStore.recordGateEvents(auditId, c.id, [
          { gate: "retry_reconciliation", verdictBefore: "contradicted", verdictAfter: "unsupported", overridden: true, reason: "retry_contradiction_invalidated" },
        ]);
        // D030 T010 backlog — no in-memory gate trace here (re-reads Redis status); originating gate
        // is reconstructable after the fact via grounnel_gate_events, joined on claimId/created_at.
        logReconciliationDowngrade("reconcileContradictedVerdicts", auditId, c.id, null);
      })
    );
  }

  /**
   * D026 §17 — symmetric counterpart to reconcileContradictedVerdicts: a claim correctly
   * `contradicted` before this tier can flip to `supported`/`partially_supported` off a noisier
   * wider pool, and nothing else re-checks a flip AWAY from `contradicted`. Same one-shot classifier,
   * same downgrade-only-to-`unsupported` convention (never reverts to the stale prior verdict —
   * that's just trusting an equally-unconfirmed answer instead of this round's unconfirmed one).
   */
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
        await this.grounnelStore.writeClaimResult(auditId, c.id, { status: "done", verdict: "unsupported", evidence: null, confidence: c.confidence, reason: c.reason, sources: c.sources, citations: [] });
        await this.historyStore.createClaim({ claimId: c.id, runId: auditId, claimText: c.text, verdict: "unsupported", evidence: null, confidence: c.confidence, reason: c.reason, sources: c.sources, status: "done" });
        this.gateEventStore.recordGateEvents(auditId, c.id, [
          { gate: "retry_reconciliation", verdictBefore, verdictAfter: "unsupported", overridden: true, reason: "escalation_reversal_invalidated" },
        ]);
        logger.info({ module: MODULE, operation: "guardEscalatedContradictionReversals", auditId, claimId: c.id }, "Escalation's flip away from a prior contradicted verdict failed reason-consistency — downgraded to unsupported");
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
    // context (D023 §6) is additive/optional on SearchProvider.search — only HybridSearchProvider
    // reads it, to attribute grounnel_search_calls rows to this real run/claim. forceFallback lets
    // a caller exercise the Tavily path on demand (searchEngine request param), instead of gambling
    // on whether Gemini's grounding search happens to return only unfetchable URLs.
    // Reviewed finding (D026 §8) — the full claim sentence, NOT a keyword rewrite: HybridSearchProvider's
    // DIY path embeds this in "check this claim: ..." for Gemini's own grounding search, which needs a
    // real claim, not keywords. The keyword rewrite (buildSearchQuery, T046) is scoped to the Tavily
    // fallback call specifically, inside hybrid-provider.ts, where it's a real search-API query string.
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

    // D026 §6/§11/§18 — check every already-fetched source (ranked by T048), pooling up to
    // MAX_VERIFY_PASSAGES relevant ones instead of stopping at the first — a claim's fact can
    // span more than one page. rerankPassages augments T048's lexical order with a semantic score;
    // it falls back to gate #4's lexical filter itself on error, so no separate fallback needed here.
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

  /**
   * D026 §18, real live-test finding: a claim about Nauru's population let a Vatican City page
   * through gate #4 (isPassageRelevant, lexical presence only) because that page mentioned Nauru
   * once in a comparison list while actually being about Vatican City. Lexical presence can't tell
   * "about X" from "mentions X in passing" — this asks the model to score exactly that, per
   * candidate, in one batched call. Augments T048's existing lexical order (hybrid-provider.ts's
   * rankByRelevance already ran before `sources` reached here) rather than replacing it: each
   * candidate's array position becomes a normalized lexical score, averaged with the LLM's score.
   * Fails open to gate #4's lexical filter alone on any error — same convention as
   * checkReasonVerdictConsistency (D025 §2): a broken signal degrades to the old behavior, it never
   * blocks the claim.
   */
  private async rerankPassages(auditId: string, claim: PipelineClaimInput, sources: SearchPassage[]): Promise<SearchPassage[]> {
    // Nothing to rank with at most one candidate — same fallback either way, skip the call entirely.
    if (sources.length <= 1) {
      return sources.filter((s) => isPassageRelevant(claim.text, s.text!));
    }

    const labeled = sources.map((s, i) => ({ label: String.fromCharCode(65 + i), source: s }));
    try {
      // D026 §20 — reviewed finding: a blind character-prefix excerpt captured mostly nav chrome
      // on long pages (Wikipedia's own "Jump to content / Main menu" before any real text). Select
      // by relevance instead — the same claim-key-term sentence scoring VERIFY's own passage
      // pooling uses — bounded by sentence count, never by character position.
      const candidates = labeled.map(({ label, source }) => ({
        id: label,
        title: source.title,
        excerpt: buildPassageSentences(claim.text, source.text ?? "")
          .map((s) => s.text)
          .join(" "),
      }));
      const system = this.prompts.render("grounnel-passage-rerank", {
        claim: claim.text,
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
      // D026 §19 — "selected" mirrors resolveEvidence's own MAX_VERIFY_PASSAGES slice on whatever
      // this method returns; kept in sync here since this is the one place that owns the sort order.
      this.rerankDecisionStore.recordRerankDecisions(
        auditId,
        claim.id,
        ranked.map((r, i) => ({ url: r.source.url, lexicalScore: r.lexicalScore, llmScore: r.llmScore, combinedScore: r.combined, selected: i < MAX_VERIFY_PASSAGES }))
      );
      return ranked.map((s) => s.source);
    } catch (err) {
      // Reviewed finding: unlike every other Gemini call site in this file, a RateLimitError here
      // doesn't stop other in-flight claims from also hitting the same wall — fixing that needs a
      // per-run signal threaded through resolveAllEvidence's AND escalateUnresolved's wave loops,
      // not proportionate to the cost (fail-open still degrades correctly; RateLimitError isn't
      // retried internally, so this is one wasted attempt per already-in-flight claim, not a storm).
      // Tagged distinctly here so it's at least observable rather than silently identical to any
      // other failure.
      logger.warn(
        { module: MODULE, operation: "rerankPassages", auditId, claimId: claim.id, rateLimited: err instanceof RateLimitError, err },
        "Passage reranking failed — falling back to lexical order + gate #4's relevance filter"
      );
      return sources.filter((s) => isPassageRelevant(claim.text, s.text!));
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

  /** The 9-gate chain (grew from 5; see the gateEvents.push calls below for the current list), extracted so T034/T035's retry pass can re-run it against a fresh VERIFY result without duplicating the logic. */
  private runGateChain(input: {
    verdict: Verdict;
    reason: string | null;
    evidence: string | null;
    claimText: string;
    passageText: string;
    // Threaded in so this function stays pure/sync/no I/O — see D025 §2 for what feeds this.
    reasonSupportsVerdict: boolean | null;
  }): { verdict: Verdict; evidence: string | null; gateEvents: GateEventInput[]; diagnostics: Diagnostic[]; needsRetry: boolean } {
    let verdict = input.verdict;
    const gateEvents: GateEventInput[] = [];
    const diagnostics: Diagnostic[] = [];

    // Reason-consistency gate — the model's own reason overriding a verdict that contradicts it
    // (2026-08-06 live-eval findings: g04/g05). Runs before gate #1 so a flip to `contradicted`
    // still has to clear gate #1's real evidence-substring check, not bypass it.
    const reasonConsistency = applyReasonConsistencyGate({ verdict, reason: input.reason });
    gateEvents.push({ gate: "reason_consistency", verdictBefore: verdict, verdictAfter: reasonConsistency.verdict, overridden: reasonConsistency.overridden, reason: reasonConsistency.reason });
    verdict = reasonConsistency.verdict;

    // Case A gate (D022 §4) — bare "X, not Y" negation, the gap applyReasonConsistencyGate
    // names but doesn't catch (g05). Also runs before gate #1 — a flip still needs real evidence.
    const implicitNegation = applyImplicitNegationGate({
      verdict,
      reason: input.reason,
      claimText: input.claimText,
      passageText: input.passageText,
    });
    gateEvents.push({ gate: "implicit_negation", verdictBefore: verdict, verdictAfter: implicitNegation.verdict, overridden: implicitNegation.overridden, reason: implicitNegation.reason });
    verdict = implicitNegation.verdict;

    // Reason/verdict year-mismatch gate (tasks.md Phase 36/T069) — checks the model's own `reason`
    // for a differing, associated year instead of scanning raw evidence (applyYearGate's
    // ROLE_KEYWORDS whitelist proved unable to keep up with unbounded phrasing). Grouped with the
    // other reason-only gates, before gate #1, same rationale as reasonConsistency/implicitNegation.
    const reasonYear = applyReasonYearGate({ verdict, reason: input.reason, claimText: input.claimText });
    gateEvents.push({ gate: "reason_year", verdictBefore: verdict, verdictAfter: reasonYear.verdict, overridden: reasonYear.overridden, reason: reasonYear.reason });
    verdict = reasonYear.verdict;

    // Reason/verdict ordinal-mismatch gate (D030, tasks.md T005) — same rationale and chain
    // position as reasonYear directly above: reads VERIFY's own `reason` for a differing,
    // anchored ordinal instead of scanning raw evidence (the deleted applyOrdinalGate's
    // ROLE_KEYWORDS approach, proven unable to keep up with unbounded phrasing, same as the year
    // gate's own whitelist). Grouped with the other reason-only gates, before gate #1.
    const reasonOrdinal = applyReasonOrdinalGate({ verdict, reason: input.reason, claimText: input.claimText });
    gateEvents.push({ gate: "reason_ordinal", verdictBefore: verdict, verdictAfter: reasonOrdinal.verdict, overridden: reasonOrdinal.overridden, reason: reasonOrdinal.reason });
    verdict = reasonOrdinal.verdict;

    // Gate #5 (D025 §2/§3) — chain position (between implicit_negation and gate #1) is load-bearing, see ADR.
    const counterfact = applyCounterfactIgnoredGate({ verdict, reasonSupportsVerdict: input.reasonSupportsVerdict });
    // overridden is always false here — this gate never changes verdict, only flags (D025 §2).
    // Reviewed finding: unlike gates #1-4, "reason" can be non-null with overridden:false — querying
    // this gate's activity needs `gate = 'counterfact_ignored' AND reason IS NOT NULL`, not `overridden = true`.
    gateEvents.push({ gate: "counterfact_ignored", verdictBefore: verdict, verdictAfter: verdict, overridden: false, reason: counterfact.reason });
    if (counterfact.flagged) {
      diagnostics.push({ code: "counterfact_ignored", severity: "ERROR", details: "The model's own reason did not appear to support the verdict it gave for this claim." });
    }

    // Captured right before gate #1 — reviewed finding: needsRetry (below) checking only
    // reasonConsistency.overridden missed a claim that arrived ALREADY "contradicted" straight from
    // VERIFY (no flip needed) but with the same missing-evidence self-inconsistency as the flipped case.
    const verdictBeforeGate1 = verdict;

    // Gate #1 — never reaches the store without passing this (D019 §2, T003, tasks.md acceptance).
    const gate1 = applyContradictionEvidenceGate({ verdict, evidence: input.evidence, passageText: input.passageText });
    gateEvents.push({ gate: "contradiction_evidence", verdictBefore: verdict, verdictAfter: gate1.verdict, overridden: gate1.overridden, reason: gate1.reason });
    verdict = gate1.verdict;
    let evidence = gate1.evidence;

    // T034 (real live-eval finding, g04) — verdict was "contradicted" going into gate #1 (whether the
    // raw VERIFY output already said so, or a gate flipped it) but gate #1 found no real evidence.
    // Reviewed finding: details phrased generically, not "verdict was contradicted" — the
    // reconciliation prompt shows the model its RAW pre-gate verdict (D025 §2), which may say
    // "unsupported" if a gate did the flipping internally; asserting "was contradicted" there
    // would contradict what the model is shown as its own previous answer.
    if (verdictBeforeGate1 === "contradicted" && (gate1.reason === "evidence_null" || gate1.reason === "evidence_not_grounded")) {
      diagnostics.push({
        code: gate1.reason,
        severity: "ERROR",
        details:
          gate1.reason === "evidence_null"
            ? "A contradiction was indicated but no evidence quote was given."
            : "A contradiction was indicated but the evidence quote wasn't found verbatim in the passage.",
      });
    }

    // Gate #1b (D026 §12) — cross-claim contamination backstop: a batched VERIFY call can answer one
    // claim's id with a DIFFERENT claim's reasoning while still citing real (but topically unrelated)
    // evidence, which gate #1 alone can't catch since the evidence really is grounded. A single-claim
    // retry structurally can't suffer this (nothing else in that request to cross-wire with), so this
    // also gets an ERROR diagnostic — same retry path as gate #1's own downgrade.
    const gate1b = applyClaimReasonOverlapGate({ verdict, reason: input.reason, claimText: input.claimText });
    gateEvents.push({ gate: "claim_reason_overlap", verdictBefore: verdict, verdictAfter: gate1b.verdict, overridden: gate1b.overridden, reason: gate1b.reason });
    verdict = gate1b.verdict;
    if (gate1b.overridden) {
      evidence = null; // stale — it was only meaningful attached to the discarded contradicted verdict.
      diagnostics.push({ code: "claim_reason_no_overlap", severity: "ERROR", details: "The model's reason for this contradiction shares no key terms with the claim itself — likely cross-claim contamination in a batched VERIFY call." });
    }

    // Gate #2 — numeric normalization/comparison in code (D019 §2, T004).
    const gate2 = applyNumericGate({ claimText: input.claimText, verdict, evidence });
    gateEvents.push({ gate: "numeric", verdictBefore: verdict, verdictAfter: gate2.verdict, overridden: gate2.overridden, reason: gate2.reason });
    verdict = gate2.verdict;

    // Gate #2b — year/date comparison, disjoint token class from gate #2 (dates vs $/%), so order
    // relative to it doesn't matter. Real live-run finding: a wrong-year claim ("died in 1948" vs
    // evidence "1895–1958") was graded supported since gate #2's extractNumericFact never
    // recognizes bare years at all.
    const gate2b = applyYearGate({ claimText: input.claimText, verdict, evidence });
    gateEvents.push({ gate: "year", verdictBefore: verdict, verdictAfter: gate2b.verdict, overridden: gate2b.overridden, reason: gate2b.reason });
    verdict = gate2b.verdict;

    // D025 §2 — retry fires on any ERROR-severity diagnostic; today that's every diagnostic this
    // chain produces, but the field exists so a future WARNING/INFO-only gate doesn't force a retry.
    const needsRetry = diagnostics.some((d) => d.severity === "ERROR");

    return { verdict, evidence, gateEvents, diagnostics, needsRetry };
  }

  /** Reviewed finding: shared by callVerify and checkReasonVerdictConsistency — both had near-identical
   * callLlmForJson invocations (expectedKeys/attempts/module/isValid/onComplete), the same drift risk
   * callVerify was originally extracted to prevent (T034), now recurring one level up. */
  private async callGrounnelJson<T extends { results: unknown[] }>(
    auditId: string,
    system: string,
    user: string,
    schema: ZodSchema<T>,
    operation: string,
    callType: "primary" | "consistency_retry" | "consistency_check" | "fill_in" | "passage_rerank",
    promptVersion: string,
    // Reviewed finding: real production case — a scraped page's "You are now subscribed" boilerplate,
    // quoted verbatim as VERIFY's `evidence`, false-positived the injection guard for a whole batch.
    quotedFields: string[] = [],
    // D026 §19 — only ever set by a caller that's genuinely single-claim; a batched call (primary
    // VERIFY, multi-claim consistency_check) passes undefined rather than picking one arbitrarily.
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
      // repair.ts nulls out a field it can't salvage rather than throwing (D018 §5.15) — without
      // this, a null `results` sails past callLlmForJson and crashes .map() below, uncaught.
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
    // D026 §6 — deliberately no source_url: it's a page-identity memory cue the model doesn't need.
    // D026 §11 — up to MAX_VERIFY_PASSAGES texts, already rank-ordered (label assignment depends on it).
    pairs: Array<{ id: string; claim: string; passages: Array<{ text: string }> }>,
    operation: string,
    callType: "primary" | "consistency_retry" | "fill_in",
    verifyVersion: string,
    // D025 §2 — the reconciliation retry needs a dynamic message (previous answer + diagnostics),
    // not the primary call's fixed trigger phrase. Same `grounnel-verify` system prompt either way.
    user: string = "Return the JSON now."
  ): Promise<{ results: VerifyProcessedResult[] }> {
    // D026 §7/§11 — each pooled passage becomes a source-labeled, numbered subset of its own
    // sentences; the model cites {source, n}, never generates a quote.
    const sentencesByClaim = new Map<string, Record<string, PassageSentence[]>>(
      pairs.map((p) => [p.id, buildPassageSentencesMulti(p.claim, p.passages.map((passage, i) => ({ label: passageLabelForIndex(i), text: passage.text })))])
    );
    const renderedPairs = pairs.map((p) => ({ id: p.id, claim: p.claim, passage_sentences: sentencesByClaim.get(p.id) ?? {} }));
    // Telemetry (reviewed finding) — lets a later recall check distinguish "pooling didn't help"
    // from "few passages were ever pooled." Log line, not a new DB column.
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
    // No quotedFields needed here (unlike the pre-T043 free-text evidence field): the raw response
    // only ever contains citations, so there's no scraped-text-in-output case left to blank.
    // D026 §19 — a single-claim call (retryVerifyClaim) attributes claimId; a batch (runBatch's
    // primary call) can't, so it stays undefined rather than picking one of the batch arbitrarily.
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
    const pairs = [{ id: item.claim.id, claim: item.claim.text, passages: item.passages.map((p) => ({ text: p.text! })) }];
    const user = this.buildReconciliationUser(previous, diagnostics);
    try {
      const parsed = await this.callVerify(auditId, pairs, "retryVerifyClaim", "consistency_retry", verifyVersion, user);
      return parsed.results.find((r) => r.id === item.claim.id) ?? null;
    } catch (err) {
      // Reviewed finding: propagate, don't swallow — runBatch's primary call stops the whole run
      // early on a rate limit; a retry hitting the same limit needs the same fail-fast treatment,
      // not a silent fallback to the degraded result while every other claim keeps hammering Gemini.
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
    // D026 §19 — same convention as callVerify: single-item batch attributes claimId, a real
    // multi-claim batch stays undefined.
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
      // Reviewed finding: schema-valid but empty is indistinguishable from "the model ignored every
      // candidate" — worth a log line, unlike a genuine failure (caught below), since callLlmForJson's
      // isValid only checks Array.isArray, not that every requested id got answered.
      if (parsed.results.length === 0) {
        logger.warn({ module: MODULE, operation: "checkReasonVerdictConsistency", auditId, requested: items.length }, "Consistency check returned zero results for a non-empty candidate batch");
      }
      return new Map(parsed.results.map((r) => [r.id, r.consistent]));
    } catch (err) {
      logger.warn({ module: MODULE, operation: "checkReasonVerdictConsistency", auditId, err }, "Consistency check failed — skipping this batch's reconciliation check, gate #1 still covers evidence-groundedness");
      return new Map();
    }
  }

  /**
   * D025 §5 addendum — the reconciliation retry's own output was otherwise the least-scrutinized
   * path capable of a false accusation (real live-test finding: a retry flipped to `contradicted`
   * by conflating two sub-facts of a compound claim). Re-runs the same §2 classifier, single-claim,
   * only when the retry lands on `contradicted` — the one verdict where being wrong costs more than
   * a false miss. A `false` downgrades straight to `unsupported` (never `unverifiable` — the claim
   * wasn't unverifiable, the contradiction just failed validation) with no second retry.
   */
  private async checkRetryContradiction(
    auditId: string,
    item: ResolvedWithPassage,
    chain: { verdict: Verdict; evidence: string | null; gateEvents: GateEventInput[] },
    // Reviewed finding — telemetry attribution must scan only THIS pass's own gate events, not
    // chain.gateEvents (firstPass ++ retryPass): the concatenated trail can surface a stale flip a
    // discarded earlier pass already made, misattributing the current contradiction to the wrong gate.
    currentPassGateEvents: GateEventInput[],
    reason: string | null,
    previousEvidence: string | null,
    previousReason: string | null
  ): Promise<{ verdict: Verdict; evidence: string | null; gateEvents: GateEventInput[] }> {
    if (chain.verdict !== "contradicted") return chain;

    const consistencyMap = await this.checkReasonVerdictConsistency(auditId, [
      { id: item.claim.id, claim: item.claim.text, reason, verdict: chain.verdict },
    ]);
    // Fail-open on a classifier error, same convention as D025 §2's own catch-and-skip.
    const consistent = consistencyMap.get(item.claim.id) ?? true;

    // Logged only, not gated on yet (D025 §5 addendum) — a same-evidence-new-label or
    // near-identical-reasoning-different-verdict retry smells like relabeling, not re-reasoning.
    const evidenceChanged = (chain.evidence ?? "").trim() !== (previousEvidence ?? "").trim();
    const previousTerms = extractKeyTerms(previousReason ?? "");
    const reasonSimilarity = previousTerms.length > 0 ? scoreKeyTermMatches(previousTerms, reason ?? "") / previousTerms.length : null;
    logger.info(
      { module: MODULE, operation: "checkRetryContradiction", auditId, claimId: item.claim.id, consistent, evidenceChanged, reasonSimilarity },
      "Retry landed on contradicted — logged reconciliation-quality signals"
    );

    // Reconciliation-disagreement telemetry (D030 T010 backlog, 2026-08-19 — see tasks.md for why).
    if (!consistent) {
      logReconciliationDowngrade("checkRetryContradiction", auditId, item.claim.id, originatingContradictionGate(currentPassGateEvents));
    }

    const gateEvent: GateEventInput = {
      gate: "retry_reconciliation",
      verdictBefore: chain.verdict,
      verdictAfter: consistent ? chain.verdict : "unsupported",
      overridden: !consistent,
      reason: consistent ? null : "retry_contradiction_invalidated",
    };
    if (consistent) {
      return { ...chain, gateEvents: [...chain.gateEvents, gateEvent] };
    }
    return { verdict: "unsupported", evidence: null, gateEvents: [...chain.gateEvents, gateEvent] };
  }

  /**
   * Runs the gate chain + T034 retry + persistence for one VERIFY response against `items` — shared
   * by runBatch's primary pass and its fill-in pass (D026 §8, T045), so a fill-in claim gets exactly
   * the same treatment (gates, consistency classifier, one retry) as a normally-answered one, not a
   * cut-down path. Mutates `answeredIds`/`retryState` (shared across both passes by the caller).
   */
  private async processVerifyResults(
    auditId: string,
    items: ResolvedWithPassage[],
    parsed: { results: VerifyProcessedResult[] },
    verifyVersion: string,
    retryState: { rateLimit: RateLimitError | null },
    answeredIds: Set<string>
  ): Promise<void> {
    const byId = new Map(items.map((b) => [b.claim.id, b]));

    // Live-verification finding (D030 T010, tasks.md backlog) — a batched VERIFY response can
    // answer the same claim id twice; unguarded, both ran the full gate chain concurrently and
    // raced to persist the same claim's final result (last write silently won, no error/log).
    // Scoped to byId first — an id VERIFY invented that isn't part of this batch at all shouldn't
    // count as a "duplicate answer" for a real claim, just discarded junk like any other unknown id.
    const seenIds = new Set<string>();
    const duplicateIds: string[] = [];
    // Reviewed finding: initialVerdict (the value the gate chain actually operates on, e.g.
    // confidence-downgraded to "unverifiable") must be computed once here, before the classifier
    // call — the classifier was previously judging the raw pre-downgrade verdict while gate #5
    // applied its answer to a different, already-downgraded one.
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
    const consistencyCandidates = knownResults.filter((k) => k.initialVerdict !== "contradicted");
    const consistencyMap = await this.checkReasonVerdictConsistency(
      auditId,
      consistencyCandidates.map((k) => ({ id: k.result.id, claim: byId.get(k.result.id)!.claim.text, reason: k.result.reason, verdict: k.initialVerdict }))
    );

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

        const firstPass = this.runGateChain({
          verdict: initialVerdict,
          reason,
          evidence: result.evidence,
          claimText: item.claim.text,
          passageText,
          reasonSupportsVerdict: consistencyMap.get(result.id) ?? null,
        });
        let chain = firstPass;

        // T034/D025 — a self-inconsistent VERIFY output (evidence-groundedness gate #1, or the new
        // reason/verdict classifier) gets one retry before the degraded result stands.
        if (firstPass.needsRetry) {
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
            const retryPass = this.runGateChain({
              verdict: retryVerdict,
              reason,
              evidence: retried.evidence,
              claimText: item.claim.text,
              passageText,
              reasonSupportsVerdict: null,
            });
            // Reviewed finding: concatenate, don't replace — the original self-inconsistent pass
            // (the override that triggered this retry) stays in the audit trail, not just the retry's.
            chain = { ...retryPass, gateEvents: [...firstPass.gateEvents, ...retryPass.gateEvents] };
            // D025 §5 addendum — the retry itself gets one bounded check when it lands on `contradicted`.
            chain = { ...chain, ...(await this.checkRetryContradiction(auditId, item, chain, retryPass.gateEvents, reason, result.evidence, result.reason)) };
          }
        }

        const { verdict, evidence, gateEvents } = chain;
        const sources = toClaimSources(item.sources);
        // D027 §2 — citations survive iff the evidence they back survived the gate chain.
        const citations = evidence !== null ? attachCitationUrls(citationsBeforeGates, item.passages) : [];
        const result_: ClaimResult = { status: "done", verdict, evidence, confidence, reason, sources, citations };
        await this.grounnelStore.writeClaimResult(auditId, item.claim.id, result_);
        // D027 §4 — deliberately no `citations` here: historyStore's Postgres row doesn't carry it (out of scope for this change).
        await this.historyStore.createClaim({
          claimId: item.claim.id,
          runId: auditId,
          claimText: item.claim.text,
          verdict,
          evidence,
          confidence,
          reason,
          sources,
          status: "done",
        });
        // Buffered until here, flushed only after the claim row above — grounnel_gate_events.claimId
        // has a real FK, and gates finish before that row exists (D023 §5/T027).
        this.gateEventStore.recordGateEvents(auditId, item.claim.id, gateEvents);
      })
    );
  }

  /** Returns the RateLimitError if this batch stopped because Gemini itself is rate-limited — the caller uses this to stop early, not just degrade this one batch. */
  private async runBatch(auditId: string, batch: ResolvedWithPassage[]): Promise<RateLimitError | null> {
    const pairs = batch.map((b) => ({ id: b.claim.id, claim: b.claim.text, passages: b.passages.map((p) => ({ text: p.text! })) }));
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
    // Set by a claim's retry hitting the same rate limit runBatch's own primary call already
    // special-cases — checked after each processVerifyResults pass so it stops remaining batches
    // the same way (below). An object, not a bare `let`: TS doesn't narrow a closure's mutation of
    // an outer `let` across an `await`, so `if (retryRateLimit)` would otherwise wrongly narrow to `never`.
    const retryState: { rateLimit: RateLimitError | null } = { rateLimit: null };

    await this.processVerifyResults(auditId, batch, parsed, verifyVersion, retryState, answeredIds);

    if (retryState.rateLimit) {
      logger.error({ module: MODULE, operation: "runBatch", auditId, limitType: retryState.rateLimit.limitType }, "Gemini rate-limited during a T034 retry — stopping remaining batches");
      return retryState.rateLimit;
    }

    // D026 §8 (T045) — response completion: never trust a batch answered every claim it was asked.
    // Diff requested vs. answered ids, unconditionally, and fire exactly one fill-in call for
    // whatever's missing (never the whole batch again — a small, targeted follow-up).
    let missing = batch.filter((b) => !answeredIds.has(b.claim.id));
    if (missing.length > 0) {
      logger.warn(
        { module: MODULE, operation: "runBatch", auditId, missingIds: missing.map((m) => m.claim.id) },
        "VERIFY response omitted some claims — firing a fill-in retry for exactly those"
      );
      const fillInPairs = missing.map((b) => ({ id: b.claim.id, claim: b.claim.text, passages: b.passages.map((p) => ({ text: p.text! })) }));
      try {
        const fillIn = await this.callVerify(auditId, fillInPairs, "runBatch.fillIn", "fill_in", verifyVersion);
        await this.processVerifyResults(auditId, missing, fillIn, verifyVersion, retryState, answeredIds);
        // Cast, not a plain read — the earlier check above narrowed retryState.rateLimit to null,
        // and TS carries that narrowing across the mutating processVerifyResults() call, so an
        // unannotated re-read here type-checks as `never` even with an explicit variable annotation.
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

    // D026 §22/T064 — every fresh `contradicted` verdict this batch produced (primary pass or
    // fill-in) gets the same reason-consistency scrutiny D025 §5 already gives retries and D026 §13
    // already gave escalation rounds — see reconcileContradictedVerdicts' own doc comment for why
    // this was a real gap, not just a hardening pass. Covers escalation too since it calls runBatch.
    await this.reconcileContradictedVerdicts(
      auditId,
      batch.map((b) => b.claim)
    );

    return null;
  }
}
