/**
 * Experiment job — spec 014 T009/T011: screen VERIFY blocks for negated-claim polarity (Block A)
 * and same-subject/different-predicate selection (Block B). specs/014, plan.md § Fixture semantics.
 *
 * Every `expect` here is copied from that pre-registered table. Do NOT edit one to match a result.
 *
 * Trigger: event "eval/negation-polarity" (scripts/trigger-eval-negation-polarity.ts sends it)
 */
import { randomUUID } from "node:crypto";
import { generateShareToken } from "../lib/share-token.js";
import { inngest } from "./client.js";
import { insertBeforeAnchor } from "./prompt-splice.js";
import { GeminiProvider } from "../providers/gemini.js";
import { PromptRegistry } from "../prompts/registry.js";
import { DrizzleGrounnelHistoryStore } from "../persistence/grounnel-history-store.js";
import { DrizzleGrounnelLlmCallStore } from "../persistence/grounnel-llm-call-store.js";
import { callLlmForJson } from "../orchestrators/llm-json-call.js";
import {
  VerifyRawResponseSchema,
  VerifyRawResponseReasonFirstSchema,
  VerifyRawResponsePredicateFirstSchema,
} from "../orchestrators/grounnel/pipeline-schemas.js";
import { CONFIDENCE_THRESHOLD } from "../orchestrators/grounnel/pipeline.service.js";
import { env } from "../lib/env.js";
import { logger } from "../observability/logger.js";

const MODULE = "eval-negation-polarity";

// Insert-before, never replace-between: buildVariantPrompt in eval-t27b-prompt-variants.ts splices
// slice(0,start)+block+slice(end), which would delete every section between two anchors (plan.md
// § T011 splice hazard). Anchoring on one section header and inserting ahead of it cannot do that.
const INSERT_BEFORE = "PARALLEL CLAIMS";

// Imported, never hardcoded — a threshold that differs from production would score every
// variant against a prompt production does not run.
const RENDER_THRESHOLD = String(CONFIDENCE_THRESHOLD);

type Verdict = "supported" | "partially_supported" | "unsupported" | "contradicted" | "unverifiable";
type Role = "negation" | "reporting" | "block-b" | "control";

interface Fixture {
  id: string;
  role: Role;
  claim: string;
  /** passage_sentences: source letter -> sentences, exactly the production render shape. */
  passages: Record<string, string[]> | null;
  expect: Verdict;
  /** Production sends EXTRACT's value here; "" is real when EXTRACT supplies none. */
  subject_entity?: string;
  /** Pre-registered STEP 2 relationship, for the write-up; not scored directly. */
  relationship: "SAME" | "PARTIAL" | "CONFLICT" | "ABSENT";
}

// --- Block A rows 1-8: negated claim vs affirmative evidence of varying strength ---------------
const NEGATION: Fixture[] = [
  { id: "n1-pentagon-investigating", role: "negation", relationship: "PARTIAL", expect: "partially_supported",
    claim: "The Pentagon has not issued an official finding on the Minab strike.",
    passages: { A: ["The Pentagon said in a statement that the incident is under investigation."] } },
  { id: "n2-decision-under-review", role: "negation", relationship: "PARTIAL", expect: "partially_supported",
    claim: "The company has not made a final decision on the merger.",
    passages: { A: ["The proposal remains under review by the board."] } },
  { id: "n3-measure-considered", role: "negation", relationship: "PARTIAL", expect: "partially_supported",
    claim: "The government has not approved the measure.",
    passages: { A: ["The measure is being considered by the relevant ministry."] } },
  { id: "n4-pentagon-concluded", role: "negation", relationship: "CONFLICT", expect: "contradicted",
    claim: "The Pentagon has not issued an official finding on the Minab strike.",
    passages: { A: ["The Pentagon officially concluded that the strike hit a military installation."] } },
  { id: "n5-acquisition-announced", role: "negation", relationship: "CONFLICT", expect: "contradicted",
    claim: "The company has not announced the acquisition.",
    passages: { A: ["The company announced the acquisition on Tuesday morning."] } },
  { id: "n6-law-approved", role: "negation", relationship: "CONFLICT", expect: "contradicted",
    claim: "The government has not approved the law.",
    passages: { A: ["Parliament approved the law in a vote held last week."] } },
  { id: "n7-statement-not-finding", role: "negation", relationship: "PARTIAL", expect: "partially_supported",
    claim: "The Pentagon has not issued an official finding on the Minab strike.",
    passages: { A: ["The Pentagon issued a statement saying the incident is under investigation."] } },
  { id: "n8-finding-issued", role: "negation", relationship: "CONFLICT", expect: "contradicted",
    claim: "The Pentagon has not issued an official finding on the Minab strike.",
    passages: { A: ["The Pentagon issued an official finding that the strike destroyed a radar site."] } },
];

// --- R1-R4: reporting claims under distractor pressure (governed by REPORTING CLAIMS) ----------
const UR_CLAIM = "Social media posts claimed the University of Rochester announced it will cut academic ties with Israel.";
const CONFIRM = "In recent social media and other online posts the student activists claim to have won concessions from the university.";
const REBUTTAL = "University administrators in fact made no commitment to either demand, as is being inaccurately reported on some social media channels.";
const POST_ITSELF = "The post states that the University of Rochester has agreed to cut academic ties with Israel.";

const REPORTING: Fixture[] = [
  { id: "r1-confirm-plus-rebuttal", role: "reporting", relationship: "SAME", expect: "supported",
    claim: UR_CLAIM, passages: { A: [CONFIRM, REBUTTAL] } },
  { id: "r2-confirm-post-rebuttal", role: "reporting", relationship: "SAME", expect: "supported",
    claim: UR_CLAIM, passages: { A: [CONFIRM, REBUTTAL], B: [POST_ITSELF] } },
  { id: "r3-posts-did-not-say", role: "reporting", relationship: "CONFLICT", expect: "contradicted",
    claim: UR_CLAIM, passages: { A: ["No social media post made any claim about the University of Rochester cutting academic ties."] } },
  { id: "r4-object-fact-only", role: "reporting", relationship: "ABSENT", expect: "unsupported",
    claim: UR_CLAIM, passages: { A: ["The University of Rochester has not cut academic ties with any institution."] } },
];

// --- R5/R6: the Block B rows — same named subject, a different predicate ----------------------
const BLOCK_B_ROWS: Fixture[] = [
  { id: "r5-isp100-taught-vs-required", role: "block-b", relationship: "ABSENT", expect: "unsupported",
    claim: "ISP100 taught Alishba Rana that writing is personal.",
    passages: { A: ["ISP100 is becoming a required course for all first-year students in the program."] } },
  { id: "r6-mona-lisa-why-vs-theft", role: "block-b", relationship: "ABSENT", expect: "unsupported",
    claim: "Leonardo painted the Mona Lisa because of the way light falls on curved surfaces.",
    passages: { A: ["A long-running rumour holds that the painting was stolen and replaced with a forgery."] } },
];

// --- Controls: the rows that refute an over-correction ----------------------------------------
const CONTROLS: Fixture[] = [
  { id: "c1-affirmative-not-conflict", role: "control", relationship: "PARTIAL", expect: "partially_supported",
    claim: "The Pentagon issued an official finding on the Minab strike.",
    passages: { A: ["The Pentagon said in a statement that the incident is under investigation."] } },
  { id: "c2-negated-unrelated", role: "control", relationship: "ABSENT", expect: "unsupported",
    claim: "The Pentagon has not issued an official finding on the Minab strike.",
    passages: { A: ["Global shipping rates fell for a third consecutive month, industry data showed."] } },
  { id: "c3-finding-beside-hedging", role: "control", relationship: "CONFLICT", expect: "contradicted",
    claim: "The Pentagon has not issued an official finding on the Minab strike.",
    passages: { A: ["The investigation continues, and the Pentagon's official finding released Tuesday concluded the strike hit a military installation."] } },
  // C5 is deliberately n1 repeated — its only job is to fail any Block B variant whose deference
  // sentences were weakened. If C5 and n1 disagree, the variant is refuted however else it scored.
  { id: "c5-narrower-same-predicate", role: "control", relationship: "PARTIAL", expect: "partially_supported",
    claim: "The Pentagon has not issued an official finding on the Minab strike.",
    passages: { A: ["The investigation remains under review by senior military officials."] } },
  { id: "c1prime-affirmative-object-fact", role: "control", relationship: "CONFLICT", expect: "contradicted",
    claim: "The University of Rochester cut academic ties with Israel.",
    passages: { A: [CONFIRM, REBUTTAL], B: [POST_ITSELF] } },
];

// --- C4: g25-g29 regression. passages:null — a golden case stores only article text, so these
// cannot run until the capture-and-freeze run in plan.md's C4 OPEN note has happened. Declared so
// the pre-registered count stays honest and the gap is loud rather than silently dropped.
const C4_PENDING: Fixture[] = [
  { id: "c4-g25-microsoft-iphone", role: "control", relationship: "CONFLICT", expect: "supported", claim: "The iPhone was not created by Microsoft.", passages: null },
  { id: "c4-g26-eiffel-london", role: "control", relationship: "CONFLICT", expect: "supported", claim: "The Eiffel Tower is not in London.", passages: null },
  { id: "c4-g27-aldrin-first", role: "control", relationship: "CONFLICT", expect: "supported", claim: "Buzz Aldrin was not the first man to walk on the Moon.", passages: null },
  { id: "c4-g28-wwii-1943", role: "control", relationship: "CONFLICT", expect: "supported", claim: "World War II did not end in 1943.", passages: null },
  { id: "c4-g29-great-wall-roman", role: "control", relationship: "CONFLICT", expect: "supported", claim: "The Great Wall of China was not built by the Roman Empire.", passages: null },
];

export const FIXTURES: Fixture[] = [...NEGATION, ...REPORTING, ...BLOCK_B_ROWS, ...CONTROLS, ...C4_PENDING];
const RUNNABLE = FIXTURES.filter((f) => f.passages !== null);

// --- Variants. Precondition 2: block_a and block_b are never concatenated into one string; the
// combined variant exists only to measure interference, never as the thing intended to ship.
const BLOCK_A = `NEGATED CLAIMS AND EVIDENCE STRENGTH
When the claim asserts that something has NOT happened, compare the evidence to the claim at the
strength the claim denies. Evidence describing a weaker or compatible state of the same process —
an inquiry that is open, a decision still pending, a matter under review — supports the claim that
the stronger, completed act has not occurred. Treat it as CONFLICT only when the evidence states
the denied act at the claimed strength.`;

const BLOCK_B = `ASSERTED PREDICATE
Select passage sentences that address the fact the claim actually asserts, not merely another fact
about the same subject. A sentence about a different property of the same named entity is ABSENT,
not SAME and not CONFLICT.
This does not apply to a weaker or narrower form of the SAME predicate, which is covered above.
It also does not apply to claims about what someone said, claimed or reported, which are governed
by REPORTING CLAIMS.`;

export const VARIANTS: Array<{ id: string; strategy: string; blocks: string[] }> = [
  { id: "v0-control", strategy: "CONTROL — live 4.6.0, no block inserted", blocks: [] },
  { id: "vA-negation", strategy: "Block A only — negated claim vs weaker affirmative evidence", blocks: [BLOCK_A] },
  { id: "vB-predicate", strategy: "Block B only — same subject, different predicate is ABSENT", blocks: [BLOCK_B] },
  { id: "vAB-both", strategy: "INTERFERENCE PROBE ONLY — both blocks; never the ship candidate", blocks: [BLOCK_A, BLOCK_B] },
];

/** Insert ahead of one section header. Never replaces a range, so no section can be deleted. */
export function buildVariantPrompt(rendered: string, blocks: string[]): string {
  return insertBeforeAnchor(rendered, INSERT_BEFORE, blocks);
}

export const dryRunCallCount = (repeats: number) => VARIANTS.length * RUNNABLE.length * repeats;

/** Event-supplied fixtures/variants override the built-in ones, so a new screen needs no redeploy. */
/** Schema variants differ ONLY in field order — the lever T27 identified, since Gemini generates
 * in schema order and a field after `verdict` cannot shape it. */
const SCHEMAS = {
  "verdict-first": VerifyRawResponseSchema,
  "reason-first": VerifyRawResponseReasonFirstSchema,
  "predicate-first": VerifyRawResponsePredicateFirstSchema,
} as const;
type SchemaVariant = keyof typeof SCHEMAS;

interface ScreenOverride {
  schemaVariant?: SchemaVariant;
  fixtures?: Array<{ id: string; role: Role; claim: string; passages: Record<string, unknown> | null; expect: Verdict; subject_entity?: string; relationship?: Fixture["relationship"] }>;
  variants?: Array<{ id: string; strategy?: string; blocks: string[] }>;
}

export const evalNegationPolarityJob = inngest.createFunction(
  { id: "eval-negation-polarity", name: "Experiment — 014 Negation Polarity / Asserted Predicate" },
  { event: "eval/negation-polarity" },
  async ({ event, step }) => {
    const repeats = Math.max(1, Math.min(5, Number(event.data?.repeats ?? 3)));
    const override = (event.data ?? {}) as ScreenOverride;
    // passage_sentences is passed through verbatim — production's own render shape, not re-derived.
    const fixtures = (override.fixtures?.length ? (override.fixtures as unknown as Fixture[]) : FIXTURES).filter((f) => f.passages !== null);
    const schemaVariant: SchemaVariant = override.schemaVariant && override.schemaVariant in SCHEMAS ? override.schemaVariant : "verdict-first";
    const responseSchema = SCHEMAS[schemaVariant];
    const variants = override.variants?.length ? override.variants.map((v) => ({ id: v.id, strategy: v.strategy ?? "(event-supplied)", blocks: v.blocks })) : VARIANTS;
    const provider = new GeminiProvider();
    const prompts = new PromptRegistry();
    const historyStore = new DrizzleGrounnelHistoryStore();
    const llmCallStore = new DrizzleGrounnelLlmCallStore();

    const experimentRunId = await step.run("create-experiment-run", async () => {
      const runId = randomUUID();
      await historyStore.createRun({
        runId, shareToken: generateShareToken(), sessionId: null,
        text: `[negation-polarity] ${variants.length} variants x ${fixtures.length} fixtures x ${repeats}`,
        source: "eval", maxClaims: fixtures.length, truncated: false,
      });
      return runId;
    });

    logger.info(
      { module: MODULE, variants: variants.length, fixtures: fixtures.length, repeats, schemaVariant, calls: variants.length * fixtures.length * repeats, overridden: !!override.fixtures?.length },
      "Starting negation-polarity screen"
    );

    const perVariant = [];
    for (const variant of variants) {
      const perFixture: Array<{ id: string; role: Role; expect: Verdict; hits: number; mix: Record<string, number> }> = [];
      for (const fixture of fixtures) {
        const mix: Record<string, number> = {};
        let hits = 0;
        for (let i = 0; i < repeats; i++) {
          const verdict = await step.run(`${variant.id}--${fixture.id}--${i + 1}`, async () => {
            const rendered = prompts.render("grounnel-verify", {
              claim_passage_pairs: JSON.stringify([
                // Defaults to "" so the built-in fixtures keep varying only by spliced block; an
                // event fixture may set it, which is itself the lever the payload screens test.
                { id: fixture.id, claim: fixture.claim, subject_entity: fixture.subject_entity ?? "", passage_sentences: fixture.passages },
              ]),
              threshold: RENDER_THRESHOLD,
            });
            const raw = await callLlmForJson({
              provider,
              system: buildVariantPrompt(rendered, variant.blocks),
              user: "Verify the claim/passage pair above. Return the JSON now.",
              schema: responseSchema,
              expectedKeys: ["results"],
              attempts: 2,
              module: MODULE,
              operation: "negationPolarityScreen",
              onComplete: llmCallStore.recordCall({
                runId: experimentRunId,
                claimId: undefined,
                stage: "verify",
                callType: "primary",
                provider: provider.mode,
                model: env.GEMINI_MODEL,
                promptVersion: `neg-${variant.id}`,
              }),
            });
            return raw.results[0]?.verdict ?? "unverifiable";
          });
          mix[verdict] = (mix[verdict] ?? 0) + 1;
          if (verdict === fixture.expect) hits++;
        }
        perFixture.push({ id: fixture.id, role: fixture.role, expect: fixture.expect, hits, mix });
      }

      const byRole = (r: Role) => perFixture.filter((f) => f.role === r);
      const allHit = (rows: typeof perFixture) => rows.every((f) => f.hits === repeats);
      const missed = (rows: typeof perFixture) => rows.filter((f) => f.hits < repeats).map((f) => f.id);

      // C5 and n1 are the same fixture. Disagreement refutes the variant regardless of totals.
      // Only meaningful when both rows are present; an event-supplied subset may omit them.
      const n1 = perFixture.find((f) => f.id === "n1-pentagon-investigating");
      const c5 = perFixture.find((f) => f.id === "c5-narrower-same-predicate");
      const c5Split = !!n1 && !!c5 && n1.hits !== c5.hits;

      const verdict = !allHit(byRole("control"))
        ? `FAIL — control(s) broken: ${missed(byRole("control")).join(", ")}`
        : !allHit(byRole("reporting"))
          ? `FAIL — reporting row(s) broken: ${missed(byRole("reporting")).join(", ")}`
          : c5Split
            ? "FAIL — C5 and n1 disagree; Block B ate Block A"
            : !allHit(byRole("negation"))
              ? `INCONCLUSIVE — negation row(s) missed: ${missed(byRole("negation")).join(", ")}`
              : !allHit(byRole("block-b"))
                ? `WEAK — block-b row(s) missed: ${missed(byRole("block-b")).join(", ")}`
                : "PASS";

      perVariant.push({
        id: variant.id, strategy: variant.strategy, verdict, c5Split,
        negationHits: byRole("negation").reduce((a, f) => a + f.hits, 0),
        negationTotal: byRole("negation").length * repeats,
        controlMissed: missed(byRole("control")),
        reportingMissed: missed(byRole("reporting")),
        blockBMissed: missed(byRole("block-b")),
        perFixture,
      });
      logger.info({ module: MODULE, variant: variant.id, verdict }, "negation-polarity variant scored");
    }

    const ranked = [...perVariant].sort(
      (a, b) => a.controlMissed.length - b.controlMissed.length || a.reportingMissed.length - b.reportingMissed.length || b.negationHits - a.negationHits
    );
    logger.info({ module: MODULE, winner: ranked[0]?.id }, "negation-polarity screen complete");
    return { repeats, schemaVariant, calls: variants.length * fixtures.length * repeats, ranked };
  }
);
