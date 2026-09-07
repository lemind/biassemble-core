// Spec 017 T009 — the acceptance check for the pool union, independent of detection rate.
// Counts escalation tiers that DROPPED a page the previous tier had already shown to VERIFY.
// Pre-change baseline (runs 7c28d45b / 6760307f / f603014b): 50 transitions, 35 dropping, 50
// already-selected URLs discarded. After the union this must read 0. Zero API, read-only.
//
// Usage: pnpm exec tsx --env-file=.env scripts/s017-t009-pool-churn.ts <run-id-prefix>...

import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";
import { MAX_LABELLED_PASSAGES } from "../src/orchestrators/grounnel/pipeline-helpers.js";

const TIER_GAP_MS = 5_000;
// Derived exactly as pipeline.service.ts does, not transcribed: this gate must measure the carry
// window production actually uses. Rows are written in rank order, so array position IS the rank.
const ESCALATION_TIERS = [8, 11];
const MAX_CARRIED_SOURCES = MAX_LABELLED_PASSAGES - Math.max(...ESCALATION_TIERS);

interface Row {
  url: string;
  selected: boolean;
  t: number;
}

/** Rerank rows carry no tier column; one tier's rows land together, tiers are minutes apart. */
function splitIntoTiers(rows: Row[]): Row[][] {
  const tiers: Row[][] = [];
  let current: Row[] = [];
  let last = -1;
  for (const r of [...rows].sort((a, b) => a.t - b.t)) {
    if (last >= 0 && r.t - last > TIER_GAP_MS) {
      tiers.push(current);
      current = [];
    }
    current.push(r);
    last = r.t;
  }
  if (current.length > 0) tiers.push(current);
  return tiers;
}

async function main(): Promise<void> {
  const prefixes = process.argv.slice(2);
  if (prefixes.length === 0) {
    console.error("usage: s017-t009-pool-churn.ts <run-id-prefix>...");
    process.exit(2);
  }

  const db = getDb();
  const query = async (s: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> => {
    const r = (await db.execute(s)) as unknown;
    return Array.isArray(r) ? r : ((r as { rows?: Record<string, unknown>[] }).rows ?? []);
  };

  let multiTierClaims = 0;
  let transitions = 0;
  let transitionsWithDrop = 0;
  let urlsDropped = 0;
  let selectedDropped = 0;
  const examples: string[] = [];

  for (const prefix of prefixes) {
    const rows = await query(sql`
      SELECT c.claim_text, rd.url, rd.selected, extract(epoch from rd.created_at) * 1000 AS t
      FROM grounnel.grounnel_rerank_decisions rd
      JOIN grounnel.grounnel_claims c ON c.claim_id = rd.claim_id
      JOIN grounnel.grounnel_runs g ON g.run_id = c.run_id
      WHERE g.run_id::text LIKE ${prefix + "%"}
      ORDER BY c.claim_text, rd.created_at`);

    const byClaim = new Map<string, Row[]>();
    for (const x of rows) {
      const key = String(x.claim_text);
      if (!byClaim.has(key)) byClaim.set(key, []);
      byClaim.get(key)!.push({ url: String(x.url), selected: x.selected === true, t: Number(x.t) });
    }

    for (const [claim, claimRows] of byClaim) {
      const tiers = splitIntoTiers(claimRows);
      if (tiers.length < 2) continue;
      multiTierClaims++;
      for (let i = 1; i < tiers.length; i++) {
        transitions++;
        const previous = tiers[i - 1]!;
        const now = new Set(tiers[i]!.map((r) => r.url));
        const dropped = previous.filter((r) => !now.has(r.url));
        if (dropped.length === 0) continue;
        transitionsWithDrop++;
        urlsDropped += dropped.length;
        // `selected` means "VERIFY read it" again under T034's score floor. Rank still matters:
        // only the top MAX_CARRIED_SOURCES are carry-eligible, so a drop there is the real defect.
        const carryEligible = new Set(previous.slice(0, MAX_CARRIED_SOURCES).map((r) => r.url));
        const droppedSelected = dropped.filter((r) => r.selected && carryEligible.has(r.url));
        selectedDropped += droppedSelected.length;
        if (droppedSelected.length > 0 && examples.length < 12) {
          examples.push(`  ${prefix} t${i}->t${i + 1}  ${droppedSelected.map((r) => r.url).join(", ")}  [${claim.slice(0, 60)}]`);
        }
      }
    }
  }

  console.log(`runs:                          ${prefixes.join(", ")}`);
  console.log(`multi-tier claim-runs:         ${multiTierClaims}`);
  console.log(`tier transitions:              ${transitions}`);
  console.log(`transitions dropping >=1 URL:  ${transitionsWithDrop}${transitions > 0 ? ` (${((100 * transitionsWithDrop) / transitions).toFixed(1)}%)` : ""}`);
  console.log(`URLs dropped:                  ${urlsDropped}`);
  console.log(`ALREADY-SELECTED URLs dropped: ${selectedDropped}   <-- T009 gate: must be 0`);
  if (examples.length > 0) {
    console.log("\nexamples:");
    for (const e of examples) console.log(e);
  }
  // A dropped page VERIFY had already read is the defect spec 017 removes; anything else is churn.
  process.exit(selectedDropped === 0 ? 0 : 1);
}

await main();
