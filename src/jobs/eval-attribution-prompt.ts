/**
 * Experiment — does the attribution prompt's scaffold cause `absent` where `different` is right?
 * (D030 §3m Addendum 11 follow-up)
 *
 * Addendum 11 exonerated the trim: the refuting sentence reaches the model in every variant and it
 * still answers `absent`. Its own `working` shows why — it identifies the member ("the last flight,
 * by Wilbur"), rules out the claim's member, then lands on `absent`. Steps 1-3 only ever ask "is
 * this the claim's member?", so a negative answer has nowhere to go but `absent`.
 *
 * Design: retrieve ONCE per fixture, apply the SHIPPED trim, then vary only the spliced prompt
 * block. Blocks and fixtures travel in the event payload, so a new variant needs no redeploy.
 *
 * CONTROL FIXTURES ARE THE POINT. A block that turns g17 into `different` by making the model
 * answer `different` more often is not a fix, it is a Cardinal Rule hazard: a `reason_ordinal`
 * false positive is unrecoverable (D030 §3d). `t-*` fixtures must NOT move.
 *
 * PRE-REGISTERED BAR, fixed before any result is seen:
 *   A block passes if it raises `different` on f-ordinal-false AND leaves every t-* control at its
 *   control answer. Any block that moves a control is refuted regardless of what it does for g17.
 *
 * Trigger: event "eval/attribution-prompt" (scripts/trigger-attribution-prompt.ts)
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
  query: string;
  /** What the CURRENT prompt answers. A control that moves is a regression, not a win. */
  control: string;
  /** `false` = the claim this gate exists to catch; `true`/`na` = must not move. */
  kind: "target" | "control";
}

const DEFAULT_FIXTURES: Fixture[] = [
  // The case that pays for the gate: 852 ft belongs to the FOURTH/last flight, not the first.
  { id: "f-ordinal-false", kind: "target", control: "absent",
    claim: "The first flight covered 852 feet.", value: "852",
    query: "The first flight covered 852 feet." },
  // Same page, same number, TRUE attribution — a block that flips this to `different` is broken.
  { id: "t-ordinal-true", kind: "control", control: "same",
    claim: "The fourth flight covered 852 feet.", value: "852",
    query: "The fourth flight covered 852 feet." },
  // Genuinely unattributed: the pages state the height without selecting a member.
  { id: "t-genuinely-absent", kind: "control", control: "absent",
    claim: "The first tower measured 1083 feet.", value: "1083",
    query: "Eiffel Tower height 1083 feet." },
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
    const fixtures: Fixture[] = event.data?.fixtures?.length ? event.data.fixtures : DEFAULT_FIXTURES;
    const variants: Variant[] = event.data?.variants?.length ? event.data.variants : DEFAULT_VARIANTS;

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

    // Retrieve ONCE per fixture. Every variant judges identical passages, so the block is the only variable.
    const passagesByFixture: Record<string, string[]> = {};
    for (const f of fixtures) {
      passagesByFixture[f.id] = await step.run(`retrieve-${f.id}`, async () => {
        const sources = await searchProvider.search(f.query, { runId, claimId: randomUUID() });
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
              const checks = [{ id: f.id, claim: f.claim, fact: f.claim, passages: trimmed }];
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
