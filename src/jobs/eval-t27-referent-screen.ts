/**
 * Experiment job — spec 013 T27 Step 1: does `hasResolvableReferent` exclude contentless claims
 * without excluding near-misses? Asymmetric bar and fixture rationale: tasks.md T27, D032 §13.
 *
 * Trigger: event "eval/t27-referent-screen" (scripts/trigger-eval-t27.ts sends it)
 */
import { randomUUID } from "node:crypto";
import { inngest } from "./client.js";
import { GeminiProvider } from "../providers/gemini.js";
import { PromptRegistry } from "../prompts/registry.js";
import { DrizzleGrounnelHistoryStore } from "../persistence/grounnel-history-store.js";
import { DrizzleGrounnelLlmCallStore } from "../persistence/grounnel-llm-call-store.js";
import { classifyClaimVerifiability, isEligibilityExcluded } from "../orchestrators/grounnel/claim-eligibility.js";
import { logger } from "../observability/logger.js";

const MODULE = "eval-t27-referent-screen";
// Same detection as T25's job — the fail-open result is shape-identical to a genuine
// checkable/uncertain classification, so a rate-limited run would otherwise report a clean summary.
const FAIL_OPEN_REASON = "Eligibility classification unavailable — failed open to search.";

type Expectation = "exclude" | "keep";
// `role` groups fixtures for scoring; `expect` is only the per-fixture exclusion outcome. A drift
// control expects exclusion but must NOT count toward the contentless screening bar. tasks.md T27.
type Role = "contentless" | "near-miss" | "drift-control";

interface Fixture {
  id: string;
  claimText: string;
  sourceExcerpt: string | null;
  role: Role;
  expect: Expectation;
  why: string;
}

// CONTENTLESS must exclude (T25's exact texts, so the runs compare); NEAR-MISS must not, and is
// resolvable from what the classifier actually receives — claim + sourceExcerpt. tasks.md T27.
const FIXTURES: Fixture[] = [
  { id: "x1-person-died-in-a-year", claimText: "A person really did die in a particular year.", sourceExcerpt: "A person really did die in a particular year.", role: "contentless", expect: "exclude", why: "D032 §12 Finding C — the exact live failure; excerpt repeats the claim and resolves nothing" },
  { id: "x2-someone-won-an-award", claimText: "Someone won an award at some point.", sourceExcerpt: null, role: "contentless", expect: "exclude", why: "common-noun subject, no referent" },
  { id: "x3-city-had-a-disaster", claimText: "A city experienced a natural disaster once.", sourceExcerpt: null, role: "contentless", expect: "exclude", why: "common-noun subject, no referent" },
  { id: "x4-animal-was-discovered", claimText: "An animal was discovered by scientists.", sourceExcerpt: null, role: "contentless", expect: "exclude", why: "common-noun subject, no referent" },
  { id: "x5-company-reported-profit", claimText: "A company reported a profit at some point.", sourceExcerpt: null, role: "contentless", expect: "exclude", why: "common-noun subject, no referent" },

  { id: "n1-referent-in-claim", claimText: "Apple's iPad revenue was $6.2 billion in the fourth quarter.", sourceExcerpt: null, role: "near-miss", expect: "keep", why: "referent named in the claim itself" },
  { id: "n2-named-class-superlative", claimText: "The Wright brothers' first flight covered approximately 120 feet.", sourceExcerpt: null, role: "near-miss", expect: "keep", why: "named-class superlative, referent in claim" },
  { id: "n3-excerpt-resolves-subject", claimText: "The company reported a profit in Q4.", sourceExcerpt: "Shopify closed out a strong year. The company reported a profit in Q4, its third consecutive profitable quarter.", role: "near-miss", expect: "keep", why: "pronoun-ish subject the EXCERPT resolves — the case a naive rule would wrongly kill" },
  { id: "n4-opinion", claimText: "SQL is more useful than NoSQL for most applications.", sourceExcerpt: null, role: "drift-control", expect: "exclude", why: "drift control — opinion/clear was ALREADY excluded pre-T27 by D030 §3b; check the joint mix, not the count" },
  { id: "n5-prediction", claimText: "AI would eliminate most programming jobs within five years.", sourceExcerpt: null, role: "drift-control", expect: "exclude", why: "drift control — prediction/clear was ALREADY excluded pre-T27 by D030 §3b; check the joint mix, not the count" },
];

export const evalT27ReferentScreenJob = inngest.createFunction(
  { id: "eval-t27-referent-screen", name: "Experiment — T27 Resolvable-Referent Screen" },
  { event: "eval/t27-referent-screen" },
  async ({ event, step }) => {
    const repeats = Math.max(1, Math.min(10, Number(event.data?.repeats ?? 10)));
    const provider = new GeminiProvider();
    const prompts = new PromptRegistry();
    const historyStore = new DrizzleGrounnelHistoryStore();
    const llmCallStore = new DrizzleGrounnelLlmCallStore();

    // Ids minted INSIDE the step — a randomUUID() above it churns per Inngest replay and dangles the
    // grounnel_llm_calls FK. Cost a silent 0-row T27 run, 2026-08-31; see tasks.md T27.
    const { experimentRunId, claimIds } = await step.run("create-experiment-run", async () => {
      const runId = randomUUID();
      await historyStore.createRun({
        runId,
        sessionId: null,
        text: `[t27-referent-screen] ${FIXTURES.length} fixtures x ${repeats}`,
        source: "eval",
        maxClaims: FIXTURES.length,
        truncated: false,
      });
      const ids: Record<string, string> = {};
      for (const f of FIXTURES) ids[f.id] = randomUUID();
      return { experimentRunId: runId, claimIds: ids };
    });

    logger.info({ module: MODULE, fixtures: FIXTURES.length, repeats, promptVersion: prompts.getGrounnelEligibilityVersion() }, "Starting T27 referent screen");

    const perFixture = [];
    for (const fixture of FIXTURES) {
      const claimId = claimIds[fixture.id]!;
      const results = [];
      for (let i = 0; i < repeats; i++) {
        const result = await step.run(`${fixture.id}-run-${i + 1}`, async () => {
          return await classifyClaimVerifiability(provider, prompts, llmCallStore, experimentRunId, claimId, {
            claimText: fixture.claimText,
            sourceExcerpt: fixture.sourceExcerpt,
          });
        });
        results.push(result);
      }

      const jointMix: Record<string, number> = {};
      let excludedCount = 0;
      let referentFalseCount = 0;
      let failOpenCount = 0;
      for (const r of results) {
        // Joint, not two independent tallies — the review asked for category x certainty against a
        // frozen baseline, which a pair of marginals cannot reconstruct.
        const joint = `${r.category}/${r.certainty}`;
        jointMix[joint] = (jointMix[joint] ?? 0) + 1;
        if (isEligibilityExcluded(r)) excludedCount++;
        if (r.hasResolvableReferent === false) referentFalseCount++;
        if (r.reason === FAIL_OPEN_REASON) failOpenCount++;
      }
      if (failOpenCount > 0) {
        logger.warn({ module: MODULE, fixtureId: fixture.id, failOpenCount, repeats }, "Some repeats fell back to fail-open (provider error) — this fixture's counts are contaminated");
      }

      // A near-miss that got excluded is the dangerous direction; surface it loudly, not as a number
      // buried in a summary object.
      const falseExclusions = fixture.expect === "keep" ? excludedCount : 0;
      if (falseExclusions > 0) {
        logger.error({ module: MODULE, fixtureId: fixture.id, falseExclusions, repeats, why: fixture.why }, "FALSE EXCLUSION — a claim that must stay checkable was excluded; T27's hard gate is violated");
      }

      perFixture.push({
        id: fixture.id,
        role: fixture.role,
        expect: fixture.expect,
        why: fixture.why,
        claimText: fixture.claimText,
        jointMix,
        excludedCount,
        referentFalseCount,
        failOpenCount,
        falseExclusions,
        sampleReasons: results.slice(0, 2).map((r) => r.reason),
      });
    }

    // Grouped by role, not expect — drift controls also expect exclusion but are not contentless
    // claims, so counting them would inflate the screening-bar denominator. tasks.md T27.
    const contentless = perFixture.filter((f) => f.role === "contentless");
    const nearMiss = perFixture.filter((f) => f.role === "near-miss");
    const totalFalseExclusions = nearMiss.reduce((sum, f) => sum + f.falseExclusions, 0);
    const contentlessExcluded = contentless.reduce((sum, f) => sum + f.excludedCount, 0);
    const contentlessTotal = contentless.length * repeats;
    // Drift controls must keep landing on the SAME joint cell they did pre-T27 (opinion/clear,
    // prediction/clear) — a shifted cell means the new field perturbed the old axis.
    const driftControlJoint = Object.fromEntries(perFixture.filter((f) => f.role === "drift-control").map((f) => [f.id, f.jointMix]));

    const verdict =
      totalFalseExclusions > 0
        ? "FAIL — hard gate violated: a near-miss claim was excluded"
        : contentlessExcluded / contentlessTotal >= 0.9
          ? "PASS — 0 false exclusions and >=90% contentless exclusion"
          : "INCONCLUSIVE — 0 false exclusions, but contentless exclusion below the 90% screening bar";

    const summary = {
      promptVersion: prompts.getGrounnelEligibilityVersion(),
      repeats,
      totalFalseExclusions,
      contentlessExcluded,
      contentlessTotal,
      contentlessExcludedRate: contentlessExcluded / contentlessTotal,
      driftControlJoint,
      verdict,
    };
    logger.info({ module: MODULE, summary, perFixture }, "T27 referent screen complete");

    return { summary, perFixture };
  }
);
