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
import { inngest } from "./client.js";
import { GeminiProvider } from "../providers/gemini.js";
import { PromptRegistry } from "../prompts/registry.js";
import { HybridSearchProvider } from "../providers/search/hybrid-provider.js";
import { TavilySearchProvider } from "../providers/search/tavily-provider.js";
import { DrizzleGrounnelSearchCallStore } from "../persistence/grounnel-search-call-store.js";
import { normalizeRepeats, runGrounnelEvalOnce, scoreGrounnelEvalCase, summarizeGrounnelEvalCases, type GoldenCase } from "../evaluation/run-grounnel-eval.js";
import type { GrounnelRun } from "../evaluation/grounnel-live-gate.js";
import { env } from "../lib/env.js";
import { logger } from "../observability/logger.js";

const MODULE = "eval-grounnel-run";

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
    const repeats = normalizeRepeats(event.data?.repeats ?? 1);
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

    const cases = [];
    for (const goldenCase of selected) {
      const runs: GrounnelRun[] = [];
      const errors: string[] = [];
      for (let i = 0; i < repeats; i++) {
        try {
          runs.push(
            await step.run(`case-${goldenCase.id}-run-${i + 1}`, () =>
              runGrounnelEvalOnce({ provider, prompts, searchProvider }, goldenCase)
            )
          );
        } catch (err) {
          // One repetition failing must not abandon the case — the remaining repetitions still
          // carry signal, and a partial case is reported as partial rather than silently passing.
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
      cases.push(scoreGrounnelEvalCase(goldenCase, runs, errors, minCorrectRateOverride, repeats));
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
        passed: summary.passed,
        repeats,
        correctRate: summary.totalMatched === 0 ? null : summary.totalCorrect / summary.totalMatched,
        totalMatched: summary.totalMatched,
        falseAccusations: summary.totalFalseAccusations,
        safetyOk: summary.cases.every((c) => c.safetyOk),
        detection,
        userFacingReasons,
      },
      summary.passed ? "Grounnel live eval passed" : "Grounnel live eval failed"
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

    if (!summary.passed) {
      const failed = compact.filter((c) => !c.ok);
      throw new Error(
        `Grounnel live eval failed (${summary.totalCorrect}/${summary.totalMatched} correct, ` +
          `${summary.totalFalseAccusations} false accusations, repeats=${repeats}):\n${JSON.stringify(failed, null, 2)}`
      );
    }

    return { ...summary, cases: compact };
  }
);
