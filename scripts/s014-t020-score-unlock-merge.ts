/**
 * spec 014 T020 — score the UNLOCK merge on data already collected. ZERO Gemini calls.
 *
 * Replaces the "any contradicted wins" merge, which two reviews independently refuted: on Defect B
 * both isolated sources return `contradicted`, so that rule would have RATIFIED a false accusation
 * rather than fixed one.
 *
 * UNLOCK MERGE (downgrade-only, pre-registered here):
 *   Second stage runs ONLY when the bundle verdict is `contradicted` AND the claim carries a
 *   negation cue.
 *     - if NO isolated source is `contradicted` -> release to the strongest non-accusation
 *       (supported > partially_supported > unsupported). This is the Defect A signature.
 *     - if ANY isolated source is `contradicted` -> KEEP the bundle `contradicted`, unchanged.
 *   The rule can never create an accusation, only release one. That is the whole safety argument.
 *
 * Also reports the contradiction-emergence rate: P(bundle contradicted AND no single source
 * contradicted), the direct measurement of the aggregation mechanism.
 *
 * Usage: npx tsx --env-file=.env scripts/s014-t020-score-unlock-merge.ts
 */
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config";
import { containsNegationCue } from "../src/orchestrators/grounnel/gates-shared";

type V = string;
const RANK: Record<string, number> = { supported: 3, partially_supported: 2, unsupported: 1 };

/** Decompositions measured in T015/T016: bundle verdict plus each source verified alone. */
const BUNDLES = [
  {
    name: "Defect A — negation (Minab)",
    claim: "The Pentagon has not issued an official finding on the Minab strike.",
    bundleFixture: "N3-live-shaped",
    singles: { A: "N2-weak-under-review", B: "ISO-N2b-senators", C: "N1-weak-investigating" },
    trueClaim: true,
  },
  {
    name: "Defect B — reporting (Rochester)",
    claim: "Social media posts claimed the University of Rochester announced it will cut academic ties with Israel.",
    bundleFixture: "A0-harness-control",
    singles: { A: "ISO-A0-A", B: "ISO-A0-B", C: "ISO-A0-C" },
    trueClaim: true,
  },
];

function unlockMerge(bundle: V, singles: V[], claim: string): { verdict: V; fired: boolean; why: string } {
  if (bundle !== "contradicted") return { verdict: bundle, fired: false, why: "bundle not contradicted — second stage skipped" };
  if (!containsNegationCue(claim)) return { verdict: bundle, fired: false, why: "no negation cue — second stage skipped" };
  if (singles.some((v) => v === "contradicted")) {
    return { verdict: "contradicted", fired: true, why: "an isolated source contradicts — kept, never released" };
  }
  const best = [...singles].sort((a, b) => (RANK[b] ?? 0) - (RANK[a] ?? 0))[0] ?? "unsupported";
  return { verdict: best, fired: true, why: "no isolated source contradicts — released (Defect A signature)" };
}

async function main() {
  const db = getDb();
  const q = async (s: ReturnType<typeof sql>) => {
    const r = (await db.execute(s)) as unknown as Record<string, unknown>[] | { rows: Record<string, unknown>[] };
    return Array.isArray(r) ? r : r.rows;
  };

  const rows = await q(sql`
    SELECT parsed_output->'results'->0->>'id' AS fx,
           parsed_output->'results'->0->>'verdict' AS v, count(*)::int AS c
    FROM grounnel.grounnel_llm_calls
    WHERE (prompt_version LIKE 'neg-class-v0%' OR prompt_version LIKE 'neg-iso-v0%') AND status = 'success'
    GROUP BY 1, 2
  `);
  const majority = (fx: string): V | null => {
    const mine = rows.filter((r) => r.fx === fx).sort((a, b) => Number(b.c) - Number(a.c));
    return mine.length ? String(mine[0]!.v) : null;
  };

  console.log("=== UNLOCK MERGE, scored on already-collected data (0 Gemini calls) ===\n");
  let emergence = 0;
  for (const b of BUNDLES) {
    const bundle = majority(b.bundleFixture);
    const singles = Object.entries(b.singles).map(([label, fx]) => ({ label, v: majority(fx) }));
    if (!bundle || singles.some((s) => !s.v)) { console.log(`${b.name}: missing data, skipped`); continue; }
    const vals = singles.map((s) => s.v!) as V[];
    const isEmergent = bundle === "contradicted" && !vals.includes("contradicted");
    if (isEmergent) emergence++;
    const merged = unlockMerge(bundle, vals, b.claim);

    console.log(b.name);
    console.log(`  claim negation cue : ${containsNegationCue(b.claim)}`);
    console.log(`  singles            : ${singles.map((s) => `${s.label}=${s.v}`).join("  ")}`);
    console.log(`  bundle             : ${bundle}`);
    console.log(`  emergent contradiction (bundle contradicted, no single contradicted): ${isEmergent}`);
    console.log(`  UNLOCK MERGE       : ${merged.verdict}  [fired=${merged.fired}] ${merged.why}`);
    const before = bundle === "contradicted" && b.trueClaim ? "FALSE ACCUSATION" : "ok";
    const after = merged.verdict === "contradicted" && b.trueClaim ? "FALSE ACCUSATION" : "ok";
    console.log(`  before -> after    : ${before} -> ${after}\n`);
  }
  console.log(`contradiction-emergence rate on measured bundles: ${emergence}/${BUNDLES.length}\n`);

  // Denominator: how much production traffic would the second stage actually touch?
  const all = await q(sql`
    SELECT c.claim_text FROM grounnel.grounnel_claims c WHERE c.verdict = 'contradicted'
  `);
  const negated = all.filter((r) => containsNegationCue(String(r.claim_text)));
  const total = await q(sql`SELECT count(*)::int AS n FROM grounnel.grounnel_claims`);
  console.log("=== SECOND-STAGE COST DENOMINATOR (production history) ===");
  console.log(`  contradicted claims                 : ${all.length}`);
  console.log(`  ...carrying a negation cue          : ${negated.length}  (${((negated.length / (all.length || 1)) * 100).toFixed(1)}% of contradicted)`);
  console.log(`  all claims                          : ${total[0]!.n}`);
  console.log(`  share of ALL claims hitting stage 2 : ${((negated.length / Number(total[0]!.n)) * 100).toFixed(3)}%`);
  console.log(`  extra VERIFY calls, whole history   : ~${negated.length * 3} (3 isolated calls each)`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
