/**
 * spec 014 T015 — screen the negation CLASS with constructed bundles. No clone: 68da8ff4's live
 * VERIFY input was never persisted (no prompt column on grounnel_llm_calls), so the exact batch is
 * unrecoverable. Sentences come from incident-9a784003.json, frozen at T001.
 *
 * Scoring is TWO-TIER and the tiers are not equivalent:
 *   - illegal-set violation  = the KILL criterion (a false accusation on this class)
 *   - exact-label match      = informational only. T011 measured `partially_supported` at 9/228
 *     cells (4%), so an exact-match bar would fail by construction and prove nothing.
 *
 * Usage: npx tsx --env-file=.env scripts/s014-t015-trigger-class-screen.ts [--repeats 3] [--dry-run]
 */
import { readFileSync } from "node:fs";
import { inngest } from "../src/jobs/client.js";

const args = process.argv.slice(2);
const repeats = (() => { const i = args.indexOf("--repeats"); return i !== -1 && args[i + 1] ? Number(args[i + 1]) : 3; })();

const CLAIM = "The Pentagon has not issued an official finding on the Minab strike.";
// Verbatim from incident-9a784003.json (T001 freeze).
const UNDER_INVESTIGATION = 'The Pentagon said in a five-word statement to the Guardian: "The incident is under investigation."';
const REMAINS_A = "the Pentagon's investigation into the school strike, which was reportedly submitted in April, but remains under review by senior military officials";
const REMAINS_B = "the 25 Senators urged the swift release of the Pentagon's investigation into the school strike, which was reportedly submitted in April, but remains under review by senior officials";
const CONCLUDED = "The Pentagon officially concluded that the strike destroyed a military radar installation.";
// Off-topic but same-domain sentences, to test whether the class survives realistic context rather
// than only clean pairs (T011 Finding 6: isolated fixtures ran 49% `contradicted`).
const NOISE = [
  "People attend the funeral of the victims following a reported strike on a school in Minab, Iran.",
  "Bellingcat matched buildings, water towers and roads from the video with satellite images of the area.",
  "Sources told CNN that the use of classification power has grown to unprecedented levels.",
];

const s = (...t: string[]) => t.map((text, i) => ({ n: i + 1, text }));

const fixtures = [
  { id: "N1-weak-investigating", claim: CLAIM, passages: { C: s(UNDER_INVESTIGATION) },
    expect: "partially_supported", illegal: ["contradicted"], note: "weaker affirmative only" },
  { id: "N2-weak-under-review", claim: CLAIM, passages: { A: s(REMAINS_A) },
    expect: "partially_supported", illegal: ["contradicted"], note: "the higher-ranked sentence VERIFY ignored live" },
  { id: "N3-live-shaped", claim: CLAIM, passages: { A: s(REMAINS_A), B: s(REMAINS_B), C: s(UNDER_INVESTIGATION) },
    expect: "partially_supported", illegal: ["contradicted"], note: "all three weaker sentences, live-shaped" },
  { id: "N3-noisy", claim: CLAIM, passages: { A: s(REMAINS_A, NOISE[0]!), B: s(NOISE[1]!, REMAINS_B), C: s(NOISE[2]!, UNDER_INVESTIGATION) },
    expect: "partially_supported", illegal: ["contradicted"], note: "same as N3 plus distractors" },
  { id: "N4-real-conflict", claim: CLAIM, passages: { A: s(CONCLUDED) },
    expect: "contradicted", illegal: ["supported", "partially_supported"], note: "over-correction guard" },
];

// A0 — the known-good control. Its live bundle DID reproduce (T014), so if it stops reproducing the
// harness is broken and no N-row result is interpretable.
const pooled = JSON.parse(readFileSync("specs/014-verify-negated-claim-polarity/pooled-fixtures.json", "utf8")) as Array<{
  key: string; claim: string; live_verdict: string; passage_sentences: Record<string, unknown>;
}>;
const caseA = pooled.find((p) => p.key === "r1-pooled")!;
const all = [
  ...fixtures.map((f) => ({ id: f.id, role: "negation" as const, claim: f.claim, passages: f.passages, expect: f.expect, relationship: "PARTIAL" as const })),
  { id: "A0-harness-control", role: "reporting" as const, claim: caseA.claim, passages: caseA.passage_sentences, expect: caseA.live_verdict, relationship: "CONFLICT" as const },
];

// Control only on this trigger. The first question is what 4.6.0 does to the class — splicing a
// block before knowing that would confound the answer with the thing being tested.
const variants = [{ id: `class-v0-control-${Date.now().toString().slice(-4)}`, strategy: "live 4.6.0, no block spliced", blocks: [] as string[] }];

async function main() {
  console.log(`014 T015 class screen — ${variants.length} variant x ${all.length} fixtures x ${repeats} = ${variants.length * all.length * repeats} calls\n`);
  for (const f of fixtures) console.log(`  ${f.id.padEnd(22)} expect=${f.expect.padEnd(20)} ILLEGAL=${f.illegal.join("|")}  (${f.note})`);
  console.log(`  ${"A0-harness-control".padEnd(22)} expect=${caseA.live_verdict} — harness sanity, not a product pass\n`);
  console.log("KILL: any illegal verdict on N1-N4. A0 not reproducing => harness broken, ignore N rows.");
  if (args.includes("--dry-run")) { console.log("\n--dry-run: nothing sent."); return; }
  const r = await inngest.send({ name: "eval/negation-polarity", data: { repeats, fixtures: all, variants } });
  console.log(`\n✓ triggered: ${r.ids.join(", ")}  variant=${variants[0]!.id}`);
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
