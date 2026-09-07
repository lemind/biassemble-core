/**
 * Wright-brothers selector screen (D030 §3m Addendum 16) — two instruments, screened separately.
 *
 * Fixtures are REAL persisted VERIFY payloads, not hand-written sentences: the earlier pinned
 * fixtures were too clean (2 tidy sentences vs the real trim carrying 120/175/200 ft distractors
 * and site boilerplate), which is why they scored 3/3 where production scores 1/12.
 *
 * Arm A varies the VERIFY prompt; arm B varies the attribution scaffold. Never both at once — a
 * combined win cannot be attributed, and either could mint a false accusation on the g22 control.
 *
 * Usage: npx tsx --env-file=.env scripts/trigger-wright-screen.ts --arm verify|attribution|distractor [--repeats 3] [--dry-run]
 */
import { sql } from "drizzle-orm";
import { inngest } from "../src/jobs/client.js";
import { getDb } from "../src/db/config.js";

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(`--${k}`); return i !== -1 ? args[i + 1] : undefined; };
const arm = arg("arm");
const repeats = Number(arg("repeats") ?? 3);
const dry = args.includes("--dry-run");

/** g17: FALSE — 852 ft belongs to the fourth flight. g22: TRUE — the control that must never move. */
const FALSE_CLAIM = "The first flight covered 852 feet.";
const TRUE_CLAIM = "The fourth and final flight that day covered 852 feet.";

/** Deliberately NOT a fifth relationship — the STEP 3 mapping and every downstream gate assume the
 * existing four. The last paragraph is the g22 control: same member, two labels, still SAME. */
const SELECTOR_CONFLICT = `INSTANCE SELECTOR — when the claim picks one member of a repeated set (first / second / third / fourth / last / final, "the Nth ..."), that ordinal or position is part of the asserted fact, not decoration.

A passage that states the same measure, period and subject family but attributes the claimed value to a DIFFERENT identified member is CONFLICT, not SAME. The same number for a different flight/trial/take is not support.

A passage that states the measure with NO member, or only a rank or superlative ("the longest", "the record") that it does not explicitly identify with the claim's member, is ABSENT — not CONFLICT.

Do not treat "fourth" and "final"/"last" as different members when the passage presents them as the same one. Those are one member with two labels.`;

/** Weaker fallback: PARTIAL instead of CONFLICT. Cannot mint a contradiction at all, so it is the
 * option to fall back to if the CONFLICT form false-accuses the g22 control. */
const SELECTOR_PARTIAL = SELECTOR_CONFLICT.replace(
  "attributes the claimed value to a DIFFERENT identified member is CONFLICT, not SAME",
  "attributes the claimed value to a DIFFERENT identified member is PARTIAL, not SAME"
);

/** Scaffold, not definitions — four rewrites of the ANSWER LIST were already refuted (Addendum 11).
 * This forces an explicit other-member branch so "not the claim's member" cannot fall to `absent`. */
const MEMBER_COMPARISON = `BEFORE ANSWERING, do an explicit member comparison and put it in "working":
1. Quote every passage sentence that states the FACT.
2. For each, write the member THAT SENTENCE names — or "unnamed" / "rank-only". Determine it independently, before looking at the claim.
3. Write the member the CLAIM selects.
4. Compare the two labels:
   - the sentence names the claim's member (or the passage equates them) -> "same"
   - the sentence names a DIFFERENT identified member -> "different"
   - only "unnamed" or "rank-only" -> "absent"
   - two sentences explicitly name different members -> "conflict"
Do not answer "absent" merely because a sentence is not about the claim's member: if any sentence explicitly attributes the FACT to another identified member, that is "different". A rank or superlative is not a member unless the passage identifies which member it describes.`;

type Sentences = Record<string, Array<{ n: number; text: string }>>;

/** Two DISTINCT real payloads — one clean, one boilerplate-heavy, so a variant cannot pass by
 * fitting a single retrieval shape. */
async function realPayloads(limit: number): Promise<Sentences[]> {
  const db = getDb();
  const r = (await db.execute(sql`
    SELECT l.input_payload AS p
    FROM grounnel.grounnel_runs r
    JOIN grounnel.grounnel_llm_calls l ON l.run_id = r.run_id
    WHERE r.source='eval' AND r.text LIKE 'On December 17, 1903%'
      AND l.stage='verify' AND l.input_payload IS NOT NULL
      AND l.created_at > '2026-09-04 12:18:00+00'::timestamptz
    ORDER BY l.created_at DESC LIMIT ${limit}`)) as unknown as { rows?: Array<{ p: unknown }> } | Array<{ p: unknown }>;
  const rows = Array.isArray(r) ? r : (r.rows ?? []);
  const out: Sentences[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const p = row.p as Record<string, unknown> | unknown[];
    const pairs = Array.isArray(p) ? p : ((p as Record<string, unknown>)?.pairs ?? (p as Record<string, unknown>)?.claim_passage_pairs ?? []);
    const first = Array.isArray(pairs) ? pairs[0] : pairs;
    const ps = (first as Record<string, unknown> | undefined)?.passage_sentences as Sentences | undefined;
    if (!ps || Object.keys(ps).length === 0) continue;
    const key = JSON.stringify(ps).slice(0, 400);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ps);
    if (out.length === 2) break;
  }
  return out;
}

async function main() {
  if (arm !== "verify" && arm !== "attribution" && arm !== "distractor") {
    console.error("--arm must be `verify`, `attribution` or `distractor`");
    process.exit(1);
  }
  const ps = await realPayloads(40);
  if (ps.length < 2) { console.error(`need 2 distinct real payloads, found ${ps.length}`); process.exit(1); }
  const shape = ps.map((p) => `${Object.keys(p).length} sources / ${Object.values(p).flat().length} sentences`).join("  |  ");

  if (arm === "verify") {
    // `role` drives the harness headline: a failing `control` row is the kill criterion.
    const fixtures = ps.flatMap((passages, i) => [
      { id: `w${i + 1}-false-ordinal`, role: "negation", claim: FALSE_CLAIM, passages, expect: "contradicted" },
      { id: `w${i + 1}-true-ordinal`, role: "control", claim: TRUE_CLAIM, passages, expect: "supported" },
    ]);
    const variants = [
      { id: "control", strategy: "current VERIFY prompt, unmodified", blocks: [] as string[] },
      { id: "selector-conflict", strategy: "selector mismatch is CONFLICT", blocks: [SELECTOR_CONFLICT] },
      { id: "selector-partial", strategy: "selector mismatch is PARTIAL (safe fallback)", blocks: [SELECTOR_PARTIAL] },
    ];
    console.log("ARM A — VERIFY selector rule");
    console.log(`  ${variants.length} variants x ${fixtures.length} fixtures x ${repeats} = ${variants.length * fixtures.length * repeats} Gemini calls`);
    console.log(`  real payloads: ${shape}`);
    console.log("  PASS: *-false-ordinal -> contradicted.  KILL: any *-true-ordinal leaving supported.");
    console.log("  FIRST CHECK the control variant reproduces the production failure — if it does not, the fixtures are wrong and every variant result is noise.\n");
    if (dry) { console.log("--dry-run: nothing sent."); return; }
    const r = await inngest.send({ name: "eval/negation-polarity", data: { repeats, fixtures, variants } });
    console.log(`✓ triggered: ${r.ids.join(", ")}`);
    return;
  }

  if (arm === "distractor") {
    // ONE question: is the first+852 co-mention sufficient to force `absent`? The payload that
    // answered `absent` in arm B carries "Their final flight of the day bested their FIRST try by
    // traveling 852 ft" — a sentence naming the claim's selector next to the claimed value.
    // Nothing is killed here; both rows are observations, not pass/fail.
    const target = ps[1]!;
    const isDistractor = (t: string) => /\bfirst\b/i.test(t) && t.includes("852");
    const asIs = Object.values(target).map((sents) => sents.map((s) => s.text).join(" "));
    const dropped: string[] = [];
    const without = Object.values(target).map((sents) =>
      sents.filter((s) => { if (isDistractor(s.text)) { dropped.push(s.text); return false; } return true; })
        .map((s) => s.text).join(" ")
    );
    if (dropped.length === 0) { console.error("no first+852 sentence in this payload — nothing to test"); process.exit(1); }
    const fixtures = [
      { id: "d-with-distractor", kind: "target", control: "absent", claim: FALSE_CLAIM, stripFact: true, value: "852", passages: asIs },
      { id: "d-without-distractor", kind: "target", control: "absent", claim: FALSE_CLAIM, stripFact: true, value: "852", passages: without },
    ];
    const variants = [{ id: "control", block: "" }];
    console.log("DISTRACTOR TEST — same payload, same prompt, one sentence in vs out");
    console.log(`  ${variants.length} variant x ${fixtures.length} fixtures x ${repeats} = ${variants.length * fixtures.length * repeats} Gemini calls`);
    console.log(`  removed ${dropped.length} sentence(s):`);
    for (const d of dropped) console.log(`    - ${d.slice(0, 110)}`);
    console.log("  IF removing it flips `absent` -> `different`, the residual miss is retrieval/selection, not wording.");
    console.log("  IF it stays `absent`, the residual class is real and no prompt reaches it.\n");
    if (dry) { console.log("--dry-run: nothing sent."); return; }
    const r = await inngest.send({ name: "eval/attribution-prompt", data: { repeats, fixtures, variants } });
    console.log(`✓ triggered: ${r.ids.join(", ")}`);
    return;
  }

  const fixtures = ps.flatMap((p, i) => {
    const passages = Object.values(p).map((sents) => sents.map((s) => s.text).join(" "));
    return [
      { id: `w${i + 1}-false-ordinal`, kind: "target", control: "absent", claim: FALSE_CLAIM, stripFact: true, value: "852", passages },
      { id: `t-w${i + 1}-true-ordinal`, kind: "control", control: "same", claim: TRUE_CLAIM, stripFact: true, value: "852", passages },
    ];
  });
  const variants = [
    { id: "control", block: "" },
    { id: "member-comparison", block: MEMBER_COMPARISON },
  ];
  console.log("ARM B — attribution scaffold, with `fact` ALREADY stripped");
  console.log("  (the Addendum 11 screen tested wordings against the FUSED fact — the wrong input)");
  console.log(`  ${variants.length} variants x ${fixtures.length} fixtures x ${repeats} = ${variants.length * fixtures.length * repeats} Gemini calls`);
  console.log(`  real payloads: ${shape}`);
  console.log("  PASS: *-false-ordinal -> different.  KILL: any t-* leaving its control answer.\n");
  if (dry) { console.log("--dry-run: nothing sent."); return; }
  const r = await inngest.send({ name: "eval/attribution-prompt", data: { repeats, fixtures, variants } });
  console.log(`✓ triggered: ${r.ids.join(", ")}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e.message || e); process.exit(1); });
