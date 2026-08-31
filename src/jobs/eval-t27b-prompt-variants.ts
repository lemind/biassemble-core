/**
 * Experiment job — spec 013 T27b: screen 10 candidate RESOLVABLE-REFERENT prompt blocks against
 * generic-class claims the v1.1.0 block wrongly excludes. Design and bar: tasks.md T27, D032 §13.
 *
 * Trigger: event "eval/t27b-prompt-variants" (scripts/trigger-eval-t27b.ts sends it)
 */
import { randomUUID } from "node:crypto";
import { inngest } from "./client.js";
import { GeminiProvider } from "../providers/gemini.js";
import { PromptRegistry } from "../prompts/registry.js";
import { DrizzleGrounnelHistoryStore } from "../persistence/grounnel-history-store.js";
import { DrizzleGrounnelLlmCallStore } from "../persistence/grounnel-llm-call-store.js";
import { classifyClaimVerifiability, isEligibilityExcluded } from "../orchestrators/grounnel/claim-eligibility.js";
import { logger } from "../observability/logger.js";

const MODULE = "eval-t27b-prompt-variants";
const FAIL_OPEN_REASON = "Eligibility classification unavailable — failed open to search.";

// The live prompt is split here and the variant block spliced between the two halves, so every
// variant shares the identical category/certainty preamble and output footer.
const BLOCK_START = "RESOLVABLE REFERENT";
const BLOCK_END = "Output JSON only:";

type Role = "contentless" | "generic-class" | "named-referent" | "drift-control";

interface FixtureScore { id: string; role: Role; expect: "exclude" | "keep"; excludedCount: number; referentFalseCount: number; failOpenCount: number; jointMix: Record<string, number> }

interface Fixture {
  id: string;
  claimText: string;
  sourceExcerpt: string | null;
  role: Role;
  expect: "exclude" | "keep";
}

// generic-class are all TRUE, checkable claims whose subject is a plural common noun — the shape
// v1.1.0 wrongly excludes ("Historical computer mice…", live run a24fa8ea). D032 §13.
const FIXTURES: Fixture[] = [
  { id: "c1-person-died", claimText: "A person really did die in a particular year.", sourceExcerpt: "A person really did die in a particular year.", role: "contentless", expect: "exclude" },
  { id: "c2-someone-award", claimText: "Someone won an award at some point.", sourceExcerpt: null, role: "contentless", expect: "exclude" },
  { id: "c3-city-disaster", claimText: "A city experienced a natural disaster once.", sourceExcerpt: null, role: "contentless", expect: "exclude" },
  { id: "c4-animal-discovered", claimText: "An animal was discovered by scientists.", sourceExcerpt: null, role: "contentless", expect: "exclude" },
  { id: "c5-company-profit", claimText: "A company reported a profit at some point.", sourceExcerpt: null, role: "contentless", expect: "exclude" },

  { id: "g1-computer-mice", claimText: "Historical computer mice were connected to computers by cables.", sourceExcerpt: null, role: "generic-class", expect: "keep" },
  { id: "g2-telephones", claimText: "Early telephones required an operator to connect calls.", sourceExcerpt: null, role: "generic-class", expect: "keep" },
  { id: "g3-castles", claimText: "Medieval castles were built with defensive stone walls.", sourceExcerpt: null, role: "generic-class", expect: "keep" },
  { id: "g4-vinyl", claimText: "Vinyl records are played using a needle that tracks a groove.", sourceExcerpt: null, role: "generic-class", expect: "keep" },
  { id: "g5-locomotives", claimText: "Steam locomotives burned coal to boil water into steam.", sourceExcerpt: null, role: "generic-class", expect: "keep" },
  { id: "g6-film-cameras", claimText: "Early film cameras recorded images onto rolls of celluloid.", sourceExcerpt: null, role: "generic-class", expect: "keep" },

  { id: "n1-apple-ipad", claimText: "Apple's iPad revenue was $6.2 billion in the fourth quarter.", sourceExcerpt: null, role: "named-referent", expect: "keep" },
  { id: "n2-wright", claimText: "The Wright brothers' first flight covered approximately 120 feet.", sourceExcerpt: null, role: "named-referent", expect: "keep" },
  { id: "n3-excerpt-resolves", claimText: "The company reported a profit in Q4.", sourceExcerpt: "Shopify closed out a strong year. The company reported a profit in Q4, its third consecutive profitable quarter.", role: "named-referent", expect: "keep" },

  { id: "d1-opinion", claimText: "SQL is more useful than NoSQL for most applications.", sourceExcerpt: null, role: "drift-control", expect: "exclude" },
  { id: "d2-prediction", claimText: "AI would eliminate most programming jobs within five years.", sourceExcerpt: null, role: "drift-control", expect: "exclude" },
];

// Each variant is a different STRATEGY for the same question, not a rewording. v1 is the live
// v1.1.0 block verbatim, kept as the control. D032 §13.
const VARIANTS: Array<{ id: string; strategy: string; block: string }> = [
  {
    id: "v1-baseline-common-noun",
    strategy: "CONTROL — the live v1.1.0 block, verbatim",
    block: `RESOLVABLE REFERENT — a separate question from everything above. Answer it independently.

"hasResolvableReferent" asks one thing: does the claim name, or uniquely identify, WHO or WHAT the assertion is about? Judge this from the CLAIM plus the SOURCE_EXCERPT only — not from whether some person somewhere could theoretically be identified.

- Common nouns are NOT referents. "a person", "someone", "a city", "an animal", "a company", "an official" name no one. A claim whose entire subject is a common noun has no resolvable referent — answer false.
- A referent named in the claim itself is resolvable: "Apple's Q4 revenue", "The Wright brothers' first flight", "Mount Everest".
- A referent the SOURCE_EXCERPT resolves is also resolvable: if the claim says "the company reported a profit" and the excerpt names the company, answer true. If the excerpt merely repeats the claim and adds no identifying context, it resolves nothing.
- This is INDEPENDENT of category and certainty. "uncertain" does not mean the referent is missing, and a "checkable" category does not mean a referent exists. A claim can be perfectly checkable in form and still be about nobody in particular — that is exactly the case this field exists to catch.
- When the subject is genuinely named but you simply do not know the entity, answer true. False means "the text does not say who/what", never "I do not recognise this name".`,
  },
  {
    id: "v2-falsifiability",
    strategy: "Falsifiability — what evidence would show this false?",
    block: `RESOLVABLE REFERENT — a separate question from everything above. Answer it independently.

"hasResolvableReferent" asks whether this claim could be REFUTED by evidence. Apply one test: can you describe a specific finding that would show the claim is false?

- If yes, answer true. "Historical computer mice were corded" is refuted by finding they were wireless. "Apple's Q4 revenue was $6.2 billion" is refuted by a different figure.
- If no evidence could ever refute it because ANY single instance makes it true, answer false. "A person died in a particular year" is true of every year and cannot be refuted. "Someone won an award" cannot be refuted.
- This has nothing to do with whether a proper name appears. General statements about a kind of thing are refutable and answer true.
- If you cannot name what would refute it, answer false.`,
  },
  {
    id: "v3-placeholder-vs-kind",
    strategy: "Explicit placeholder-vs-kind distinction",
    block: `RESOLVABLE REFERENT — a separate question from everything above. Answer it independently.

"hasResolvableReferent" distinguishes an INDEFINITE PLACEHOLDER from a GENERIC KIND.

- A placeholder is a blank the writer left empty: "a person", "someone", "a city", "a company", "an animal". The claim is about no particular thing and could mean any of them. Answer false.
- A generic kind is a real category with determinate properties: "computer mice", "medieval castles", "steam locomotives", "vinyl records". Claims about a kind are about that kind. Answer true.
- A named individual is obviously a referent: "Apple", "The Wright brothers", "Mount Everest". Answer true.
- If the SOURCE_EXCERPT names what a vague subject refers to, answer true.
- Grammatical form does not decide this. Both a placeholder and a kind are common nouns; the difference is whether the claim is about a determinate thing.`,
  },
  {
    id: "v4-existential-quantifier",
    strategy: "Existential-quantifier detection",
    block: `RESOLVABLE REFERENT — a separate question from everything above. Answer it independently.

"hasResolvableReferent" asks whether the claim asserts something about a DETERMINATE subject, or merely that SOME unspecified instance exists.

- If the claim only says "there exists some X that did Y" without saying which X, answer false. "A person really did die in a particular year", "Someone won an award", "A company reported a profit" are all bare existence claims.
- If the claim says something about a specific thing, or about a whole category, answer true. "Steam locomotives burned coal" is about all steam locomotives — determinate. "Apple's revenue" is about Apple — determinate.
- The test is whether swapping the subject for a different member of the same class would change what is being claimed. If it would not, the subject is not determinate.`,
  },
  {
    id: "v5-search-query",
    strategy: "Could you write a search query that settles it?",
    block: `RESOLVABLE REFERENT — a separate question from everything above. Answer it independently.

"hasResolvableReferent" asks whether you could write a search query that would settle this claim.

- If you can write a query whose results would confirm or refute it, answer true. "were early computer mice corded" is a real query. "Apple Q4 iPad revenue" is a real query.
- If any query you write would be meaningless because the claim names no particular subject, answer false. There is no useful query for "a person died in a particular year" — every year returns results, and none of them settle anything.
- Use the SOURCE_EXCERPT to fill in a vague subject if it names one.
- A query about a whole category is a real query. Do not answer false just because the subject is a general noun.`,
  },
  {
    id: "v6-negative-only",
    strategy: "Placeholder word list only, no generalisation",
    block: `RESOLVABLE REFERENT — a separate question from everything above. Answer it independently.

"hasResolvableReferent" is true by DEFAULT. Answer false only when the claim's subject is an indefinite placeholder.

Answer false only if the subject is one of these shapes:
- "a person", "a man", "a woman", "someone", "somebody", "an individual"
- "a company", "a business", "an organisation" with no name given
- "a city", "a country", "a place" with no name given
- "an animal", "a species", "an object" with no name given
- any subject introduced by "a"/"an"/"some" where the claim also declines to say which one

In every other case answer true — including claims about categories of things, historical periods, technologies, or any general kind. If the SOURCE_EXCERPT names the subject, answer true.`,
  },
  {
    id: "v7-determinate-set",
    strategy: "Does the subject pick out a determinate set?",
    block: `RESOLVABLE REFERENT — a separate question from everything above. Answer it independently.

"hasResolvableReferent" asks whether the subject picks out a DETERMINATE set of things in the world.

- "Steam locomotives" picks out a determinate set — all steam locomotives. Answer true.
- "Historical computer mice" picks out a determinate set. Answer true.
- "Apple" picks out one determinate thing. Answer true.
- "A person" picks out no set — it stands for any one of billions, and the claim does not say which. Answer false.
- "Someone", "a company", "a city" behave the same way. Answer false.
- The size of the set is irrelevant. A set of millions is still determinate; an unspecified single member is not.`,
  },
  {
    id: "v8-falsifiability-worked",
    strategy: "Falsifiability plus the worked contrast pair",
    block: `RESOLVABLE REFERENT — a separate question from everything above. Answer it independently.

"hasResolvableReferent" asks whether evidence could REFUTE this claim. Work through the contrast:

"Historical computer mice were connected by cables." To refute it you would show that historical mice were wireless. That is a real research finding. Answer TRUE.

"A person really did die in a particular year." To refute it you would have to show that in no year did any person die. Nothing could show that; the claim is satisfied by any death in any year. Answer FALSE.

Apply the same test to the claim below. If you can state what finding would refute it, answer true. If the claim is guaranteed true by the existence of any single instance, answer false. Whether the subject is a proper name or a general noun is irrelevant to this test.`,
  },
  {
    id: "v9-informativeness",
    strategy: "Does checking it teach the reader anything?",
    block: `RESOLVABLE REFERENT — a separate question from everything above. Answer it independently.

"hasResolvableReferent" asks whether checking this claim would tell a reader anything.

- If confirming it would inform the reader, answer true. Confirming that early computer mice were corded, or that Apple's revenue was $6.2 billion, tells them something.
- If the claim is so unspecific that confirming it tells the reader nothing they did not already know, answer false. Confirming "a person died in a particular year" or "someone won an award" conveys no information — it is trivially true.
- Claims about categories of things are informative and answer true.
- Use the SOURCE_EXCERPT to resolve a vague subject before judging.`,
  },
  {
    id: "v10-minimal",
    strategy: "Single sentence, no bullets",
    block: `RESOLVABLE REFERENT — a separate question from everything above. Answer it independently.

"hasResolvableReferent": answer false ONLY when the claim's subject is an unspecified stand-in ("a person", "someone", "a company", "a city") so that the claim is made true by any instance whatsoever and says nothing about any particular thing; answer true in every other case, including claims about whole categories or kinds of thing, and including any subject named in the CLAIM or resolved by the SOURCE_EXCERPT.`,
  },
];

function buildVariantPrompt(rendered: string, block: string): string {
  const start = rendered.indexOf(BLOCK_START);
  const end = rendered.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Cannot splice variant block — anchors not found in rendered eligibility prompt (start=${start}, end=${end})`);
  }
  return `${rendered.slice(0, start)}${block}\n\n${rendered.slice(end)}`;
}

export const evalT27bPromptVariantsJob = inngest.createFunction(
  { id: "eval-t27b-prompt-variants", name: "Experiment — T27b Eligibility Prompt Variants" },
  { event: "eval/t27b-prompt-variants" },
  async ({ event, step }) => {
    const repeats = Math.max(1, Math.min(5, Number(event.data?.repeats ?? 3)));
    const provider = new GeminiProvider();
    const prompts = new PromptRegistry();
    const historyStore = new DrizzleGrounnelHistoryStore();
    const llmCallStore = new DrizzleGrounnelLlmCallStore();

    // Ids minted INSIDE the step — a randomUUID() above it churns per Inngest replay and dangles the
    // grounnel_llm_calls FK. Cost a silent 0-row T27 run, 2026-08-31; see tasks.md T27.
    const { experimentRunId, claimIds } = await step.run("create-experiment-run", async () => {
      const runId = randomUUID();
      await historyStore.createRun({
        runId,
        sessionId: null,
        text: `[t27b-prompt-variants] ${VARIANTS.length} variants x ${FIXTURES.length} fixtures x ${repeats}`,
        source: "eval",
        maxClaims: FIXTURES.length,
        truncated: false,
      });
      const ids: Record<string, string> = {};
      for (const f of FIXTURES) ids[f.id] = randomUUID();
      return { experimentRunId: runId, claimIds: ids };
    });

    logger.info({ module: MODULE, variants: VARIANTS.length, fixtures: FIXTURES.length, repeats }, "Starting T27b prompt-variant screen");

    const perVariant = [];
    for (const variant of VARIANTS) {
      const perFixture: FixtureScore[] = [];
      for (const fixture of FIXTURES) {
        const claimId = claimIds[fixture.id]!;
        const results = [];
        for (let i = 0; i < repeats; i++) {
          const result = await step.run(`${variant.id}--${fixture.id}--${i + 1}`, async () => {
            const rendered = prompts.render("grounnel-eligibility", {
              claim_text: fixture.claimText,
              source_excerpt: fixture.sourceExcerpt ?? "(none)",
            });
            return await classifyClaimVerifiability(
              provider, prompts, llmCallStore, experimentRunId, claimId,
              { claimText: fixture.claimText, sourceExcerpt: fixture.sourceExcerpt },
              { text: buildVariantPrompt(rendered, variant.block), version: `t27b-${variant.id}` }
            );
          });
          results.push(result);
        }

        const jointMix: Record<string, number> = {};
        let excludedCount = 0;
        let referentFalseCount = 0;
        let failOpenCount = 0;
        for (const r of results) {
          jointMix[`${r.category}/${r.certainty}`] = (jointMix[`${r.category}/${r.certainty}`] ?? 0) + 1;
          if (isEligibilityExcluded(r)) excludedCount++;
          if (r.hasResolvableReferent === false) referentFalseCount++;
          if (r.reason === FAIL_OPEN_REASON) failOpenCount++;
        }
        perFixture.push({ id: fixture.id, role: fixture.role, expect: fixture.expect, excludedCount, referentFalseCount, failOpenCount, jointMix });
      }

      const byRole = (role: Role) => perFixture.filter((f) => f.role === role);
      const sum = (rows: typeof perFixture, k: "excludedCount" | "failOpenCount") => rows.reduce((a, f) => a + f[k], 0);

      // Hard gate: a true claim wrongly dropped. Generic-class is the shape v1.1.0 fails on.
      const falseExclusions = sum(byRole("generic-class"), "excludedCount") + sum(byRole("named-referent"), "excludedCount");
      const contentlessExcluded = sum(byRole("contentless"), "excludedCount");
      const contentlessTotal = byRole("contentless").length * repeats;
      const failOpen = sum(perFixture, "failOpenCount");

      const verdict =
        falseExclusions > 0
          ? `FAIL — ${falseExclusions} false exclusion(s)`
          : contentlessExcluded / contentlessTotal >= 0.9
            ? "PASS"
            : `INCONCLUSIVE — contentless ${contentlessExcluded}/${contentlessTotal}`;

      perVariant.push({
        id: variant.id,
        strategy: variant.strategy,
        falseExclusions,
        genericExcluded: sum(byRole("generic-class"), "excludedCount"),
        namedExcluded: sum(byRole("named-referent"), "excludedCount"),
        contentlessExcluded,
        contentlessTotal,
        driftExcluded: sum(byRole("drift-control"), "excludedCount"),
        failOpen,
        verdict,
        perFixture,
      });
      logger.info({ module: MODULE, variant: variant.id, verdict, falseExclusions, contentlessExcluded }, "T27b variant scored");
    }

    const ranked = [...perVariant].sort((a, b) => a.falseExclusions - b.falseExclusions || b.contentlessExcluded - a.contentlessExcluded);
    logger.info({ module: MODULE, winner: ranked[0]?.id, ranked: ranked.map((v) => ({ id: v.id, verdict: v.verdict })) }, "T27b prompt-variant screen complete");

    return { repeats, ranked };
  }
);
