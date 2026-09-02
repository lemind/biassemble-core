/**
 * spec 015 T003 — size the affirmation-evidence floor (G2) before shipping it.
 * Zero API cost: reads persisted telemetry only.
 *
 * Two numbers matter:
 *   1. How many affirmative verdicts shipped with NO evidence at all (the hard contract violation).
 *   2. How many carry MULTI-FRAGMENT evidence (" ... " joins across sources) — the population at
 *      risk if the `evidence_not_grounded` branch is enabled, since evidenceMatchesPassage requires
 *      EVERY fragment to appear in passageText.
 *
 * Usage: npx tsx --env-file=.env scripts/s015-t003-census-affirmation-evidence.ts
 */
import { getDb } from "../src/db/config";
import { grounnelClaims } from "../src/db/schema";
import { inArray } from "drizzle-orm";

const ELLIPSIS = /\s\.\.\.\s|\s…\s/;

async function main() {
  const db = getDb();
  const rows = await db.select().from(grounnelClaims).where(inArray(grounnelClaims.verdict, ["supported", "partially_supported"]));

  const nullEvidence = rows.filter((c) => !c.evidence?.trim());
  const multiFragment = rows.filter((c) => c.evidence?.trim() && ELLIPSIS.test(c.evidence));
  const singleFragment = rows.filter((c) => c.evidence?.trim() && !ELLIPSIS.test(c.evidence));

  console.log("=== AFFIRMATIVE VERDICTS ===");
  console.log("supported + partially_supported total:", rows.length);
  console.log("");
  console.log("A. evidence null/blank  (G2 evidence_null branch fires) :", nullEvidence.length,
    "(" + ((nullEvidence.length / rows.length) * 100).toFixed(2) + "%)");
  console.log("B. single-fragment evidence                            :", singleFragment.length);
  console.log("C. multi-fragment evidence (' ... ' join across sources):", multiFragment.length,
    "(" + ((multiFragment.length / rows.length) * 100).toFixed(2) + "%)  <-- at risk from evidence_not_grounded");

  console.log("\n=== A: the null-evidence rows (all of them) ===");
  for (const c of nullEvidence) {
    console.log(`  ${c.runId.slice(0, 8)}  ${c.claimId.slice(0, 8)}  [${c.verdict}]  ${c.claimText.slice(0, 90)}`);
  }

  console.log("\n=== C: sample of multi-fragment rows ===");
  for (const c of multiFragment.slice(0, 5)) {
    console.log(`  ${c.claimId.slice(0, 8)}  fragments=${c.evidence!.split(ELLIPSIS).length}  ${c.claimText.slice(0, 70)}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
