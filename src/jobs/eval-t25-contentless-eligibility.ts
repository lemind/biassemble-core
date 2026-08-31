/**
 * Experiment job — spec 013 T25: does eligibility recognize a contentless claim, or wave it
 * through as `checkable`? Design and findings: tasks.md T25, D032 §12 Finding C.
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
// FAIL_OPEN_RESULT is shape-identical to a genuine {checkable, uncertain}, so a rate-limited run
// would report a clean-looking mix; detected by exact match on its fixed reason string.
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

    // Id minted INSIDE the step — a randomUUID() above it churns per Inngest replay and dangles the
    // grounnel_llm_calls FK. Cost a silent 0-row T27 run, 2026-08-31; see tasks.md T27.
    const { experimentRunId, claimIds } = await step.run("create-experiment-run", async () => {
      const runId = randomUUID();
      await historyStore.createRun({
        runId,
        sessionId: null,
        text: `[t25-contentless-eligibility] ${FIXTURES.length} fixtures x ${repeats}`,
        source: "eval",
        maxClaims: FIXTURES.length,
        truncated: false,
      });
      const ids: Record<string, string> = {};
      for (const f of FIXTURES) ids[f.id] = randomUUID();
      return { experimentRunId: runId, claimIds: ids };
    });

    logger.info({ module: MODULE, fixtures: FIXTURES.length, repeats }, "Starting T25 contentless-claim eligibility experiment");

    const perFixture = [];
    for (const fixture of FIXTURES) {
      const claimId = claimIds[fixture.id]!;
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
