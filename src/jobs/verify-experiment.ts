/**
 * One-off controlled experiment — NOT part of the eval suite, throwaway, not wired into anything.
 * Tests whether evidence labeling/formatting (not a new gate, not a prompt rewrite) changes VERIFY's
 * judgment on the g17 case, isolated from retrieval variance: same 3 real excerpts, hand-fed directly,
 * across 3 variants. See D030 §3g follow-up discussion for why (subject_entity/reason_ordinal can't
 * reach this failure mode; root cause is VERIFY not reconciling an ambiguous source against an
 * explicit one, not a missing gate).
 *
 * Trigger: event "eval/verify-experiment" (scripts/trigger-verify-experiment.ts sends it)
 */
import { inngest } from "./client.js";
import { GeminiProvider } from "../providers/gemini.js";
import { PromptRegistry } from "../prompts/registry.js";
import { callLlmForJson } from "../orchestrators/llm-json-call.js";
import { buildPassageSentencesMulti } from "../orchestrators/grounnel/passage-sentences.js";
import { VerifyRawResponseSchema } from "../orchestrators/grounnel/pipeline-schemas.js";
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

export const verifyExperimentJob = inngest.createFunction(
  { id: "verify-experiment", name: "Experiment — VERIFY evidence-formatting (g17)" },
  { event: "eval/verify-experiment" },
  async ({ step }) => {
    const provider = new GeminiProvider();
    const prompts = new PromptRegistry();

    // Variant 1 — current shape: opaque single-letter source labels, no framing.
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

    // Variant 2 — same prompt, labels now state each source's specificity explicitly.
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

    // Variant 3 — variant 2's labels + one narrow reconciliation instruction, added to the user
    // message only (not the prompt file) so this stays a throwaway call, not a shipped change.
    const r3 = await step.run("variant-3-labeled-plus-instruction", () =>
      runVariant(provider, "v3-labels-plus-instruction", v2System, `${RECONCILIATION_INSTRUCTION}\n\nReturn the JSON now.`)
    );

    return { claim: CLAIM, variants: [r1, r2, r3] };
  }
);
