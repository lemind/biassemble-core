/**
 * spec 014 T016 — test plan.md option 1 (STEP 1 isolation) against the reproducing failures.
 *
 * T015 showed every source is labelled correctly ALONE and wrongly when COMBINED. This asks the
 * direct follow-up: if VERIFY sees one source at a time, does a fixed merge rule recover the right
 * answer on the rows that fail combined, WITHOUT breaking the rows that pass?
 *
 * MERGE RULE — pre-registered here before any result is seen, and not to be edited afterwards:
 *   1. any source `contradicted`      -> contradicted
 *   2. else any `supported`           -> supported
 *   3. else any `partially_supported` -> partially_supported
 *   4. else                           -> unsupported
 * Rule 1 is deliberately first and deliberately unsafe-looking: a merge that could not produce a
 * contradiction would trivially "fix" false accusations by making them impossible, which is not a
 * fix. N4 and A0 exist to make rule 1 earn its place.
 *
 * Usage: npx tsx --env-file=.env scripts/s014-t016-trigger-isolation.ts [--repeats 3] [--dry-run]
 */
import { readFileSync } from "node:fs";
import { inngest } from "../src/jobs/client.js";

const args = process.argv.slice(2);
const repeats = (() => { const i = args.indexOf("--repeats"); return i !== -1 && args[i + 1] ? Number(args[i + 1]) : 3; })();

const CLAIM = "The Pentagon has not issued an official finding on the Minab strike.";
const REMAINS_B = "the 25 Senators urged the swift release of the Pentagon's investigation into the school strike, which was reportedly submitted in April, but remains under review by senior officials";
const s = (...t: string[]) => t.map((text, i) => ({ n: i + 1, text }));

// N1 (C alone) and N2 (A alone) already ran in T015 — unsupported and supported. Only B is missing.
const negation = [
  { id: "ISO-N2b-senators", claim: CLAIM, passages: { B: s(REMAINS_B) } },
];

// Case A decomposed: the reporting failure combined all three. Isolate each.
const pooled = JSON.parse(readFileSync("specs/014-verify-negated-claim-polarity/pooled-fixtures.json", "utf8")) as Array<{
  key: string; claim: string; passage_sentences: Record<string, Array<{ n: number; text: string }>>;
}>;
const caseA = pooled.find((p) => p.key === "r1-pooled")!;
const caseAIsolated = Object.entries(caseA.passage_sentences).map(([label, sents]) => ({
  id: `ISO-A0-${label}`, claim: caseA.claim, passages: { [label]: sents },
}));

const all = [...negation, ...caseAIsolated].map((f) => ({
  id: f.id, role: "negation" as const, claim: f.claim, passages: f.passages,
  // expect is unused by the kill criterion here — the question is what isolation PRODUCES, which is
  // then fed to the pre-registered merge rule. Set to the ideal so exact-match stays informative.
  expect: "supported", relationship: "PARTIAL" as const,
}));

const variants = [{ id: `iso-v0-control-${Date.now().toString().slice(-4)}`, strategy: "live 4.6.0, one source per call", blocks: [] as string[] }];

async function main() {
  console.log(`014 T016 isolation test — ${all.length} fixtures x ${repeats} = ${all.length * repeats} calls\n`);
  for (const f of all) console.log(`  ${f.id.padEnd(20)} sources=${Object.keys(f.passages).join(",")}`);
  console.log(`\nCombined baselines already measured (T014/T015):`);
  console.log(`  N3 (A+B+C)  -> contradicted 3/3  [FALSE ACCUSATION]`);
  console.log(`  A0 (A+B+C)  -> contradicted 3/3  [reproduces live ed8b3a37]`);
  console.log(`  N1 (C only) -> unsupported 3/3   N2 (A only) -> supported 3/3`);
  console.log(`\nPASS if the merge rule yields a non-contradicted result for N3's sources AND still`);
  console.log(`yields contradicted wherever a contradiction is genuine (N4 already contradicted alone).`);
  if (args.includes("--dry-run")) { console.log("\n--dry-run: nothing sent."); return; }
  const r = await inngest.send({ name: "eval/negation-polarity", data: { repeats, fixtures: all, variants } });
  console.log(`\n✓ triggered: ${r.ids.join(", ")}  variant=${variants[0]!.id}`);
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
