/**
 * Prompt-variant experiment for the instance-attribution check (spec 013 T20/T21). NOT wired into
 * the pipeline and must not be: it exists to decide whether such a check is safe enough to build.
 *
 * Replaces verify-experiment.ts, whose two questions are both answered (D030 §3g/§3i).
 * Trigger: event "eval/attribution-experiment".
 */
import { z } from "zod";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { inngest } from "./client.js";
import { GeminiProvider } from "../providers/gemini.js";
import { callLlmForJson } from "../orchestrators/llm-json-call.js";
import { logger } from "../observability/logger.js";

const MODULE = "attribution-experiment";

/** "different" is the only answer that can eventually force a contradiction, so it is the one graded strictly. */
type Attribution = "same" | "different" | "absent" | "conflict";

const ResponseSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      working: z.string().optional(),
      attribution: z.enum(["same", "different", "absent", "conflict"]),
      citation: z.string().nullable(),
    })
  ),
});

interface Fixture {
  id: string;
  group: "positive" | "ambiguous" | "discourse" | "negation" | "same_value";
  claim: string;
  fact: string;
  passages: string[];
  expected: Attribution;
  /** Why this expectation is right FROM THE PASSAGE ALONE — the discipline the whole check depends on. */
  rationale: string;
}

// Real captured g17 passages (carried over from verify-experiment.ts — pulled from grounnel_search_pages
// during live runs, not synthetic).
const CAPTURED_AMBIGUOUS =
  "The Wright Brothers - First Flight, 1903 Orville's brother Wilbur piloting the record flight lasting 59 seconds over a distance of 852 feet. The distance over the ground was 852 feet in 59 seconds.";
const CAPTURED_EXPLICIT_FOURTH =
  "First airplane flight, taking off from rail, near Kitty Hawk, North Carolina, on December 17, 1903. The airplane flew 852 ft (260 m) on its fourth and final flight, but was damaged on landing. The fourth and last flight, by Wilbur, took 59 seconds to cover 852 feet (260 m) over the ground.";
const CAPTURED_LONGEST_OF_FOUR =
  "The Wright Brothers were the first to achieve sustained, controlled, powered heavier-than-air manned flight in 1903, the longest of four covering 852 feet (260 m).";
const CAPTURED_EXPLICIT_FIRST =
  "The first flight, piloted by Orville Wright, lasted 12 seconds and covered 120 feet. Three more flights followed that day, taking turns piloting; the fourth and final flight, piloted by Wilbur, covered 852 feet.";

const CLAIM = "The first flight covered 852 feet.";
const FACT = "852 feet";

const FIXTURES: Fixture[] = [
  // ── positive: the passage names a member explicitly ──
  {
    id: "p1-explicit-same",
    group: "positive",
    claim: CLAIM,
    fact: FACT,
    passages: ["The first flight of the day covered 852 feet in 59 seconds."],
    expected: "same",
    rationale: "Passage names the claim's own member and the fact together.",
  },
  {
    id: "p2-explicit-different",
    group: "positive",
    claim: CLAIM,
    fact: FACT,
    passages: [CAPTURED_EXPLICIT_FOURTH],
    expected: "different",
    rationale: "Passage says 'on its fourth and final flight' — an identified member that is not 'first'.",
  },
  {
    id: "p3-explicit-different-nonflight",
    group: "positive",
    claim: "The second attempt succeeded.",
    fact: "succeeded",
    passages: ["The third attempt succeeded after two failures."],
    expected: "different",
    rationale: "Different domain, same shape — guards against fixtures that only work for flights.",
  },

  // ── ambiguous: the passage states the fact but does not identify the member ──
  // These are the whole point. A 'different' here is a FALSE ACCUSATION in waiting.
  {
    id: "a1-longest-of-four",
    group: "ambiguous",
    claim: CLAIM,
    fact: FACT,
    passages: [CAPTURED_LONGEST_OF_FOUR],
    expected: "absent",
    rationale:
      "Passage attributes 852ft to 'the longest of four'. That the longest WAS the fourth flight is outside knowledge — the passage never says it. 'different' here is unjustified.",
  },
  {
    id: "a2-record-flight",
    group: "ambiguous",
    claim: CLAIM,
    fact: FACT,
    passages: [CAPTURED_AMBIGUOUS],
    expected: "absent",
    rationale: "'the record flight' is a ranking, not a position; the passage never ties it to a numbered flight.",
  },
  {
    id: "a3-no-member-named",
    group: "ambiguous",
    claim: CLAIM,
    fact: FACT,
    passages: ["Multiple sources state that the distance covered was 852 feet."],
    expected: "absent",
    rationale: "Exactly the real VERIFY omission failure (claim c465b3de): the fact with no member at all.",
  },
  {
    id: "a4-bare-a-flight",
    group: "ambiguous",
    claim: CLAIM,
    fact: FACT,
    passages: ["A flight covered 852 feet that day."],
    expected: "absent",
    rationale: "Indefinite article names no member (real reason text from claim 7a42b009).",
  },

  // ── discourse noise: ordinals used as connectives, not selectors ──
  {
    id: "d1-discourse-ordinals",
    group: "discourse",
    claim: CLAIM,
    fact: FACT,
    passages: [
      "First, the source describes the weather that morning. Second, it notes the distance covered was 852 feet.",
    ],
    expected: "absent",
    rationale: "'First'/'Second' enumerate sentences, not flights. Reading them as selectors is the T17 class of bug.",
  },

  // ── explicit negation ──
  {
    id: "n1-negated-then-attributed",
    group: "negation",
    claim: CLAIM,
    fact: FACT,
    passages: ["It was not the first flight; the fourth flight covered 852 feet."],
    expected: "different",
    rationale: "Passage both denies the claim's member and names the real one.",
  },
  {
    id: "n2-negated-only",
    group: "negation",
    claim: CLAIM,
    fact: FACT,
    passages: ["The first flight did not cover 852 feet."],
    expected: "absent",
    rationale:
      "Denies the claim's member but names no other. Nothing to attribute TO — 'different' would be asserting an unnamed member.",
  },

  // ── same value, different instance ──
  {
    id: "s1-first-has-other-value",
    group: "same_value",
    claim: CLAIM,
    fact: FACT,
    passages: [CAPTURED_EXPLICIT_FIRST],
    expected: "different",
    rationale:
      "Passage gives the first flight 120ft and explicitly assigns 852ft to the fourth. The value appearing somewhere is not attribution.",
  },
  {
    id: "s2-both-members-same-value",
    group: "same_value",
    claim: CLAIM,
    fact: FACT,
    passages: ["The first flight covered 852 feet.", "The fourth flight covered 852 feet."],
    expected: "conflict",
    rationale: "Two passages attribute the same fact to different members — the checker must not silently pick one.",
  },
];

function loadVariants(): Array<{ label: string; framing: string; content: string }> {
  const here = dirname(fileURLToPath(import.meta.url));
  const local = join(here, "..", "prompts", "grounnel", "instance-attribution", "variants");
  const bundled = join(here, "prompts", "grounnel", "instance-attribution", "variants");
  const dir = (() => {
    try {
      readdirSync(local);
      return local;
    } catch {
      return bundled;
    }
  })();
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")));
}

function renderChecks(fixtures: Fixture[]): string {
  return JSON.stringify(
    fixtures.map((f) => ({ id: f.id, claim: f.claim, fact: f.fact, passages: f.passages }))
  );
}

/** Precision on "different" is the gate: a wrong "different" is the failure that can reach a user as a false accusation. */
function score(expectedById: Map<string, Fixture>, results: z.infer<typeof ResponseSchema>["results"]) {
  let correct = 0;
  let falseDifferent = 0;
  let missedDifferent = 0;
  let uncited = 0;
  const wrong: Array<{ id: string; expected: string; got: string; citation: string | null }> = [];
  for (const r of results) {
    const f = expectedById.get(r.id);
    if (!f) continue;
    if (r.attribution === f.expected) correct++;
    else {
      wrong.push({ id: r.id, expected: f.expected, got: r.attribution, citation: r.citation });
      if (r.attribution === "different") falseDifferent++;
      if (f.expected === "different") missedDifferent++;
    }
    // A cited answer whose citation is not verbatim in the passages is a fabricated citation — the
    // single most dangerous output shape here, since the whole design leans on citations being real.
    if (r.citation && !f.passages.some((p) => p.includes(r.citation!))) uncited++;
  }
  return { correct, total: results.length, falseDifferent, missedDifferent, fabricatedCitations: uncited, wrong };
}

export const attributionExperimentJob = inngest.createFunction(
  { id: "attribution-experiment", name: "Experiment — Instance Attribution Prompt Variants" },
  { event: "eval/attribution-experiment" },
  async ({ event, step }) => {
    const repeats = Math.max(1, Math.min(10, Number(event.data?.repeats ?? 3)));
    const variants = loadVariants();
    const expectedById = new Map(FIXTURES.map((f) => [f.id, f]));
    const provider = new GeminiProvider();
    const checks = renderChecks(FIXTURES);

    logger.info(
      { module: MODULE, variants: variants.map((v) => v.label), fixtures: FIXTURES.length, repeats },
      "Starting attribution prompt-variant experiment"
    );

    const perVariant = [];
    for (const variant of variants) {
      const runs = [];
      for (let i = 0; i < repeats; i++) {
        const r = await step.run(`${variant.label}-run-${i + 1}`, async () => {
          const parsed = await callLlmForJson({
            provider,
            system: variant.content.replace("{{instance_checks}}", checks),
            user: "Return the JSON now.",
            schema: ResponseSchema,
            expectedKeys: ["results"],
            quotedFields: [],
            attempts: 3,
            module: MODULE,
            operation: `attribution-${variant.label}`,
            isValid: (x) => Array.isArray(x.results),
          });
          return score(expectedById, parsed.results);
        });
        runs.push(r);
      }
      const n = runs.length || 1;
      perVariant.push({
        label: variant.label,
        framing: variant.framing,
        accuracy: runs.reduce((s, r) => s + r.correct / Math.max(1, r.total), 0) / n,
        // The decision gate. Any non-zero value here should block wiring.
        falseDifferentPerRun: runs.reduce((s, r) => s + r.falseDifferent, 0) / n,
        missedDifferentPerRun: runs.reduce((s, r) => s + r.missedDifferent, 0) / n,
        fabricatedCitationsPerRun: runs.reduce((s, r) => s + r.fabricatedCitations, 0) / n,
        wrongExamples: runs[0]?.wrong ?? [],
      });
    }

    const ranked = [...perVariant].sort(
      (a, b) => a.falseDifferentPerRun - b.falseDifferentPerRun || b.accuracy - a.accuracy
    );
    logger.info({ module: MODULE, repeats, ranked }, "Attribution prompt-variant experiment finished");
    return { repeats, fixtures: FIXTURES.length, ranked };
  }
);
