/**
 * spec 014 T018 — test plan.md option 2: does naming the asserted fact BEFORE the verdict fix the
 * reporting class? T016 showed isolation does not: sources A and B each return `contradicted` alone.
 *
 * The lever is field ORDER, not wording. Gemini generates in schema order (T27/T21), so a field
 * declared after `verdict` cannot shape it. Three schemas, identical prompt, identical fixtures:
 *   verdict-first   (production today)  -> baseline, expected `contradicted`
 *   reason-first    (spec 013 T22)      -> does forcing reasoning first help on its own?
 *   predicate-first (new)               -> assertedPredicate + selectedSentence before verdict
 *
 * PRE-REGISTERED PASS BAR, fixed before any result is seen:
 *   ISO-A0-A and ISO-A0-B must stop returning `contradicted` — they are false accusations on a
 *   claim about what social media posts SAID. Anything non-`contradicted` is a pass for them.
 *   ISO-A0-C must STAY `supported` (it is already correct; a schema change must not break it).
 *   N4-real-conflict must STAY `contradicted` (a genuine contradiction must remain reachable).
 * A variant that fixes A/B by making contradiction unreachable is refuted, not a winner.
 *
 * Usage: npx tsx --env-file=.env scripts/s014-t018-trigger-schema-order.ts [--repeats 3] [--dry-run]
 */
import { readFileSync } from "node:fs";
import { inngest } from "../src/jobs/client.js";

const args = process.argv.slice(2);
const repeats = (() => { const i = args.indexOf("--repeats"); return i !== -1 && args[i + 1] ? Number(args[i + 1]) : 3; })();
const only = (() => { const i = args.indexOf("--schema"); return i !== -1 ? args[i + 1] : undefined; })();

const pooled = JSON.parse(readFileSync("specs/014-verify-negated-claim-polarity/pooled-fixtures.json", "utf8")) as Array<{
  key: string; claim: string; passage_sentences: Record<string, Array<{ n: number; text: string }>>;
}>;
const caseA = pooled.find((p) => p.key === "r1-pooled")!;

const CLAIM = "The Pentagon has not issued an official finding on the Minab strike.";
const CONCLUDED = "The Pentagon officially concluded that the strike destroyed a military radar installation.";

// The three isolated Case A sources (the rows isolation could not fix) plus the over-correction guard.
const fixtures = [
  ...Object.entries(caseA.passage_sentences).map(([label, sents]) => ({
    id: `ISO-A0-${label}`, role: "reporting" as const, claim: caseA.claim,
    passages: { [label]: sents }, expect: label === "C" ? "supported" : "unsupported", relationship: "SAME" as const,
  })),
  { id: "N4-real-conflict", role: "control" as const, claim: CLAIM,
    passages: { A: [{ n: 1, text: CONCLUDED }] }, expect: "contradicted", relationship: "CONFLICT" as const },
];

const SCHEMAS = ["verdict-first", "reason-first", "predicate-first"] as const;
const schemas = only ? SCHEMAS.filter((s) => s === only) : SCHEMAS;

async function main() {
  const calls = schemas.length * fixtures.length * repeats;
  console.log(`014 T018 schema-order test — ${schemas.length} schemas x ${fixtures.length} fixtures x ${repeats} = ${calls} calls\n`);
  console.log("  baseline from T016 (verdict-first, combined and isolated):");
  console.log("    ISO-A0-A contradicted 3/3   ISO-A0-B contradicted 3/3   ISO-A0-C supported 3/3\n");
  console.log("  PASS: A and B stop being `contradicted`; C stays `supported`; N4 stays `contradicted`.");
  if (args.includes("--dry-run")) { console.log("\n--dry-run: nothing sent."); return; }

  for (const schemaVariant of schemas) {
    const variants = [{ id: `sch-${schemaVariant}-${Date.now().toString().slice(-4)}`, strategy: `schema=${schemaVariant}`, blocks: [] as string[] }];
    const r = await inngest.send({ name: "eval/negation-polarity", data: { repeats, fixtures, variants, schemaVariant } });
    console.log(`✓ ${schemaVariant.padEnd(16)} triggered: ${r.ids.join(", ")}  variant=${variants[0]!.id}`);
  }
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
