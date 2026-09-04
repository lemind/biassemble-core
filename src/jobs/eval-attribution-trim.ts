/**
 * Experiment — which passage trim should feed `instance_attribution`? (D030 §3m Addendum 10)
 *
 * Addendum 10 cut attribution's payload 24x (63,915 -> 2,626 avg tokens) by sending VERIFY's
 * 20-sentence slice instead of whole pages. The 2026-09-04 g17 run showed a cost: the gate fired
 * 0/39 against a 6-17% historical rate, and every answer was `same`/`absent` where full pages
 * produced 24 `different` + 9 `conflict`.
 *
 * Suspected mechanism: `buildPassageSentences`'s selector rescue hunts for the CLAIM's own selector
 * ("first"). Attribution needs the opposite — the sentence naming a DIFFERENT member ("the fourth
 * and last flight ... 852 feet"). A rescue tuned for VERIFY can evict exactly what attribution needs.
 *
 * Design: retrieve ONCE, then run every trim variant against the SAME passages, so the trim is the
 * only thing that varies. Variants and fixtures travel in the event payload, so trying another one
 * needs no redeploy.
 *
 * PRE-REGISTERED BAR, fixed before any result is seen:
 *   A variant passes if it recovers `different` on the g17 false claim at a rate comparable to
 *   `full`, AND stays under 10,000 input tokens. A variant that only matches `full` by also
 *   costing like `full` is refuted, not a winner.
 *
 * Trigger: event "eval/attribution-trim" (scripts/trigger-attribution-trim.ts)
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
import { splitIntoSentences } from "../orchestrators/grounnel/passage-sentences.js";
import { SELECTOR_RE_G } from "../lib/instance-selector.js";
import { InstanceAttributionResponseSchema } from "../orchestrators/grounnel/pipeline-schemas.js";
import { callLlmForJson } from "../orchestrators/llm-json-call.js";
import { env } from "../lib/env.js";
import { logger } from "../observability/logger.js";

const MODULE = "eval-attribution-trim";

/** g17, the case that pays for this gate: 33 of 40 historical `contradicted` overrides. */
const DEFAULT_FIXTURE = {
  id: "g17",
  claim: "The first flight covered 852 feet.",
  /** The value the claim asserts — what an attribution sentence must carry to be worth keeping. */
  value: "852",
  query: "The first flight covered 852 feet.",
};

type TrimName = "full" | "s20-claim" | "s20-anyselector" | "s40-claim" | "s60-claim";

/**
 * The proposed rule: keep the normal 20, then force in any sentence carrying the claim's asserted
 * VALUE plus ANY selector word — not just the claim's own. That is the sentence attribution needs
 * ("the fourth and last flight ... 852 feet") and the one a claim-selector rescue can evict.
 */
function anySelectorTrim(claim: string, value: string, text: string, base = 20): string[] {
  const kept = buildPassageSentences(claim, text, base).map((s) => s.text);
  const carriers = splitIntoSentences(text).filter(
    (s) => s.includes(value) && [...s.matchAll(SELECTOR_RE_G)].length > 0
  );
  const missing = carriers.filter((c) => !kept.includes(c));
  return [...kept, ...missing];
}

function applyTrim(name: TrimName, claim: string, value: string, text: string): string[] {
  switch (name) {
    case "full": return [text];
    case "s20-claim": return buildPassageSentences(claim, text, 20).map((s) => s.text);
    case "s40-claim": return buildPassageSentences(claim, text, 40).map((s) => s.text);
    case "s60-claim": return buildPassageSentences(claim, text, 60).map((s) => s.text);
    case "s20-anyselector": return anySelectorTrim(claim, value, text, 20);
  }
}

const ATTEMPTS = 3;

/** `full` runs LAST: it is the likeliest to fail or time out, and it must not do so before the cheap variants bank their data. */
const ALL_TRIMS: TrimName[] = ["s20-claim", "s20-anyselector", "s40-claim", "s60-claim", "full"];

export const evalAttributionTrimJob = inngest.createFunction(
  { id: "eval-attribution-trim", name: "Experiment — Addendum 10 attribution trim variants" },
  { event: "eval/attribution-trim" },
  async ({ event, step }) => {
    // Same guard the golden eval carries — retrieval is the whole point, a missing key must fail loudly.
    if (!env.TAVILY_API_KEY) throw new Error("TAVILY_API_KEY is not set — required for the trim experiment's retrieval.");
    const repeats = Math.max(1, Math.min(5, Number(event.data?.repeats ?? 3)));
    const fixture = { ...DEFAULT_FIXTURE, ...(event.data?.fixture ?? {}) };
    const trims: TrimName[] = event.data?.trims?.length
      ? (event.data.trims as TrimName[]).filter((t) => ALL_TRIMS.includes(t))
      : ALL_TRIMS;

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
        text: `[attribution-trim] ${trims.length} trims x ${repeats} on ${fixture.id}`,
        source: "eval", maxClaims: 1, truncated: false,
      });
      return id;
    });

    // Retrieve ONCE. Every variant judges the same pages — otherwise retrieval variance, not the
    // trim, explains the difference.
    const passages = await step.run("retrieve-once", async () => {
      const sources = await searchProvider.search(fixture.query, { runId, claimId: randomUUID() });
      return sources.filter((s) => s.status === "ok" && s.text).slice(0, 3).map((s) => ({ url: s.url, text: s.text! }));
    });

    if (passages.length === 0) {
      logger.warn({ module: MODULE, runId }, "Retrieval returned no usable pages — nothing to trim");
      return { runId, error: "no passages retrieved" };
    }

    const results: Array<Record<string, unknown>> = [];
    for (const trim of trims) {
      for (let i = 0; i < repeats; i++) {
        let out: Record<string, unknown>;
        try {
          out = await step.run(`${trim}-${i + 1}`, async () => {
            const trimmed = passages.flatMap((p) => {
              const parts = applyTrim(trim, fixture.claim, fixture.value, p.text);
              return [parts.join(" ")];
            });
            const checks = [{ id: fixture.id, claim: fixture.claim, fact: fixture.claim, passages: trimmed }];
            const system = prompts.render("grounnel-instance-attribution", { instance_checks: JSON.stringify(checks) });
            const parsed = await callLlmForJson({
              provider, system, user: "Return the JSON now.",
              schema: InstanceAttributionResponseSchema,
              expectedKeys: ["results"],
              // Both fields quote passage text verbatim — production excludes them from the scan for the same reason.
              quotedFields: ["citation", "working"],
              attempts: ATTEMPTS,
              module: MODULE,
              operation: `${MODULE}.${trim}`,
              isValid: (r) => Array.isArray(r.results),
              onComplete: llmCallStore.recordCall({
                runId, stage: "verify", callType: "attribution_experiment",
                provider: provider.mode, model: env.GEMINI_MODEL, promptVersion: `trim-${trim}`,
              }),
            });
            const r = (parsed as { results?: Array<{ attribution?: string; citation?: string | null }> }).results?.[0];
            return {
              trim, rep: i + 1,
              chars: trimmed.join(" ").length,
              attribution: r?.attribution ?? "(none)",
              citation: (r?.citation ?? "").slice(0, 120),
            };
          });
        } catch (err) {
          // One variant dying must not cost the other four their data — that is what killed run 1.
          logger.warn({ module: MODULE, runId, trim, rep: i + 1, err }, "Trim variant failed — continuing with the rest");
          out = { trim, rep: i + 1, chars: 0, attribution: "(failed)", citation: "" };
        }
        results.push(out);
      }
    }

    // Verdict-moving answers are the only ones that matter — `same`/`absent` are the gate's no-op.
    const summary = trims.map((t) => {
      const mine = results.filter((r) => r.trim === t);
      const moving = mine.filter((r) => r.attribution === "different" || r.attribution === "conflict").length;
      return {
        trim: t, n: mine.length, verdictMoving: moving,
        avgChars: Math.round(mine.reduce((s, r) => s + Number(r.chars), 0) / (mine.length || 1)),
        answers: mine.map((r) => r.attribution).join(","),
      };
    });
    logger.info({ module: MODULE, runId, fixture: fixture.id, summary }, "Attribution trim experiment complete");
    return { runId, passages: passages.map((p) => p.url), summary, results };
  }
);
