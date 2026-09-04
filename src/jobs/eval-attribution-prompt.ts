/**
 * Experiment — attribution prompt/FACT variants on PINNED passages (D030 §3m Addenda 11-12).
 *
 * Blocks and fixtures travel in the event payload, so a new hypothesis needs no redeploy.
 * Controls must not move: a `different` on a t-* fixture is a false accusation, not a win.
 */
import { randomUUID } from "node:crypto";
import { inngest } from "./client.js";
import { GeminiProvider } from "../providers/gemini.js";
import { PromptRegistry } from "../prompts/registry.js";
import { HybridSearchProvider } from "../providers/search/hybrid-provider.js";
import { TavilySearchProvider } from "../providers/search/tavily-provider.js";
import { DrizzleGrounnelSearchCallStore } from "../persistence/grounnel-search-call-store.js";
import { DrizzleGrounnelHistoryStore } from "../persistence/grounnel-history-store.js";
import { DrizzleGrounnelLlmCallStore } from "../persistence/grounnel-llm-call-store.js";
import { buildPassageSentences } from "../orchestrators/grounnel/passage-sentences.js";
import { stripInstanceSelector } from "../lib/instance-selector.js";
import { InstanceAttributionResponseSchema } from "../orchestrators/grounnel/pipeline-schemas.js";
import { callLlmForJson } from "../orchestrators/llm-json-call.js";
import { env } from "../lib/env.js";
import { logger } from "../observability/logger.js";

const MODULE = "eval-attribution-prompt";
const ATTEMPTS = 3;

// Insert-before, never replace-between (eval-negation-polarity.ts): splicing slice(0,start)+block+
// slice(end) across two anchors deletes every section between them. One anchor cannot do that.
const INSERT_BEFORE = "Output JSON only:";

/** The shipped trim — this experiment varies the prompt, so the payload must match production. */
const TRIM_SENTENCES = 20;

interface Fixture {
  id: string;
  claim: string;
  value: string;
  /** Only used when `passages` is absent. Live retrieval reintroduces the variance this pins out. */
  query?: string;
  /** PINNED evidence, verbatim. Present = no retrieval, so the prompt block is the only variable. */
  passages?: string[];
  /** What production sends as FACT. Defaults to the claim, which was production's old behaviour. */
  fact?: string;
  /** Derive FACT with the SHIPPED helper, so the tested string cannot drift from production's. */
  stripFact?: boolean;
  /** The answer the CURRENT prompt gives on THIS evidence — the baseline a block must beat or hold. */
  control: string;
  /** `target` = should become `different`; `control` = must not move. */
  kind: "target" | "control";
}

// Verbatim sentences observed in live runs (en.wikipedia.org/wiki/Wright_Flyer and the pages the
// 2026-09-04 runs retrieved). Pinned so retrieval variance cannot masquerade as a prompt effect.
const ORDINAL_EVIDENCE = [
  "The fourth and last flight, by Wilbur, took 59 seconds to cover 852 feet (260 m) over the ground, moving through approximately a half mile of air.",
  "This flight, the fourth and final of 17 December 1903, was the longest: 852 feet (260 m) covered in 59 seconds.",
];
const RANKING_EVIDENCE = [
  "Orville's brother Wilbur piloting the record flight lasting 59 seconds over a distance of 852 feet.",
  "The brothers completed three more flights that day, taking turns piloting, the longest traveling 852 feet in 59 seconds.",
];
const NO_MEMBER_EVIDENCE = [
  "The distance over the ground was 852 feet in 59 seconds.",
  "The aircraft covered 852 feet before touching down.",
];

const DEFAULT_FIXTURES: Fixture[] = [
  // THE TEST. Evidence names the member by POSITION ("fourth and last"), which is what the gate
  // exists to catch. `different` is the prompt's own correct answer; `absent` is the defect.
  { id: "f-ordinal-evidence", kind: "target", control: "absent",
    claim: "The first flight covered 852 feet.", value: "852", passages: ORDINAL_EVIDENCE },
  // Ranking-only evidence. `absent` IS correct here (D030 §3e excludes superlatives deliberately),
  // so a block that turns this into `different` is over-triggering, not fixing.
  { id: "t-ranking-evidence", kind: "control", control: "absent",
    claim: "The first flight covered 852 feet.", value: "852", passages: RANKING_EVIDENCE },
  // Same ordinal evidence, TRUE claim — must stay `same`. Catches a block that just says `different`.
  { id: "t-ordinal-true", kind: "control", control: "same",
    claim: "The fourth flight covered 852 feet.", value: "852", passages: ORDINAL_EVIDENCE },
  // Fact stated with no member named at all — the textbook `absent`, a real repeated-set claim.
  { id: "t-no-member", kind: "control", control: "absent",
    claim: "The first flight covered 852 feet.", value: "852", passages: NO_MEMBER_EVIDENCE },

  // --- FACT axis (Addendum 11 follow-up) -------------------------------------------------------
  // Production sends `fact: claim`, so the FACT arrives with its own member baked in and the model
  // reads "no passage attributes [THE FIRST FLIGHT covered 852 ft] to anyone" -> `absent`. These
  // strip the selector so FACT is the asserted value alone, which is what the prompt's own opening
  // paragraph describes ("a CLAIM that selects one member ... the FACT it asserts about it").
  { id: "f-fact-stripped", kind: "target", control: "absent",
    claim: "The first flight covered 852 feet.", fact: "covered 852 feet",
    value: "852", passages: ORDINAL_EVIDENCE },
  // Stripping the FACT must not turn a TRUE ordinal claim into a false accusation.
  { id: "t-stripped-true", kind: "control", control: "same",
    claim: "The fourth flight covered 852 feet.", fact: "covered 852 feet",
    value: "852", passages: ORDINAL_EVIDENCE },
  // Nor may it defeat the deliberate superlative exclusion (D030 §3e) — ranking evidence stays `absent`.
  { id: "t-stripped-ranking", kind: "control", control: "absent",
    claim: "The first flight covered 852 feet.", fact: "covered 852 feet",
    value: "852", passages: RANKING_EVIDENCE },
  // Nor invent an attribution where the passages name no member at all.
  { id: "t-stripped-no-member", kind: "control", control: "absent",
    claim: "The first flight covered 852 feet.", fact: "covered 852 feet",
    value: "852", passages: NO_MEMBER_EVIDENCE },

  // --- PRODUCTION strip -----------------------------------------------------------------------
  // The fixtures above validated a hand-written bare predicate ("covered 852 feet"). The shipped
  // helper produces "The flight covered 852 feet." — a DIFFERENT string, so it must be re-measured
  // before a golden run spends on it. `stripFact` calls the real helper, so this cannot drift.
  { id: "f-prod-strip", kind: "target", control: "absent",
    claim: "The first flight covered 852 feet.", stripFact: true,
    value: "852", passages: ORDINAL_EVIDENCE },
  { id: "t-prod-strip-true", kind: "control", control: "same",
    claim: "The fourth flight covered 852 feet.", stripFact: true,
    value: "852", passages: ORDINAL_EVIDENCE },
  { id: "t-prod-strip-ranking", kind: "control", control: "absent",
    claim: "The first flight covered 852 feet.", stripFact: true,
    value: "852", passages: RANKING_EVIDENCE },
  { id: "t-prod-strip-no-member", kind: "control", control: "absent",
    claim: "The first flight covered 852 feet.", stripFact: true,
    value: "852", passages: NO_MEMBER_EVIDENCE },
];

interface Variant { id: string; block: string }

const DEFAULT_VARIANTS: Variant[] = [
  { id: "control", block: "" },
  // The minimal fix: name the branch the scaffold never reaches.
  { id: "different-branch", block:
    "STEP 5. Before you may answer \"absent\": look at the identifier you wrote in step 2. If you identified ANY member for the FACT and that member is not the one the CLAIM selects, the answer is \"different\", not \"absent\". \"absent\" is only for when NO member was identified at all." },
  // Same idea as an explicit table, in case the model follows enumerated cases better than prose.
  { id: "decision-table", block:
    "DECIDE FROM THE IDENTIFIER YOU WROTE IN STEP 2:\n- identifier IS the claim's member -> \"same\"\n- identifier is a DIFFERENT named member -> \"different\"\n- two passages name different members -> \"conflict\"\n- NO member was identified anywhere -> \"absent\"\nNote that \"absent\" requires the absence of an identifier, not the absence of your claim's member." },
  // Guards the Cardinal Rule directly: forces the negative check before the risky answer.
  { id: "guarded-different", block:
    "STEP 5. If you identified a member that is not the claim's member, answer \"different\" and cite that sentence VERBATIM. Do not answer \"different\" unless you can quote a sentence that names that other member; if you cannot quote one, answer \"absent\"." },
];

function splice(rendered: string, block: string): string {
  if (!block) return rendered;
  const at = rendered.indexOf(INSERT_BEFORE);
  if (at === -1) throw new Error(`Cannot splice — anchor "${INSERT_BEFORE}" not found in the rendered attribution prompt`);
  return `${rendered.slice(0, at)}${block}\n\n${rendered.slice(at)}`;
}

export const evalAttributionPromptJob = inngest.createFunction(
  { id: "eval-attribution-prompt", name: "Experiment — Addendum 11 attribution prompt variants" },
  { event: "eval/attribution-prompt" },
  async ({ event, step }) => {
    if (!env.TAVILY_API_KEY) throw new Error("TAVILY_API_KEY is not set — required for this experiment's retrieval.");
    const repeats = Math.max(1, Math.min(5, Number(event.data?.repeats ?? 3)));
    // `fixtures`/`variants` supply new ones; `fixtureIds`/`variantIds` select from the built-ins, so
    // a single axis can be run without re-sending the whole definition.
    const allFixtures: Fixture[] = event.data?.fixtures?.length ? event.data.fixtures : DEFAULT_FIXTURES;
    const allVariants: Variant[] = event.data?.variants?.length ? event.data.variants : DEFAULT_VARIANTS;
    const fIds: string[] | undefined = event.data?.fixtureIds?.length ? event.data.fixtureIds : undefined;
    const vIds: string[] | undefined = event.data?.variantIds?.length ? event.data.variantIds : undefined;
    const fixtures = fIds ? allFixtures.filter((f) => fIds.includes(f.id)) : allFixtures;
    const variants = vIds ? allVariants.filter((v) => vIds.includes(v.id)) : allVariants;
    if (fixtures.length === 0 || variants.length === 0) throw new Error("No fixtures or variants selected");

    const provider = new GeminiProvider();
    const prompts = new PromptRegistry();
    const historyStore = new DrizzleGrounnelHistoryStore();
    const llmCallStore = new DrizzleGrounnelLlmCallStore();
    const searchProvider = new HybridSearchProvider(
      env.GEMINI_API_KEY, env.GEMINI_MODEL,
      new TavilySearchProvider(env.TAVILY_API_KEY), new DrizzleGrounnelSearchCallStore()
    );

    const runId = await step.run("create-experiment-run", async () => {
      const id = randomUUID();
      await historyStore.createRun({
        runId: id, sessionId: null,
        text: `[attribution-prompt] ${variants.length} variants x ${fixtures.length} fixtures x ${repeats}`,
        source: "eval", maxClaims: fixtures.length, truncated: false,
      });
      return id;
    });

    logger.info({ module: MODULE, runId, calls: variants.length * fixtures.length * repeats }, "Attribution prompt experiment starting");

    // Pinned passages win outright: live retrieval is what confounded the first two experiments,
    // returning ranking-only evidence one run and ordinal evidence the next (Addendum 11 follow-up).
    const passagesByFixture: Record<string, string[]> = {};
    for (const f of fixtures) {
      if (f.passages?.length) { passagesByFixture[f.id] = f.passages; continue; }
      if (!f.query) throw new Error(`Fixture ${f.id} has neither pinned passages nor a query`);
      passagesByFixture[f.id] = await step.run(`retrieve-${f.id}`, async () => {
        const sources = await searchProvider.search(f.query!, { runId, claimId: randomUUID() });
        return sources.filter((s) => s.status === "ok" && s.text).slice(0, 3)
          .map((s) => buildPassageSentences(f.claim, s.text!, TRIM_SENTENCES).map((x) => x.text).join(" "));
      });
    }

    const results: Array<Record<string, unknown>> = [];
    for (const variant of variants) {
      for (const f of fixtures) {
        const trimmed = passagesByFixture[f.id] ?? [];
        if (trimmed.length === 0) {
          logger.warn({ module: MODULE, runId, fixture: f.id }, "No usable passages — fixture skipped");
          continue;
        }
        for (let i = 0; i < repeats; i++) {
          let out: Record<string, unknown>;
          try {
            out = await step.run(`${variant.id}-${f.id}-${i + 1}`, async () => {
              const fact = f.stripFact ? stripInstanceSelector(f.claim) : (f.fact ?? f.claim);
              const checks = [{ id: f.id, claim: f.claim, fact, passages: trimmed }];
              const rendered = prompts.render("grounnel-instance-attribution", { instance_checks: JSON.stringify(checks) });
              const parsed = await callLlmForJson({
                provider, system: splice(rendered, variant.block), user: "Return the JSON now.",
                schema: InstanceAttributionResponseSchema,
                expectedKeys: ["results"],
                quotedFields: ["citation", "working"],
                attempts: ATTEMPTS,
                module: MODULE,
                operation: `${MODULE}.${variant.id}`,
                isValid: (r) => Array.isArray(r.results),
                onComplete: llmCallStore.recordCall({
                  runId, stage: "verify", callType: "attribution_experiment",
                  provider: provider.mode, model: env.GEMINI_MODEL, promptVersion: `prompt-${variant.id}-${f.id}`,
                }),
              });
              const r = (parsed as { results?: Array<{ attribution?: string; citation?: string | null }> }).results?.[0];
              return { variant: variant.id, fixture: f.id, kind: f.kind, rep: i + 1, attribution: r?.attribution ?? "(none)" };
            });
          } catch (err) {
            logger.warn({ module: MODULE, runId, variant: variant.id, fixture: f.id, err }, "Variant call failed — continuing");
            out = { variant: variant.id, fixture: f.id, kind: f.kind, rep: i + 1, attribution: "(failed)" };
          }
          results.push(out);
        }
      }
    }

    // A control that moved is disqualifying — report it separately from the target's gain.
    const summary = variants.map((v) => {
      const mine = results.filter((r) => r.variant === v.id);
      const target = mine.filter((r) => r.kind === "target");
      const movedControls = fixtures.filter((f) => f.kind === "control").flatMap((f) => {
        const rs = mine.filter((r) => r.fixture === f.id);
        const bad = rs.filter((r) => r.attribution !== f.control).length;
        return bad > 0 ? [`${f.id}: ${bad}/${rs.length} left "${f.control}"`] : [];
      });
      return {
        variant: v.id,
        targetDifferent: `${target.filter((r) => r.attribution === "different").length}/${target.length}`,
        controlsIntact: movedControls.length === 0,
        movedControls,
        answers: mine.map((r) => `${r.fixture}=${r.attribution}`).join(" "),
      };
    });
    logger.info({ module: MODULE, runId, summary }, "Attribution prompt experiment complete");
    return { runId, summary, results };
  }
);
