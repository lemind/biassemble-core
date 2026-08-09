import { z } from "zod";
import { waitUntil } from "@vercel/functions";
import { logger } from "../../observability/logger.js";
import { callLlmForJson } from "../llm-json-call.js";
import { isPassageRelevant } from "./passage-filter.js";
import { applyContradictionEvidenceGate, applyImplicitNegationGate, applyNumericGate, applyReasonConsistencyGate } from "./gates.js";
import { RateLimitError } from "../../providers/gemini.js";
import { env } from "../../lib/env.js";
import { GrounnelVerdictEnum, type ClaimResult, type ClaimSource } from "../../contracts/grounnel.schemas.js";
import type { Provider } from "../../providers/types.js";
import type { PromptRegistry } from "../../prompts/registry.js";
import type { GrounnelStore } from "../../persistence/grounnel-store.js";
import type { GrounnelHistoryStore } from "../../persistence/grounnel-history-store.js";
import type { GrounnelLlmCallStore } from "../../persistence/grounnel-llm-call-store.js";
import type { GrounnelGateEventStore, GateEventInput } from "../../persistence/grounnel-gate-event-store.js";
import type { SearchProvider, SearchPassage } from "../../providers/search/search-provider.js";

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
  return sources.map((s) => ({ kind: "web" as const, title: s.title, domain: s.domain, url: s.url, status: s.status, retrievalMethod: s.retrievalMethod }));
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
    private readonly gateEventStore: GrounnelGateEventStore
  ) {}

  async run(auditId: string, claims: PipelineClaimInput[], searchEngine: "defaultFlow" | "tavily" = "defaultFlow"): Promise<void> {
    try {
      const resolved = await this.resolveAllEvidence(auditId, claims, searchEngine);

      const noEvidence = resolved.filter((r) => !hasPassage(r));
      await Promise.all(noEvidence.map((r) => this.writeNoEvidence(auditId, r)));

      const needsVerify = resolved.filter(hasPassage);
      for (let i = 0; i < needsVerify.length; i += BATCH_MAX) {
        const batch = needsVerify.slice(i, i + BATCH_MAX);
        const geminiRateLimit = await this.runBatch(auditId, batch);
        if (geminiRateLimit) {
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
          resolved.push(...remaining.map((claim) => ({ claim, passage: null, sources: [rateLimitedSource] })));
        }
        break;
      }
    }
    return resolved;
  }

  private async resolveEvidence(auditId: string, claim: PipelineClaimInput, searchEngine: "defaultFlow" | "tavily"): Promise<ResolvedEvidence> {
    // context (D023 §6) is additive/optional on SearchProvider.search — only HybridSearchProvider
    // reads it, to attribute grounnel_search_calls rows to this real run/claim. forceFallback lets
    // a caller exercise the Tavily path on demand (searchEngine request param), instead of gambling
    // on whether Gemini's grounding search happens to return only unfetchable URLs.
    const sources = await this.searchProvider.search(claim.text, {
      runId: auditId,
      claimId: claim.id,
      searchFlow: searchEngine,
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

  /** The 4-gate chain, extracted so T034's retry pass can re-run it against a fresh VERIFY result without duplicating the logic. */
  private runGateChain(input: {
    verdict: Verdict;
    reason: string | null;
    evidence: string | null;
    claimText: string;
    passageText: string;
  }): { verdict: Verdict; evidence: string | null; gateEvents: GateEventInput[]; needsRetry: boolean } {
    let verdict = input.verdict;
    const gateEvents: GateEventInput[] = [];

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

    // Captured right before gate #1 — reviewed finding: needsRetry (below) checking only
    // reasonConsistency.overridden missed a claim that arrived ALREADY "contradicted" straight from
    // VERIFY (no flip needed) but with the same missing-evidence self-inconsistency as the flipped case.
    const verdictBeforeGate1 = verdict;

    // Gate #1 — never reaches the store without passing this (D019 §2, T003, tasks.md acceptance).
    const gate1 = applyContradictionEvidenceGate({ verdict, evidence: input.evidence, passageText: input.passageText });
    gateEvents.push({ gate: "contradiction_evidence", verdictBefore: verdict, verdictAfter: gate1.verdict, overridden: gate1.overridden, reason: gate1.reason });
    verdict = gate1.verdict;
    const evidence = gate1.evidence;

    // Gate #2 — numeric normalization/comparison in code (D019 §2, T004).
    const gate2 = applyNumericGate({ claimText: input.claimText, verdict, evidence });
    gateEvents.push({ gate: "numeric", verdictBefore: verdict, verdictAfter: gate2.verdict, overridden: gate2.overridden, reason: gate2.reason });
    verdict = gate2.verdict;

    // T034 (real live-eval finding, g04) — verdict was "contradicted" going into gate #1 (whether the
    // raw VERIFY output already said so, or a gate flipped it) but gate #1 found no real evidence.
    const needsRetry = verdictBeforeGate1 === "contradicted" && (gate1.reason === "evidence_null" || gate1.reason === "evidence_not_grounded");

    return { verdict, evidence, gateEvents, needsRetry };
  }

  /** Shared by runBatch's primary call and retryVerifyClaim's single-claim call — reviewed finding: these two were near-duplicated inline before, risking drift if the call shape ever changes. */
  private async callVerify(
    auditId: string,
    pairs: Array<{ id: string; claim: string; passage: string | null; source_url: string }>,
    operation: string,
    callType: "primary" | "consistency_retry",
    verifyVersion: string
  ): Promise<z.infer<typeof VerifyResponseSchema>> {
    const system = this.prompts.render("grounnel-verify", {
      claim_passage_pairs: JSON.stringify(pairs),
      threshold: String(CONFIDENCE_THRESHOLD),
    });
    return callLlmForJson({
      provider: this.provider,
      system,
      user: "Return the JSON now.",
      schema: VerifyResponseSchema,
      expectedKeys: ["results"],
      attempts: VERIFY_ATTEMPTS,
      module: MODULE,
      operation,
      // repair.ts nulls out a field it can't salvage rather than throwing (D018 §5.15) — without
      // this, a null `results` sails past callLlmForJson and crashes .map() below, uncaught.
      isValid: (result) => Array.isArray(result.results),
      onComplete: this.llmCallStore.recordCall({
        runId: auditId,
        stage: "verify",
        callType,
        provider: this.provider.mode,
        model: env.GEMINI_MODEL,
        promptVersion: verifyVersion,
      }),
    });
  }

  /** T034 — one bounded retry for a single claim, fired only when runGateChain flags a self-inconsistent VERIFY output. Never blocks the batch: a retry failure just keeps the original (already gate-processed) result. */
  private async retryVerifyClaim(
    auditId: string,
    item: ResolvedWithPassage,
    verifyVersion: string
  ): Promise<z.infer<typeof VerifyResultSchema> | RateLimitError | null> {
    const pairs = [{ id: item.claim.id, claim: item.claim.text, passage: item.passage.text, source_url: item.passage.url }];
    try {
      const parsed = await this.callVerify(auditId, pairs, "retryVerifyClaim", "consistency_retry", verifyVersion);
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

  /** Returns the RateLimitError if this batch stopped because Gemini itself is rate-limited — the caller uses this to stop early, not just degrade this one batch. */
  private async runBatch(auditId: string, batch: ResolvedWithPassage[]): Promise<RateLimitError | null> {
    const pairs = batch.map((b) => ({ id: b.claim.id, claim: b.claim.text, passage: b.passage.text, source_url: b.passage.url }));
    const verifyVersion = this.prompts.getGrounnelVerifyVersion();
    // Best-effort (D023 §7) — every batch stamps the same value; cheap and idempotent, simpler
    // than tracking "already stamped" across an arbitrary number of batches for one run.
    waitUntil(this.historyStore.updateRun(auditId, { promptVersionVerify: verifyVersion }));

    let parsed: z.infer<typeof VerifyResponseSchema>;
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

    const byId = new Map(batch.map((b) => [b.claim.id, b]));
    const answeredIds = new Set<string>();
    // Set by a claim's retry hitting the same rate limit runBatch's own primary call already
    // special-cases — checked after Promise.all so it stops remaining batches the same way (below).
    // An object, not a bare `let`: TS doesn't narrow a closure's mutation of an outer `let` across
    // an `await`, so `if (retryRateLimit)` below would otherwise wrongly type-narrow to `never`.
    const retryState: { rateLimit: RateLimitError | null } = { rateLimit: null };
    await Promise.all(
      parsed.results.map(async (result) => {
        const item = byId.get(result.id);
        if (!item) return; // model echoed an id we didn't send — ignore, don't persist (matches audit's own precedent)
        answeredIds.add(item.claim.id);

        let reason = result.reason;
        let confidence = result.confidence;
        const initialVerdict = confidence < CONFIDENCE_THRESHOLD && result.verdict !== "unverifiable" ? "unverifiable" : result.verdict;

        const firstPass = this.runGateChain({ verdict: initialVerdict, reason, evidence: result.evidence, claimText: item.claim.text, passageText: item.passage.text! });
        let chain = firstPass;

        // T034 — a self-inconsistent VERIFY output (reason narrates a contradiction, but gate #1
        // found no real evidence backing the flip) gets one retry before the degraded result stands.
        if (firstPass.needsRetry) {
          const retried = await this.retryVerifyClaim(auditId, item, verifyVersion);
          if (retried instanceof RateLimitError) {
            retryState.rateLimit = retried;
          } else if (retried) {
            reason = retried.reason;
            confidence = retried.confidence;
            const retryVerdict = confidence < CONFIDENCE_THRESHOLD && retried.verdict !== "unverifiable" ? "unverifiable" : retried.verdict;
            const retryPass = this.runGateChain({ verdict: retryVerdict, reason, evidence: retried.evidence, claimText: item.claim.text, passageText: item.passage.text! });
            // Reviewed finding: concatenate, don't replace — the original self-inconsistent pass
            // (the override that triggered this retry) stays in the audit trail, not just the retry's.
            chain = { ...retryPass, gateEvents: [...firstPass.gateEvents, ...retryPass.gateEvents] };
          }
        }

        const { verdict, evidence, gateEvents } = chain;
        const sources = toClaimSources(item.sources);
        const result_: ClaimResult = { status: "done", verdict, evidence, confidence, reason, sources };
        await this.grounnelStore.writeClaimResult(auditId, item.claim.id, result_);
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

    if (retryState.rateLimit) {
      logger.error({ module: MODULE, operation: "runBatch", auditId, limitType: retryState.rateLimit.limitType }, "Gemini rate-limited during a T034 retry — stopping remaining batches");
      return retryState.rateLimit;
    }

    const missing = batch.filter((b) => !answeredIds.has(b.claim.id));
    if (missing.length > 0) {
      logger.warn(
        { module: MODULE, operation: "runBatch", auditId, missingIds: missing.map((m) => m.claim.id) },
        "VERIFY response omitted some claims in this batch — degrading them to not_checked"
      );
      await this.degradeBatch(auditId, missing, "VERIFY's response omitted this claim from its batch — not a provider/parse error, the model simply didn't answer for it.");
    }
    return null;
  }
}
