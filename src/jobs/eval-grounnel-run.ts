/**
 * Inngest eval job — real Gemini + Tavily live gate for Grounnel. Manual trigger only, no cron/CI
 * wiring — matches eval-reflection.ts's "real eval before prompt changes, never automatic" policy.
 *
 * Trigger: event "eval/grounnel-run" (scripts/trigger-eval-grounnel.ts sends it)
 * D019 §4 reopened by D023 — run-grounnel-eval.ts wires the real Postgres history/llm-call/
 * search-call stores (source: "eval", D023 §3) so these runs are tagged, not silently mixed into
 * production analytics; Inngest's own step output remains the primary way to inspect a given run.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NonRetriableError } from "inngest";
import { inngest } from "./client.js";
import { GeminiProvider, RateLimitError } from "../providers/gemini.js";
import { PromptRegistry } from "../prompts/registry.js";
import { HybridSearchProvider } from "../providers/search/hybrid-provider.js";
import { TavilySearchProvider } from "../providers/search/tavily-provider.js";
import { DrizzleGrounnelSearchCallStore } from "../persistence/grounnel-search-call-store.js";
import { normalizeRepeats, runGrounnelEvalOnce, scoreGrounnelEvalCase, summarizeGrounnelEvalCases, type GoldenCase } from "../evaluation/run-grounnel-eval.js";
import { MIN_VERDICT_REPETITIONS } from "../evaluation/grounnel-live-gate.js";
import type { GrounnelRun } from "../evaluation/grounnel-live-gate.js";
import { env } from "../lib/env.js";
import { logger } from "../observability/logger.js";

const MODULE = "eval-grounnel-run";
/** Thrown-error text only. Inngest serialises step errors, so `instanceof RateLimitError` is gone by then. */
const RATE_LIMIT_RE = /too many requests|rate.?limit|quota|usage limit|credits are depleted|spend(ing)? cap/i;
/** Neither an empty balance nor a hit spend cap clears on its own — say so, don't say "re-run later". */
const BILLING_RE = /credits are depleted|spend(ing)? cap/i;
/** Two could be a transient RPM blip; three in a row is the daily cap, which won't clear mid-run. */
const RATE_LIMIT_ABORT_AFTER = 3;

/** Screen every case once, then re-run only the failures. A 60%-detection case is caught 8.7% of
 * the time by one N=5 pass and 92% by five N=1 screens costing the same — D030 §3m Addendum 13. */
const SCREEN_REPEATS = 1;
const ESCALATION_REPEATS = 5;
/** Above this, simultaneous failures are one cause, not N regressions — and 22 escalations costs
 * more than the flat N=5 pass it replaces, so escalating past this point is strictly worse. */
const MAX_ESCALATED_CASES = 8;
// Exact degraded strings the pipeline substitutes for a verdict (pipeline-helpers.ts, pipeline.service.ts).
// Deliberately NOT the loose regex above: an article about fishing quotas would false-abort on "quota".
const DEGRADED_MARKERS = ["hit today's AI usage limit", "being rate-limited right now", "search provider's rate limit was reached"];

/** A run that "succeeded" but whose claims carry rate-limit text instead of verdicts — junk to score. */
function runIsRateLimited(run: GrounnelRun): boolean {
  return run.claims.length > 0 && run.claims.every((c) => DEGRADED_MARKERS.some((m) => (c.reason ?? "").includes(m)));
}

export const evalGrounnelRunJob = inngest.createFunction(
  { id: "eval-grounnel-run", name: "Eval — Grounnel Live Gate" },
  { event: "eval/grounnel-run" },
  async ({ event, step }) => {
    if (!env.TAVILY_API_KEY) {
      throw new Error("TAVILY_API_KEY is not set — required for a real Grounnel eval run.");
    }

    const golden: { cases: GoldenCase[] } = await step.run("load-golden-set", async () => {
      // Same dual-path resolution as eval-run.ts: local dev vs. pnpm build's bundled api/ layout.
      const currentDir = dirname(fileURLToPath(import.meta.url));
      const vercelEvalDir = join(currentDir, "evaluations");
      const localEvalDir = join(currentDir, "..", "..", "evaluations");
      const evalRoot = existsSync(vercelEvalDir) ? vercelEvalDir : localEvalDir;
      const path = join(evalRoot, "golden", "grounnel", "live-eval-golden-set.json");
      return JSON.parse(readFileSync(path, "utf-8"));
    });

    const minCorrectRateOverride: number | undefined = event.data?.minCorrectRate;
    // D030 §3k — this pipeline is stochastic; one repetition is a draw, not a verdict. `repeats`
    // controls N. `caseIds` runs a subset, because one N=5 pass over all 19 cases costs roughly a
    // full day of Gemini daily quota (~1130 calls) — see the ADR's cost table.
    // Explicit `repeats` keeps the flat behaviour (needed to measure a rate deliberately); the
    // default is now screen-then-escalate, which costs ~3x less for a strictly better catch rate.
    const twoPhase = event.data?.repeats === undefined;
    const repeats = normalizeRepeats(event.data?.repeats ?? SCREEN_REPEATS);
    const phase1Repeats = twoPhase ? SCREEN_REPEATS : repeats;
    const caseIds: string[] | undefined = event.data?.caseIds;
    const selected = caseIds?.length ? golden.cases.filter((c) => caseIds.includes(c.id)) : golden.cases;
    if (selected.length === 0) {
      throw new Error(`No golden cases matched caseIds=${JSON.stringify(caseIds)}`);
    }
    logger.info({ module: MODULE, cases: selected.length, repeats }, "Starting Grounnel live eval run");

    // One step per (case, repetition), not one per case — a transient failure in repetition 4
    // shouldn't force Inngest to re-run (and re-spend real API quota on) repetitions 1..3 that
    // already succeeded; step.run's own memoization skips whatever already completed on retry.
    // Scoring is a separate pure step for the same reason: it must never re-trigger the network.
    const provider = new GeminiProvider();
    const prompts = new PromptRegistry();
    const tavilyProvider = new TavilySearchProvider(env.TAVILY_API_KEY);
    const searchProvider = new HybridSearchProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL, tavilyProvider, new DrizzleGrounnelSearchCallStore());

    // A rate-limited quota doesn't recover inside one run, so grinding through the remaining
    // repetitions just burns wall-clock producing failures — abort and report what completed.
    let consecutiveRateLimited = 0;
    let abortedAfter: string | null = null;
    let abortWasBilling = false;

    /** One step per (case, repetition, phase) — a transient failure in repetition 4 must not make
     * Inngest re-spend quota on 1..3, and the phase tag keeps screen and escalation steps distinct. */
    const runCase = async (goldenCase: GoldenCase, n: number, phase: string) => {
      const runs: GrounnelRun[] = [];
      const errors: string[] = [];
      for (let i = 0; i < n; i++) {
        try {
          const run = await step.run(`${phase}-${goldenCase.id}-run-${i + 1}`, async () => {
            try {
              return await runGrounnelEvalOnce({ provider, prompts, searchProvider }, goldenCase);
            } catch (err) {
              // Inside the step the class survives (outside it, Inngest has serialised it to text —
              // hence RATE_LIMIT_RE below). A 429 fails again immediately, so don't spend 4 retries
              // and their backoff discovering that.
              if (err instanceof RateLimitError) throw new NonRetriableError(err.message, { cause: err });
              throw err;
            }
          });
          runs.push(run);
          // A degraded run "succeeds" with rate-limit text in place of verdicts — scoring that as a
          // real result is worse than failing, so it counts toward the abort too (D026 §17).
          consecutiveRateLimited = runIsRateLimited(run) ? consecutiveRateLimited + 1 : 0;
        } catch (err) {
          // One repetition failing must not abandon the case — the remaining repetitions still
          // carry signal, and a partial case is reported as partial rather than silently passing.
          const message = err instanceof Error ? err.message : String(err);
          errors.push(message);
          // Inngest serialises step errors, so the RateLimitError class is gone by here — match text.
          consecutiveRateLimited = RATE_LIMIT_RE.test(message) ? consecutiveRateLimited + 1 : 0;
          if (BILLING_RE.test(message)) abortWasBilling = true;
        }
        if (consecutiveRateLimited >= RATE_LIMIT_ABORT_AFTER) {
          abortedAfter = `${goldenCase.id} run ${i + 1}`;
          break;
        }
      }
      return { runs, errors };
    };

    let cases = [];
    for (const goldenCase of selected) {
      if (abortedAfter) break;
      const { runs, errors } = await runCase(goldenCase, phase1Repeats, twoPhase ? "screen" : "case");
      cases.push(scoreGrounnelEvalCase(goldenCase, runs, errors, minCorrectRateOverride, phase1Repeats));
    }

    // Phase 2 — confirm only what the screen flagged, and only what is worth confirming.
    let escalated: string[] = [];
    let systemicFailure: number | null = null;
    if (twoPhase && !abortedAfter) {
      // A false accusation at N=1 is already conclusive (the run happened, the accusation is real),
      // so it fails outright. Only detection is rate-shaped and needs confirming. An errored or
      // rate-limited case is an infrastructure fact, not a quality signal — never re-spend on it.
      const candidates = cases.filter(
        (c) => !c.ok && c.falseAccusations === 0 && (c.errors?.length ?? 0) === 0 && c.runs > 0
      );
      if (candidates.length > MAX_ESCALATED_CASES) {
        systemicFailure = candidates.length;
        logger.warn(
          { module: MODULE, screenFailures: candidates.length, cap: MAX_ESCALATED_CASES },
          "Screen failed on too many cases at once — one cause, not N regressions; escalation skipped"
        );
      } else {
        for (const c of candidates) {
          if (abortedAfter) break;
          const goldenCase = selected.find((g) => g.id === c.id)!;
          const { runs, errors } = await runCase(goldenCase, ESCALATION_REPEATS, "escalate");
          if (runs.length === 0) continue; // keep the screen result rather than overwrite it with nothing
          // Scored on the FRESH runs only: the screen run was selected BECAUSE it failed, so pooling
          // it in guarantees one failed observation and biases the rate down.
          const rescored = scoreGrounnelEvalCase(goldenCase, runs, errors, minCorrectRateOverride, ESCALATION_REPEATS);
          cases = cases.map((x) => (x.id === c.id ? rescored : x));
          escalated.push(c.id);
        }
      }
    }
    const summary = summarizeGrounnelEvalCases(cases);

    // Per-case detection distributions — the whole point of repeating. A case at 2/5 and a case at
    // 5/5 both used to print as "ok"; that is what let g17 sit at ~39% while reporting green.
    const detection = summary.cases
      .filter((c) => c.claims.some((cl) => cl.kind === "false"))
      .map((c) => ({
        id: c.id,
        detectionRate: c.detectionRate,
        runs: c.runs,
        verdicts: Object.fromEntries(c.claims.filter((cl) => cl.kind === "false").map((cl) => [cl.match, cl.verdicts])),
      }));

    // Postgres keeps VERIFY's RAW reason (D023 §7/T18), so user-facing text survives nowhere else. Bounded — see ADR.
    const REASON_BEARING_VERDICTS = new Set(["unverifiable", "unsupported", "excluded"]);
    const userFacingReasons = summary.cases
      .flatMap((c) =>
        c.runDetails.flatMap((r) =>
          r.claims
            .filter((cl) => cl.verdict && REASON_BEARING_VERDICTS.has(cl.verdict) && cl.reason)
            .map((cl) => ({ caseId: c.id, runId: r.id, verdict: cl.verdict, reason: cl.reason!.slice(0, 300) }))
        )
      )
      .slice(0, 40);

    logger.info(
      {
        module: MODULE,
        // `bindingPassed` is the headline and the gate; `passed` alone called coin flips a green suite.
        bindingPassed: summary.bindingPassed,
        verdictIsBinding: summary.verdictIsBinding,
        bindingFailures: summary.bindingFailures,
        incompleteCases: summary.incompleteCases,
        passed: summary.passed,
        repeats,
        mode: twoPhase ? "screen+escalate" : "flat",
        escalated,
        systemicFailure,
        correctRate: summary.totalMatched === 0 ? null : summary.totalCorrect / summary.totalMatched,
        totalMatched: summary.totalMatched,
        falseAccusations: summary.totalFalseAccusations,
        safetyOk: summary.cases.every((c) => c.safetyOk),
        detection,
        userFacingReasons,
      },
      systemicFailure !== null
        ? `Grounnel live eval SYSTEMIC — ${systemicFailure} of ${selected.length} cases failed the screen at once (cap ${MAX_ESCALATED_CASES}); escalation skipped, this is one cause not ${systemicFailure} regressions`
        : summary.bindingPassed && !summary.verdictIsBinding
        ? `Grounnel live eval INDICATIVE ONLY — no binding failure, but ${summary.cases.filter((c) => !c.verdictIsBinding).length} case(s) lacked the observations to be a verdict (repeats=${repeats}, need ${MIN_VERDICT_REPETITIONS})`
        : summary.bindingPassed
          ? "Grounnel live eval passed"
          : "Grounnel live eval failed"
    );

    // Inngest's run status (green/red) reflects only whether this handler threw, not what it
    // returned — without this, a real failure (e.g. below_correct_rate) still shows green.
    // Full failed-case detail (claims/reasons/verdicts/violations) is embedded in the thrown
    // message itself, not just referenced — step.run output isn't always where this gets read
    // from (e.g. Vercel/Inngest error capture only shows the thrown message).
    // At N>1 the full per-repetition claim dump is far too large for an Inngest step output / error
    // message, so it is replaced by the run ids — the claims themselves are already in Postgres
    // (`grounnel.grounnel_claims` by `run_id`, source "eval"), which is where Stage 2 reads them.
    // Caveat (T18): that `reason` is RAW, not user-facing — read `userFacingReasons` logged above.
    const compact = summary.cases.map(({ runDetails, run: _run, ...rest }) => ({
      ...rest,
      runIds: runDetails.map((r) => r.id).filter(Boolean),
    }));

    // An abort is an INFRASTRUCTURE failure, not a quality one — say so first, so a rate-limited
    // run is never mistaken for a regression. Partial scores are still reported, never silently passed.
    if (systemicFailure !== null) {
      // NonRetriableError for the same reason as the abort below: re-running 4 times cannot fix a
      // cause that is broken for every case at once, it just re-spends the screen's quota.
      throw new NonRetriableError(
        `Grounnel live eval SYSTEMIC FAILURE — ${systemicFailure} of ${selected.length} cases failed the screen ` +
          `(cap ${MAX_ESCALATED_CASES}). Escalation was skipped deliberately: simultaneous failures on this many cases ` +
          `are one cause (bad deploy, degraded retrieval, prompt mismatch), not ${systemicFailure} independent regressions. ` +
          `Fix the cause and re-run the screen — do NOT read these as ${systemicFailure} separate case regressions.` +
          `\n${JSON.stringify(compact, null, 2)}`
      );
    }

    if (abortedAfter) {
      // NonRetriableError, not Error: this function has Inngest's default 4 retries, and a FAILED
      // step is not memoized — a plain throw would re-run the rate-limited cases up to 4 more times.
      throw new NonRetriableError(
        `Grounnel live eval ABORTED at ${abortedAfter} — ${RATE_LIMIT_ABORT_AFTER} consecutive rate-limited runs. ` +
          `Scored ${cases.length}/${selected.length} cases before stopping; these numbers are PARTIAL and not a regression signal. ` +
          (abortWasBilling
            ? "CAUSE: AI provider credits are depleted — waiting will NOT fix this, top up the account balance."
            : "Re-run on fresh quota.") +
          `\n${JSON.stringify(compact, null, 2)}`
      );
    }

    // `bindingPassed` already means: no false accusation (hard at any N), no case that both had the
    // observations and failed, no partial case. Per case, never suite-wide — D030 §3m Addendum 9.
    if (!summary.bindingPassed) {
      const failed = compact.filter((c) => !c.ok);
      throw new Error(
        `Grounnel live eval failed (${summary.totalCorrect}/${summary.totalMatched} correct, ` +
          `${summary.totalFalseAccusations} false accusations, repeats=${repeats}):\n${JSON.stringify(failed, null, 2)}`
      );
    }

    return { ...summary, cases: compact };
  }
);
