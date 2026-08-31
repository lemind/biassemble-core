/**
 * Experiment job — spec 013 T25: does the eligibility classifier already recognize a "contentless"
 * claim (grammatically well-formed, no resolvable subject/referent), or does it wave every one
 * through as `checkable`? D032 §12 Finding C: "A person really did die in a particular year" landed
 * `supported` off a celebrity-deaths listicle — a genuine unsafe affirmation under the Cardinal Rule.
 *
 * Design (tasks.md T25 C1/C2): classifyClaimVerifiability, N=5, on the exact failing claim plus a
 * few sibling contentless forms. Small and fixed, same shape as attribution-experiment.ts, not a
 * golden-set replay — no fixtures needed, classifyClaimVerifiability takes claim text directly.
 *
 * Trigger: event "eval/t25-contentless-eligibility" (scripts/trigger-eval-t25.ts sends it)
 */
import { randomUUID } from "node:crypto";
import { inngest } from "./client.js";
import { GeminiProvider } from "../providers/gemini.js";
import { PromptRegistry } from "../prompts/registry.js";
import { DrizzleGrounnelHistoryStore } from "../persistence/grounnel-history-store.js";
import { DrizzleGrounnelLlmCallStore } from "../persistence/grounnel-llm-call-store.js";
import { classifyClaimVerifiability, isEligibilityExcluded } from "../orchestrators/grounnel/claim-eligibility.js";
import { logger } from "../observability/logger.js";

const MODULE = "eval-t25-contentless-eligibility";
// Review finding, fixed: classifyClaimVerifiability's own fail-open result (claim-eligibility.ts's
// FAIL_OPEN_RESULT) is byte-identical in shape to a genuine {checkable, uncertain} classification —
// a rate-limited run would silently report the same categoryMix as a clean one. The individual
// provider-call failures ARE still recorded in grounnel_llm_calls, but not surfaced in this job's own
// summary, which is what an operator actually looks at. Detected by exact match on the fixed reason
// string that function returns on its catch path.
const FAIL_OPEN_REASON = "Eligibility classification unavailable — failed open to search.";

// C1 — the exact claim from D032 §12 Finding C. C2 — sibling contentless forms: grammatically
// well-formed, checkable-sounding, but no identifiable subject to actually check against.
const FIXTURES: Array<{ id: string; claimText: string }> = [
  { id: "c1-person-died-in-a-year", claimText: "A person really did die in a particular year." },
  { id: "c2-someone-won-an-award", claimText: "Someone won an award at some point." },
  { id: "c3-city-had-a-disaster", claimText: "A city experienced a natural disaster once." },
  { id: "c4-animal-was-discovered", claimText: "An animal was discovered by scientists." },
  { id: "c5-company-reported-profit", claimText: "A company reported a profit at some point." },
];

export const evalT25ContentlessEligibilityJob = inngest.createFunction(
  { id: "eval-t25-contentless-eligibility", name: "Experiment — Contentless-Claim Eligibility" },
  { event: "eval/t25-contentless-eligibility" },
  async ({ event, step }) => {
    const repeats = Math.max(1, Math.min(10, Number(event.data?.repeats ?? 5)));
    const provider = new GeminiProvider();
    const prompts = new PromptRegistry();
    const historyStore = new DrizzleGrounnelHistoryStore();
    const llmCallStore = new DrizzleGrounnelLlmCallStore();

    // Real grounnel_runs row required — grounnel_llm_calls.runId has a real FK (see schema.ts);
    // claimId does not, so a fresh uuid per fixture below is fine without its own row.
    const experimentRunId = randomUUID();
    await step.run("create-experiment-run", async () => {
      await historyStore.createRun({
        runId: experimentRunId,
        sessionId: null,
        text: `[t25-contentless-eligibility] ${FIXTURES.length} fixtures x ${repeats}`,
        source: "eval",
        maxClaims: FIXTURES.length,
        truncated: false,
      });
      return experimentRunId;
    });

    logger.info({ module: MODULE, fixtures: FIXTURES.length, repeats }, "Starting T25 contentless-claim eligibility experiment");

    const perFixture = [];
    for (const fixture of FIXTURES) {
      const claimId = randomUUID();
      const results = [];
      for (let i = 0; i < repeats; i++) {
        const result = await step.run(`${fixture.id}-run-${i + 1}`, async () => {
          return await classifyClaimVerifiability(provider, prompts, llmCallStore, experimentRunId, claimId, {
            claimText: fixture.claimText,
            sourceExcerpt: null,
          });
        });
        results.push(result);
      }
      const categoryMix: Record<string, number> = {};
      const certaintyMix: Record<string, number> = {};
      let excludedCount = 0;
      let failOpenCount = 0;
      for (const r of results) {
        categoryMix[r.category] = (categoryMix[r.category] ?? 0) + 1;
        certaintyMix[r.certainty] = (certaintyMix[r.certainty] ?? 0) + 1;
        if (isEligibilityExcluded(r)) excludedCount++;
        if (r.reason === FAIL_OPEN_REASON) failOpenCount++;
      }
      if (failOpenCount > 0) {
        logger.warn({ module: MODULE, fixtureId: fixture.id, failOpenCount, repeats }, "Some repeats fell back to fail-open (provider error) — categoryMix/certaintyMix for this fixture includes contaminated results");
      }
      perFixture.push({
        id: fixture.id,
        claimText: fixture.claimText,
        categoryMix,
        certaintyMix,
        excludedCount,
        excludedRate: excludedCount / repeats,
        failOpenCount,
        sampleReasons: results.slice(0, 2).map((r) => r.reason),
      });
    }

    logger.info({ module: MODULE, perFixture }, "T25 contentless-claim eligibility experiment complete");

    return { repeats, perFixture };
  }
);
