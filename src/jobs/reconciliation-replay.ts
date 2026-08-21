/**
 * TEMPORARY investigation job — NOT part of production behavior, not registered in
 * inngest-functions.ts. Replays checkReasonVerdictConsistency (pipeline.service.ts) in isolation
 * against a hand-built matrix of ordinal-contradiction fixtures, to test whether its "consistent:
 * false" rejection of a live-captured reason_ordinal contradiction (2026-08-20/21, the Wright-
 * brothers "852 feet" case, 5/5 downgraded historically) generalizes beyond that one recurring
 * test case. See D030 §3c for the captured bug this investigates.
 *
 * Trigger: event "investigation/reconciliation-replay" (scripts/trigger-reconciliation-replay.ts)
 * Delete this file (and the trigger script) once the investigation concludes either way.
 */
import { z } from "zod";
import { inngest } from "./client.js";
import { GeminiProvider } from "../providers/gemini.js";
import { PromptRegistry } from "../prompts/registry.js";
import { callLlmForJson } from "../orchestrators/llm-json-call.js";
import { logger } from "../observability/logger.js";

const MODULE = "reconciliation-replay";

const ConsistencyCheckResponseSchema = z.object({
  results: z.array(z.object({ id: z.string(), consistent: z.boolean() })),
});

interface Fixture {
  id: string;
  claim: string;
  reason: string;
  // What a correct reason-vs-verdict judgment should say, given verdict is asserted "contradicted"
  // (mirroring what reconcileContradictedVerdicts actually sends once a gate has already fired).
  expectConsistent: boolean;
}

// 10 diverse ordinal-contradiction cases (different topics, varied reason phrasing) + 4 hard
// negatives (reason does NOT actually establish a differing ordinal — asserting "contradicted"
// would itself be wrong, so a correct classifier should say consistent:false on these).
const FIXTURES: Fixture[] = [
  { id: "flights-basic", claim: "The first flight covered 852 feet.", reason: "The fourth flight went 852 feet.", expectConsistent: true },
  {
    id: "flights-final-phrasing",
    claim: "The first flight covered 852 feet.",
    reason: "The fourth and final flight covered 852 feet, according to the museum record.",
    expectConsistent: true,
  },
  {
    id: "flights-passive-phrasing",
    claim: "The first flight covered 852 feet.",
    reason: "852 feet was recorded on the fourth flight.",
    expectConsistent: true,
  },
  {
    id: "flights-source-attributed",
    claim: "The first flight covered 852 feet.",
    reason: "Source B attributes the 852-feet distance to the fourth flight, not the first.",
    expectConsistent: true,
  },
  { id: "attempts-basic", claim: "The second attempt reached 100m.", reason: "The third attempt reached 100m.", expectConsistent: true },
  {
    id: "attempts-explicit-correction",
    claim: "The second attempt reached 100m.",
    reason: "It was actually the third attempt, not the second, that reached 100m.",
    expectConsistent: true,
  },
  { id: "editions-basic", claim: "The first edition was published in 1999.", reason: "The fifth edition was published in 1999.", expectConsistent: true },
  { id: "trials-basic", claim: "The third trial showed a 40% success rate.", reason: "The first trial showed a 40% success rate.", expectConsistent: true },
  { id: "experiments-last-vs-second", claim: "The last experiment took 12 seconds.", reason: "The second experiment took 12 seconds.", expectConsistent: true },
  { id: "matches-basic", claim: "The first match ended 3-0.", reason: "The fourth match ended 3-0.", expectConsistent: true },
  // Hard negatives — reason does NOT establish a differing ordinal; a "contradicted" verdict here
  // would itself be wrong, so consistent:false is the CORRECT answer.
  { id: "hardneg-self-confirm", claim: "The first flight covered 852 feet.", reason: "The first flight covered 852 feet.", expectConsistent: false },
  {
    id: "hardneg-ambiguous-compound",
    claim: "The first flight covered 852 feet.",
    reason: "Both the first and fourth flights covered 852 feet.",
    expectConsistent: false,
  },
  {
    id: "hardneg-discourse-enumeration",
    claim: "The first flight covered 852 feet.",
    reason: "First, the source discusses the flight program in general. The flight covered 852 feet.",
    expectConsistent: false,
  },
  {
    id: "hardneg-unrelated-ordinal",
    claim: "The first flight covered 852 feet.",
    reason: "The second source confirms the flight covered 852 feet.",
    expectConsistent: false,
  },
];

export const reconciliationReplayJob = inngest.createFunction(
  { id: "reconciliation-replay", name: "INVESTIGATION — Reconciliation classifier replay (temporary, D030 §3c)" },
  { event: "investigation/reconciliation-replay" },
  async ({ step }) => {
    const provider = new GeminiProvider();
    const prompts = new PromptRegistry();
    const promptVersion = prompts.getGrounnelConsistencyCheckVersion();

    const results: Array<Fixture & { actualConsistent: boolean | null; error: string | null }> = [];

    for (const fixture of FIXTURES) {
      const result = await step.run(`fixture-${fixture.id}`, async () => {
        // Exact same shape as checkReasonVerdictConsistency's single-claim call (pipeline.service.ts)
        // — one pair, verdict asserted "contradicted", matching what reconcileContradictedVerdicts
        // actually sends once a deterministic gate has already fired.
        const pairs = [{ id: fixture.id, claim: fixture.claim, reason: fixture.reason, verdict: "contradicted" }];
        const system = prompts.render("grounnel-consistency-check", { reason_verdict_pairs: JSON.stringify(pairs) });
        try {
          const parsed = await callLlmForJson({
            provider,
            system,
            user: "Return the JSON now.",
            schema: ConsistencyCheckResponseSchema,
            expectedKeys: ["results"],
            attempts: 3,
            module: MODULE,
            operation: "replay",
            // Matches production's actual default (pipeline.service.ts's checkReasonVerdictConsistency
            // passes no isValid override, so callLlmForJson's own Array.isArray check applies) — an
            // empty results array is schema-valid there, not retried; keep this replay faithful to it.
            isValid: (r) => Array.isArray(r.results),
          });
          const actual = parsed.results.find((r) => r.id === fixture.id)?.consistent ?? null;
          return { ...fixture, actualConsistent: actual, error: null };
        } catch (err) {
          return { ...fixture, actualConsistent: null, error: err instanceof Error ? err.message : String(err) };
        }
      });
      results.push(result);
    }

    const mismatches = results.filter((r) => r.actualConsistent !== null && r.actualConsistent !== r.expectConsistent);
    const positiveResults = results.filter((r) => r.expectConsistent);
    const positiveMismatches = positiveResults.filter((r) => r.actualConsistent !== null && r.actualConsistent !== r.expectConsistent);

    logger.info(
      {
        module: MODULE,
        totalFixtures: FIXTURES.length,
        promptVersion,
        totalMismatches: mismatches.length,
        positiveOrdinalCases: positiveResults.length,
        positiveOrdinalMismatches: positiveMismatches.length,
        results,
      },
      "Reconciliation classifier replay complete"
    );

    // Red/green via throw, same convention as eval-grounnel-run.ts — full result table embedded
    // in the thrown message so it's visible without digging through step output.
    if (mismatches.length > 0) {
      throw new Error(
        `Reconciliation replay: ${positiveResults.length - positiveMismatches.length}/${positiveResults.length} clear ordinal ` +
          `contradictions correctly recognized as consistent; ${mismatches.length}/${FIXTURES.length} total mismatches.\n` +
          JSON.stringify(results, null, 2)
      );
    }

    return { results, allCorrect: true };
  }
);
