/**
 * Inngest eval job — spec 013 T22: VERIFY verdict/reason field-order A/B. Manual trigger only,
 * matches eval-grounnel-run.ts's "real eval, never automatic" policy.
 *
 * Design (specs/013-grounnel-d032-remediation/tasks.md T22, "generate fixtures live"): run real
 * EXTRACT + eligibility + search/rerank ONCE per golden case (fixture phase), snapshot the exact
 * {id, claim, subjectEntity} VERIFY would receive, then replay against both schema orders — current
 * (verdict-then-reason) and T22's candidate (reason-then-verdict, mirroring T21's fix) — at N
 * repeats. Zero reconstruction error for claim/subjectEntity (T21's own bake-off property); passage
 * TEXT is deliberately NOT carried as a step return value (see readSelectedPassages below) — a first
 * version did, and Inngest replays every prior step's return value on each new invocation, so full
 * passage text across dozens of steps blew past Vercel's request size limit (413, caught live before
 * any results existed). Passages are instead re-read from Postgres by (runId, claimId) inside each
 * VERIFY-replay step — the same rows resolveEvidenceForClaims already persists as a side effect via
 * grounnel_search_pages/grounnel_rerank_decisions, so nothing new is written, only read differently.
 *
 * Trigger: event "eval/t22-verify-order" (scripts/trigger-eval-t22.ts sends it)
 */
import { NonRetriableError } from "inngest";
import { inngest } from "./client.js";
import { GeminiProvider, RateLimitError } from "../providers/gemini.js";
import { PromptRegistry } from "../prompts/registry.js";
import { HybridSearchProvider } from "../providers/search/hybrid-provider.js";
import { TavilySearchProvider } from "../providers/search/tavily-provider.js";
import { DrizzleGrounnelSearchCallStore } from "../persistence/grounnel-search-call-store.js";
import { readSelectedPassages } from "../persistence/grounnel-rerank-decision-store.js";
import { callLlmForJson } from "../orchestrators/llm-json-call.js";
import { buildPassageSentencesMulti, resolveEvidenceFromCitations } from "../orchestrators/grounnel/passage-sentences.js";
import { passageLabelForIndex } from "../orchestrators/grounnel/pipeline-helpers.js";
import {
  VerifyRawResponseSchema,
  VerifyRawResponseReasonFirstSchema,
  ConsistencyCheckResponseSchema,
} from "../orchestrators/grounnel/pipeline-schemas.js";
import { resolveEvidenceOnce, normalizeRepeats, type GoldenCase } from "../evaluation/run-grounnel-eval.js";
import { evaluateGrounnelRun, type GrounnelRun, type LiveEvalSpec } from "../evaluation/grounnel-live-gate.js";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../lib/env.js";
import { logger } from "../observability/logger.js";

const MODULE = "eval-t22-verify-order";
const RATE_LIMIT_RE = /too many requests|rate.?limit|quota|usage limit|credits are depleted|spend(ing)? cap/i;
const BILLING_RE = /credits are depleted|spend(ing)? cap/i;
const RATE_LIMIT_ABORT_AFTER = 3;

type SchemaArm = "current_verdict_first" | "t22_reason_first";
const SCHEMAS: Record<SchemaArm, typeof VerifyRawResponseSchema> = {
  current_verdict_first: VerifyRawResponseSchema,
  t22_reason_first: VerifyRawResponseReasonFirstSchema as unknown as typeof VerifyRawResponseSchema,
};

/** Small — no passage text. This is what's allowed to cross an Inngest step boundary (see file header). */
interface FixtureClaim {
  id: string;
  claimText: string;
  subjectEntity: string;
}

interface RawVerifyResult {
  id: string;
  verdict: string;
  reason: string | null;
  confidence: number;
  evidenceCitations: Array<{ source: string; n: number }> | null;
}

/** One batched VERIFY call against a fixture's claims, using the given schema arm. Re-reads passage
 * text from Postgres per claim (see file header) rather than receiving it as a parameter — keeps
 * every step's own return value small; the DB round-trip is cheap next to the Gemini call itself.
 * No persistence of results — this is a standalone A/B, not production traffic. */
async function callVerifyRawArm(
  provider: GeminiProvider,
  prompts: PromptRegistry,
  runId: string,
  claims: FixtureClaim[],
  schema: typeof VerifyRawResponseSchema
): Promise<RawVerifyResult[]> {
  const passagesByClaim = new Map(await Promise.all(claims.map(async (c) => [c.id, await readSelectedPassages(runId, c.id)] as const)));
  const sentencesByClaim = new Map(
    claims.map((c) => [c.id, buildPassageSentencesMulti(c.claimText, (passagesByClaim.get(c.id) ?? []).map((p, i) => ({ label: passageLabelForIndex(i), text: p.text })))])
  );
  const renderedPairs = claims.map((c) => ({ id: c.id, claim: c.claimText, subject_entity: c.subjectEntity, passage_sentences: sentencesByClaim.get(c.id) ?? {} }));
  const system = prompts.render("grounnel-verify", { claim_passage_pairs: JSON.stringify(renderedPairs), threshold: String(0.6) });
  const claimId = claims.length === 1 ? claims[0]!.id : undefined;
  const raw = await callLlmForJson({
    provider,
    system,
    user: "Return the JSON now.",
    schema,
    // Top-level response key ({"results": [...]}), not the per-item fields — matches production's
    // own callVerify convention (pipeline.service.ts). BUG, caught after a full live run: this was
    // ["id","verdict","reason","confidence"] (per-item fields), which made hasUnrelatedKeySet's
    // top-level-key check see zero overlap with the ACTUAL top-level key ("results") on every single
    // call, unconditionally flagging every real response as injection-suspected and hard-rejecting
    // it — the run "succeeded" (no throw reached the job) but produced zero data in both arms.
    expectedKeys: ["results"],
    attempts: 3,
    module: MODULE,
    operation: "callVerifyRawArm",
    isValid: (result) => (result as { results: unknown[] }).results.length > 0,
  });
  return (raw as { results: RawVerifyResult[] }).results.map((r) => {
    const resolved = resolveEvidenceFromCitations(r.evidenceCitations, sentencesByClaim.get(r.id) ?? {});
    return { ...r, evidence: resolved.evidence } as RawVerifyResult & { evidence: string | null };
  });
}

/** Same classifier production's checkReasonVerdictConsistency uses (pipeline.service.ts), replicated
 * standalone here — no persistence needed, this is an A/B measurement, not a production call.
 * Returns a plain array, not a Map: this is called from inside step.run, and Inngest JSON-serializes
 * step return values for durability — a Map would silently collapse to `{}` and lose every result. */
async function checkConsistencyArm(
  provider: GeminiProvider,
  prompts: PromptRegistry,
  items: Array<{ id: string; claim: string; reason: string | null; verdict: string }>
): Promise<Array<{ id: string; consistent: boolean }>> {
  if (items.length === 0) return [];
  const pairs = items.map((i) => ({ id: i.id, claim: i.claim, reason: i.reason, verdict: i.verdict }));
  const system = prompts.render("grounnel-consistency-check", { reason_verdict_pairs: JSON.stringify(pairs) });
  const raw = await callLlmForJson({
    provider,
    system,
    user: "Return the JSON now.",
    schema: ConsistencyCheckResponseSchema,
    // Top-level key, same bug/fix as callVerifyRawArm above — see its comment.
    expectedKeys: ["results"],
    attempts: 3,
    module: MODULE,
    operation: "checkConsistencyArm",
    isValid: (result) => result.results.length > 0,
  });
  return raw.results.map((r) => ({ id: r.id, consistent: r.consistent }));
}

export const evalT22VerifyOrderJob = inngest.createFunction(
  { id: "eval-t22-verify-order", name: "Eval — T22 VERIFY verdict/reason field-order A/B" },
  { event: "eval/t22-verify-order" },
  async ({ event, step }) => {
    if (!env.TAVILY_API_KEY) {
      throw new Error("TAVILY_API_KEY is not set — required for real fixture generation.");
    }

    const golden: { cases: GoldenCase[] } = await step.run("load-golden-set", async () => {
      const currentDir = dirname(fileURLToPath(import.meta.url));
      const vercelEvalDir = join(currentDir, "evaluations");
      const localEvalDir = join(currentDir, "..", "..", "evaluations");
      const evalRoot = existsSync(vercelEvalDir) ? vercelEvalDir : localEvalDir;
      const path = join(evalRoot, "golden", "grounnel", "live-eval-golden-set.json");
      return JSON.parse(readFileSync(path, "utf-8"));
    });

    const repeats = normalizeRepeats(event.data?.repeats ?? 2);
    const caseIds: string[] | undefined = event.data?.caseIds;
    const selected = caseIds?.length ? golden.cases.filter((c) => caseIds.includes(c.id)) : golden.cases;
    if (selected.length === 0) {
      throw new Error(`No golden cases matched caseIds=${JSON.stringify(caseIds)}`);
    }
    logger.info({ module: MODULE, cases: selected.length, repeats }, "Starting T22 verdict/reason field-order A/B");

    const provider = new GeminiProvider();
    const prompts = new PromptRegistry();
    const tavilyProvider = new TavilySearchProvider(env.TAVILY_API_KEY);
    const searchProvider = new HybridSearchProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL, tavilyProvider, new DrizzleGrounnelSearchCallStore());

    // PHASE 1 — fixtures, one real EXTRACT + eligibility + search/rerank per case, paid ONCE.
    let consecutiveRateLimited = 0;
    let abortedAfter: string | null = null;
    let abortWasBilling = false;
    const fixtures: Array<{ goldenCase: GoldenCase; runId: string; claims: FixtureClaim[] }> = [];
    for (const goldenCase of selected) {
      if (abortedAfter) break;
      try {
        const result = await step.run(`fixture-${goldenCase.id}`, async () => {
          try {
            const resolved = await resolveEvidenceOnce({ provider, prompts, searchProvider }, goldenCase);
            // Trim to {id, claimText, subjectEntity} before returning — passage text is NOT
            // carried across the step boundary (file header: this is what caused the 413).
            // resolveEvidenceOnce's own call to resolveEvidenceForClaims already persisted the
            // passages to grounnel_search_pages/grounnel_rerank_decisions as a side effect.
            return { runId: resolved.runId, claims: resolved.claims.map((c) => ({ id: c.id, claimText: c.claimText, subjectEntity: c.subjectEntity })) };
          } catch (err) {
            if (err instanceof RateLimitError) throw new NonRetriableError(err.message, { cause: err });
            throw err;
          }
        });
        fixtures.push({ goldenCase, runId: result.runId, claims: result.claims });
        consecutiveRateLimited = 0;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ module: MODULE, operation: "fixtureGeneration", caseId: goldenCase.id, err: message }, "Fixture generation failed for this case — skipping it");
        consecutiveRateLimited = RATE_LIMIT_RE.test(message) ? consecutiveRateLimited + 1 : 0;
        if (BILLING_RE.test(message)) abortWasBilling = true;
        if (consecutiveRateLimited >= RATE_LIMIT_ABORT_AFTER) abortedAfter = `fixture-${goldenCase.id}`;
      }
    }
    if (abortedAfter) {
      throw new NonRetriableError(
        `T22 A/B ABORTED during fixture generation at ${abortedAfter}. Fixtures built for ${fixtures.length}/${selected.length} cases before stopping. ` +
          (abortWasBilling ? "CAUSE: AI provider credits are depleted." : "Re-run on fresh quota.")
      );
    }

    // PHASE 2 — A/B replay against each fixture, both schema arms, N repeats each. Fixtures are
    // reused unmodified across both arms — same claim/passage inputs, only schema order differs.
    // verdictById keyed by claim id — GrounnelRun.claims (grounnel-live-gate.ts) carries no id, only
    // text, and matching claims back to their id by text equality (as Phase 3 originally did) breaks
    // silently if a case ever has two claims with byte-identical text (review finding, fixed).
    type ArmRun = { armId: SchemaArm; caseId: string; repeat: number; run: GrounnelRun; rawReasons: Map<string, string | null>; verdictById: Map<string, string> };
    const armRuns: ArmRun[] = [];
    consecutiveRateLimited = 0;
    abortedAfter = null;
    for (const fixture of fixtures) {
      if (fixture.claims.length === 0 || abortedAfter) continue;
      for (const armId of Object.keys(SCHEMAS) as SchemaArm[]) {
        for (let rep = 0; rep < repeats; rep++) {
          if (abortedAfter) break;
          try {
            const results = await step.run(`verify-${fixture.goldenCase.id}-${armId}-${rep + 1}`, async () => {
              try {
                return await callVerifyRawArm(provider, prompts, fixture.runId, fixture.claims, SCHEMAS[armId]);
              } catch (err) {
                if (err instanceof RateLimitError) throw new NonRetriableError(err.message, { cause: err });
                throw err;
              }
            });
            const byId = new Map(fixture.claims.map((c) => [c.id, c.claimText]));
            const run: GrounnelRun = {
              id: `${fixture.goldenCase.id}-${armId}-${rep + 1}`,
              claims: results.map((r) => ({ text: byId.get(r.id) ?? "", verdict: r.verdict, status: "done", reason: r.reason })),
            };
            armRuns.push({
              armId,
              caseId: fixture.goldenCase.id,
              repeat: rep + 1,
              run,
              rawReasons: new Map(results.map((r) => [r.id, r.reason])),
              verdictById: new Map(results.map((r) => [r.id, r.verdict])),
            });
            consecutiveRateLimited = 0;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // Real bug caught live (2026-08-30): a non-rate-limit error here (e.g. the expectedKeys
            // bug that made every call injection-flagged) used to be swallowed with no log line at
            // all — the job "succeeded" with zero data and nothing said why. Always logged now.
            logger.warn({ module: MODULE, operation: "verifyReplay", caseId: fixture.goldenCase.id, armId, repeat: rep + 1, err: message }, "VERIFY replay step failed — skipping this repeat");
            consecutiveRateLimited = RATE_LIMIT_RE.test(message) ? consecutiveRateLimited + 1 : 0;
            if (BILLING_RE.test(message)) abortWasBilling = true;
            if (consecutiveRateLimited >= RATE_LIMIT_ABORT_AFTER) abortedAfter = `verify-${fixture.goldenCase.id}-${armId}-${rep + 1}`;
          }
        }
      }
    }
    if (abortedAfter) {
      throw new NonRetriableError(
        `T22 A/B ABORTED during VERIFY replay at ${abortedAfter}. ${armRuns.length} arm-runs completed before stopping — PARTIAL, not a regression signal. ` +
          (abortWasBilling ? "CAUSE: AI provider credits are depleted." : "Re-run on fresh quota.")
      );
    }
    // Sanity check (added after a real incident): the golden set always has claims, so zero arm-runs
    // means something is systemically broken (a bug in this job, not "no data to report") — throw
    // loudly instead of returning a hollow, all-zero "success" summary like the incident this fixes.
    if (armRuns.length === 0) {
      throw new Error(`T22 A/B produced ZERO arm-runs across ${fixtures.length} fixtures — a systemic bug, not a legitimate empty result. Check the warn logs above for the actual per-step error.`);
    }

    // PHASE 3 — reason/verdict consistency classification of both arms' own output (same classifier
    // production's counterfact_ignored gate uses), so the inconsistency rate is directly comparable
    // to the 7.32% production baseline (tasks.md T22 simulation).
    const consistencyByRun = new Map<string, Map<string, boolean>>();
    consecutiveRateLimited = 0;
    abortedAfter = null;
    for (const ar of armRuns) {
      if (abortedAfter) break;
      const fixture = fixtures.find((f) => f.goldenCase.id === ar.caseId)!;
      const items = fixture.claims.map((c) => ({ id: c.id, claim: c.claimText, reason: ar.rawReasons.get(c.id) ?? null, verdict: ar.verdictById.get(c.id) ?? "unsupported" }));
      try {
        const consistency = await step.run(`consistency-${ar.run.id}`, async () => {
          try {
            return await checkConsistencyArm(provider, prompts, items);
          } catch (err) {
            if (err instanceof RateLimitError) throw new NonRetriableError(err.message, { cause: err });
            throw err;
          }
        });
        consistencyByRun.set(ar.run.id!, new Map(consistency.map((c) => [c.id, c.consistent])));
        consecutiveRateLimited = 0;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ module: MODULE, operation: "consistencyCheck", runId: ar.run.id, err: message }, "Consistency-check step failed — this run's inconsistency readout will be partial");
        consecutiveRateLimited = RATE_LIMIT_RE.test(message) ? consecutiveRateLimited + 1 : 0;
        if (BILLING_RE.test(message)) abortWasBilling = true;
        if (consecutiveRateLimited >= RATE_LIMIT_ABORT_AFTER) abortedAfter = `consistency-${ar.run.id}`;
        // Consistency-check failure is non-fatal to the main A/B — just missing for this run's inconsistency readout.
      }
    }
    if (abortedAfter) {
      logger.warn({ module: MODULE, abortedAfter }, "T22 consistency-check phase rate-limited — inconsistency readout partial for remaining arm-runs");
    }

    // PHASE 4 — pure analysis, no network. Per arm: reason↔verdict inconsistency rate, verdict mix,
    // and the pre-registered safety check (evaluateGrounnelRun's own safetyOk/detectionRate/correctRate,
    // reused as-is — same scoring every other Grounnel eval in this spec uses, not reinvented here).
    function summarizeArm(armId: SchemaArm) {
      const runsForArm = armRuns.filter((ar) => ar.armId === armId);
      let totalClaims = 0;
      let inconsistent = 0;
      let inconsistencyMeasured = 0;
      const verdictMix: Record<string, number> = {};
      for (const ar of runsForArm) {
        for (const c of ar.run.claims) {
          totalClaims++;
          verdictMix[c.verdict ?? "null"] = (verdictMix[c.verdict ?? "null"] ?? 0) + 1;
        }
        const consistency = consistencyByRun.get(ar.run.id!);
        if (consistency) {
          for (const [, consistent] of consistency) {
            inconsistencyMeasured++;
            if (!consistent) inconsistent++;
          }
        }
      }
      // Per-case aggregate correctness/detection/safety, using the SAME scorer every other eval in
      // this spec uses — grouped by case id so repeats of the same case count as N runs of one spec.
      const byCase = new Map<string, GrounnelRun[]>();
      for (const ar of runsForArm) {
        const arr = byCase.get(ar.caseId) ?? [];
        arr.push(ar.run);
        byCase.set(ar.caseId, arr);
      }
      const perCase = [...byCase.entries()].map(([caseId, runs]) => {
        const goldenCase = fixtures.find((f) => f.goldenCase.id === caseId)!.goldenCase;
        const spec: LiveEvalSpec = { id: caseId, claims: goldenCase.claims, minCorrectRate: goldenCase.minCorrectRate, detectionFloor: goldenCase.detectionFloor };
        const result = evaluateGrounnelRun(runs, spec);
        return { caseId, safetyOk: result.safetyOk, correctRate: result.correctRate, detectionRate: result.detectionRate, matched: result.matched, correct: result.correct };
      });
      return {
        armId,
        totalClaims,
        inconsistencyRate: inconsistencyMeasured === 0 ? null : inconsistent / inconsistencyMeasured,
        inconsistencyMeasured,
        verdictMix,
        safetyOk: perCase.every((c) => c.safetyOk),
        falseAccusationCases: perCase.filter((c) => !c.safetyOk).map((c) => c.caseId),
        perCase,
      };
    }

    const summary = { current_verdict_first: summarizeArm("current_verdict_first"), t22_reason_first: summarizeArm("t22_reason_first") };

    logger.info({ module: MODULE, summary }, "T22 verdict/reason field-order A/B complete");

    return summary;
  }
);
