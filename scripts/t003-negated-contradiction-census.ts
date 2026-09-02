/**
 * spec 014 T003 — census of `contradicted` verdicts on NEGATED claims, to size the
 * weaker-affirmative mislabel class. Zero API cost: reads persisted telemetry only.
 *
 * Usage: npx tsx --env-file=.env scripts/t003-negated-contradiction-census.ts
 */
import { getDb } from "../src/db/config";
import { grounnelClaims } from "../src/db/schema";
import { eq, sql } from "drizzle-orm";

// Negation markers. Deliberately broad — every hit is hand-labelled below, so recall beats precision.
const NEGATION_RE =
  /\b(?:not|never|no longer|has yet to|have yet to|had yet to|failed to|did not|does not|do not|was not|were not|is not|are not|cannot|hasn't|haven't|hadn't|didn't|doesn't|don't|wasn't|weren't|isn't|aren't|can't|won't|no)\b/i;

async function main() {
  const db = getDb();

  const total = await db.select({ n: sql<number>`count(*)` }).from(grounnelClaims);
  const allContradicted = await db.select().from(grounnelClaims).where(eq(grounnelClaims.verdict, "contradicted"));

  const negated = allContradicted.filter((c) => NEGATION_RE.test(c.claimText));

  console.log("=== POPULATION ===");
  console.log("claims total:            ", total[0]?.n);
  console.log("contradicted total:      ", allContradicted.length);
  console.log("contradicted + negated:  ", negated.length);
  console.log(
    "negated share of contradicted:",
    allContradicted.length ? ((negated.length / allContradicted.length) * 100).toFixed(1) + "%" : "n/a"
  );

  console.log("\n=== CANDIDATES FOR HAND-LABELLING (N = " + negated.length + ") ===");
  for (const c of negated) {
    console.log("\n--- " + c.claimId + "  conf=" + c.confidence + "  run=" + c.runId.slice(0, 8));
    console.log("claim:    " + c.claimText);
    console.log("evidence: " + String(c.evidence ?? "(null)").slice(0, 300));
    console.log("reason:   " + String(c.reason ?? "(null)").slice(0, 300));
  }

  // Distribution over ALL contradicted, for context on how rare the class is.
  const byRun = new Map<string, number>();
  for (const c of allContradicted) byRun.set(c.runId, (byRun.get(c.runId) ?? 0) + 1);
  console.log("\n=== contradicted per run (runs with any) ===");
  for (const [r, n] of [...byRun.entries()].sort((a, b) => b[1] - a[1])) console.log("  " + r.slice(0, 8) + "  " + n);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
