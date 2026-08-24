/**
 * One-off controlled experiment — NOT part of the eval suite, throwaway, not wired into anything.
 * Part 1: VERIFY evidence-formatting variants on the g17 case — see D030 §3g follow-up discussion.
 * Part 2: consistency-check model comparison (D030 §3i "P1") — see that section for why this runs
 * here instead of locally, and what question it answers.
 *
 * Trigger: event "eval/verify-experiment" (scripts/trigger-verify-experiment.ts sends it)
 */
import { GoogleGenerativeAI } from "@google/generative-ai";
import { inngest } from "./client.js";
import { GeminiProvider } from "../providers/gemini.js";
import { PromptRegistry } from "../prompts/registry.js";
import { callLlmForJson } from "../orchestrators/llm-json-call.js";
import { buildPassageSentencesMulti } from "../orchestrators/grounnel/passage-sentences.js";
import { VerifyRawResponseSchema, ConsistencyCheckResponseSchema } from "../orchestrators/grounnel/pipeline-schemas.js";
import { zodToGeminiSchema } from "../providers/gemini-schema.js";
import { env } from "../lib/env.js";
import type { Provider } from "../providers/types.js";
import { logger } from "../observability/logger.js";

const MODULE = "verify-experiment";
const CLAIM = "The first flight covered 852 feet.";
const SUBJECT_ENTITY = "Wright brothers";

// Real excerpts pulled from grounnel_search_pages for live g17 runs this session — not synthetic.
const AMBIGUOUS =
  "The Wright Brothers - First Flight, 1903 Orville's brother Wilbur piloting the record flight lasting 59 seconds over a distance of 852 feet. The distance over the ground was 852 feet in 59 seconds.";
const EXPLICIT_FOURTH =
  "First airplane flight, taking off from rail, near Kitty Hawk, North Carolina, on December 17, 1903. The airplane flew 852 ft (260 m) on its fourth and final flight, but was damaged on landing. The fourth and last flight, by Wilbur, took 59 seconds to cover 852 feet (260 m) over the ground. This flight, the fourth and final of 17 December 1903, was the longest.";
// Real historical fact (well-documented), not in the live-retrieved pool this session — added here
// specifically to test reconciliation against an explicit first-flight figure, per the user's design.
const EXPLICIT_FIRST =
  "The first flight, piloted by Orville Wright, lasted 12 seconds and covered 120 feet. Three more flights followed that day, taking turns piloting; the fourth and final flight, piloted by Wilbur, covered 852 feet.";

// Deliberately a user-message addendum only, never promoted into grounnel-verify/system.json — this
// stays a throwaway probe, not a shipped fix; see D030 §3g for why.
const RECONCILIATION_INSTRUCTION =
  "When sources differ in instance attribution, prefer explicit instance attribution over a source whose wording is ambiguous or whose title/heading is merely general.";

async function runVariant(provider: Provider, label: string, system: string, user: string) {
  const raw = await callLlmForJson({
    provider,
    system,
    user,
    schema: VerifyRawResponseSchema,
    expectedKeys: ["results"],
    quotedFields: [],
    attempts: 3,
    module: MODULE,
    operation: `verify-experiment-${label}`,
    isValid: (r) => Array.isArray(r.results),
  });
  logger.info({ module: MODULE, label, raw }, "verify-experiment variant result");
  return { label, result: raw.results[0] ?? null };
}

// D030 §3i P0 — 9 real captured triples, deduped. expectedConsistent is hand-verified against §3g's
// rule; mode tags the D030 §3i failure mechanism (see that section for the full grading rationale).
interface ConsistencyFixture {
  claim: string;
  reason: string;
  verdict: string;
  expectedConsistent: boolean;
  mode: "control" | "A" | "B" | "C";
  note: string;
}

const CONSISTENCY_FIXTURES: ConsistencyFixture[] = [
  {
    claim: "The first flight lasted 59 seconds.",
    reason: "The available sources did not provide a specific passage that could be cited to verify this claim.",
    verdict: "unverifiable",
    expectedConsistent: true,
    mode: "control",
    note: "reason correctly reports no evidence found; matches unverifiable",
  },
  {
    claim: "The first flight covered 852 feet.",
    reason: "Multiple passages state that the fourth and final flight covered 852 feet.",
    verdict: "contradicted",
    expectedConsistent: true,
    mode: "control",
    note: "reason correctly names the different member (fourth); matches contradicted",
  },
  {
    claim: "The first flight lasted 59 seconds.",
    reason: "The passage states that the longest flight traveled 852 feet in 59 seconds, which supports the claim that the first flight lasted 59 seconds.",
    verdict: "supported",
    expectedConsistent: false,
    mode: "A",
    note: "reason names a different member (longest) but verdict is supported — live flash-lite said consistent:true (miss) on the very first attempt, no retry triggered",
  },
  {
    claim: "The first flight lasted 59 seconds.",
    reason: "Source A states the longest flight traveled 852 feet in 59 seconds, and Source B confirms the time of the flight was 59 seconds.",
    verdict: "supported",
    expectedConsistent: false,
    mode: "A",
    note: "reason leans on the longest-flight source to support the first-flight claim",
  },
  {
    claim: "The first flight covered 852 feet.",
    reason: "Source A states that the longest flight traveled 852 feet in 59 seconds. Source B states that the longest lasting 59 seconds and a distance of 852 feet.",
    verdict: "supported",
    expectedConsistent: false,
    mode: "A",
    note: "live flash-lite said consistent:true on the first attempt for this exact pair — no retry triggered at all",
  },
  {
    claim: "The first flight covered 852 feet.",
    reason: "The passage states that the longest flight of the day, the fourth, flew 852 feet in 59 seconds, and another passage states that on the first day, the plane flew a distance of 852 feet.",
    verdict: "contradicted",
    expectedConsistent: true,
    mode: "control",
    note: "reason names fourth explicitly; matches contradicted",
  },
  {
    claim: "The first flight lasted 59 seconds.",
    reason: "Both sources state that the longest flight of the day lasted 59 seconds.",
    verdict: "supported",
    expectedConsistent: false,
    mode: "B",
    note: "this is the RETRY's own reason (the primary reason was correctly flagged inconsistent, triggering one retry) — never re-checked live, stored as final",
  },
  {
    claim: "The first flight covered 852 feet.",
    reason: "Multiple sentences across sources A, B, and C state that the first flight covered 852 feet.",
    verdict: "supported",
    expectedConsistent: true,
    mode: "C",
    note: "reason never names a different member at all (drops the selector entirely) — consistent:true is the textbook-correct answer to what the reason actually says; only an evidence-side check (D030 §3i P2/P3) can catch this one, not this classifier",
  },
  {
    claim: "The first flight lasted 59 seconds.",
    reason: "The passage states that the longest flight lasted 59 seconds.",
    verdict: "supported",
    expectedConsistent: false,
    mode: "A",
    note: "live flash-lite said consistent:true on the first attempt — the exact phrasing §3g's shipped rule names as a worked example",
  },
];

// Direct SDK call, not GeminiProvider (bound to a single env.GEMINI_MODEL) — lets this compare models
// the production pipeline doesn't use. temperature:0 and the timeout match callLlmForJson's own
// GeminiProvider path exactly, so this is a same-conditions model comparison, not confounded by
// decode randomness or hang risk on a model that may have zero quota on this key (gemini-2.5-pro is
// deprecated here, 404 -> "use gemini-3.1-pro-preview"). Errors are caught, not thrown, so one
// zero-quota model can't fail the whole Inngest run.
async function callConsistencyCheckDirect(modelName: string, system: string): Promise<{ consistent: boolean | null; error: string | null }> {
  try {
    const client = new GoogleGenerativeAI(env.GEMINI_API_KEY);
    const model = client.getGenerativeModel(
      {
        model: modelName,
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: zodToGeminiSchema(ConsistencyCheckResponseSchema),
        },
      },
      { timeout: env.AI_TIMEOUT_MS }
    );
    const result = await model.generateContent({ contents: [{ role: "user", parts: [{ text: `SYSTEM: ${system}\n\nUSER: Return the JSON now.` }] }] });
    const parsed = JSON.parse(result.response.text());
    return { consistent: parsed.results?.[0]?.consistent ?? null, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ module: MODULE, operation: "callConsistencyCheckDirect", modelName, err: message }, "consistency-check model comparison call failed");
    return { consistent: null, error: message };
  }
}

// Current production model goes through GeminiProvider/callLlmForJson (same code path VERIFY uses),
// stronger candidates go through the direct helper above — env.GEMINI_MODEL is a single fixed value,
// not something GeminiProvider lets a caller override per call.
const COMPARISON_MODELS = ["gemini-2.5-flash", "gemini-3.1-pro-preview"] as const;

interface ConsistencyGradedResult {
  mode: ConsistencyFixture["mode"];
  claim: string;
  expectedConsistent: boolean;
  productionModel: { model: string; consistent: boolean | null; error: string | null; correct: boolean | null };
  comparisons: Array<{ model: string; consistent: boolean | null; error: string | null; correct: boolean | null }>;
}

export const verifyExperimentJob = inngest.createFunction(
  { id: "verify-experiment", name: "Experiment — VERIFY evidence-formatting (g17)" },
  { event: "eval/verify-experiment" },
  async ({ step }) => {
    const provider = new GeminiProvider();
    const prompts = new PromptRegistry();

    // Part 1 — VERIFY evidence-formatting (original, unchanged).
    const v1Pairs = [
      {
        id: "c1",
        claim: CLAIM,
        subject_entity: SUBJECT_ENTITY,
        passage_sentences: buildPassageSentencesMulti(CLAIM, [
          { label: "A", text: AMBIGUOUS },
          { label: "B", text: EXPLICIT_FOURTH },
          { label: "C", text: EXPLICIT_FIRST },
        ]),
      },
    ];
    const v1System = prompts.render("grounnel-verify", { claim_passage_pairs: JSON.stringify(v1Pairs), threshold: "0.6" });
    const r1 = await step.run("variant-1-current", () => runVariant(provider, "v1-current-format", v1System, "Return the JSON now."));

    const v2Pairs = [
      {
        id: "c1",
        claim: CLAIM,
        subject_entity: SUBJECT_ENTITY,
        passage_sentences: buildPassageSentencesMulti(CLAIM, [
          { label: "A-ambiguous-no-instance-stated", text: AMBIGUOUS },
          { label: "B-explicitly-fourth-and-final-flight", text: EXPLICIT_FOURTH },
          { label: "C-explicitly-first-flight", text: EXPLICIT_FIRST },
        ]),
      },
    ];
    const v2System = prompts.render("grounnel-verify", { claim_passage_pairs: JSON.stringify(v2Pairs), threshold: "0.6" });
    const r2 = await step.run("variant-2-labeled", () => runVariant(provider, "v2-explicit-labels", v2System, "Return the JSON now."));

    const r3 = await step.run("variant-3-labeled-plus-instruction", () =>
      runVariant(provider, "v3-labels-plus-instruction", v2System, `${RECONCILIATION_INSTRUCTION}\n\nReturn the JSON now.`)
    );

    // Part 2 — D030 §3i P1: consistency-check model comparison on real captured triples.
    const graded: ConsistencyGradedResult[] = [];
    for (const [i, fixture] of CONSISTENCY_FIXTURES.entries()) {
      const system = prompts.render("grounnel-consistency-check", {
        reason_verdict_pairs: JSON.stringify([{ id: "x1", claim: fixture.claim, reason: fixture.reason, verdict: fixture.verdict }]),
      });

      const prodResult = await step.run(`consistency-${i}-production-${env.GEMINI_MODEL}`, async () => {
        try {
          const map = await callLlmForJson({
            provider,
            system,
            user: "Return the JSON now.",
            schema: ConsistencyCheckResponseSchema,
            expectedKeys: ["results"],
            quotedFields: [],
            attempts: 1,
            module: MODULE,
            operation: `consistency-${i}-production`,
            isValid: (r) => Array.isArray(r.results),
          });
          return { consistent: map.results[0]?.consistent ?? null, error: null };
        } catch (err) {
          return { consistent: null, error: err instanceof Error ? err.message : String(err) };
        }
      });

      const comparisons: ConsistencyGradedResult["comparisons"] = [];
      for (const modelName of COMPARISON_MODELS) {
        const cmp = await step.run(`consistency-${i}-${modelName}`, () => callConsistencyCheckDirect(modelName, system));
        comparisons.push({ model: modelName, ...cmp, correct: cmp.consistent === null ? null : cmp.consistent === fixture.expectedConsistent });
      }

      graded.push({
        mode: fixture.mode,
        claim: fixture.claim,
        expectedConsistent: fixture.expectedConsistent,
        productionModel: { model: env.GEMINI_MODEL, ...prodResult, correct: prodResult.consistent === null ? null : prodResult.consistent === fixture.expectedConsistent },
        comparisons,
      });
    }

    // Per-model accuracy against hand-verified ground truth — answers D030 §3i's actual P1 question.
    const accuracy: Record<string, { correct: number; total: number; errors: number }> = {};
    const tally = (model: string, correct: boolean | null) => {
      accuracy[model] ??= { correct: 0, total: 0, errors: 0 };
      if (correct === null) accuracy[model]!.errors++;
      else {
        accuracy[model]!.total++;
        if (correct) accuracy[model]!.correct++;
      }
    };
    for (const g of graded) {
      tally(g.productionModel.model, g.productionModel.correct);
      for (const c of g.comparisons) tally(c.model, c.correct);
    }

    logger.info({ module: MODULE, accuracy }, "verify-experiment: consistency-check model comparison accuracy");

    return { verifyFormatting: { claim: CLAIM, variants: [r1, r2, r3] }, consistencyCheckComparison: { graded, accuracy } };
  }
);
