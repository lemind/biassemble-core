/**
 * spec 016 T001 — freeze the three EXTRACT claim-fidelity defects from persisted telemetry.
 * Zero API cost. Writes specs/016-extract-claim-fidelity/incidents.json.
 *
 * E1 duplicate claims (5b8005cc), E2 non-assertion text (5b8005cc + fddb57fa), E3 referent
 * widening (be72361c). Everything downstream reads the frozen file, not the DB.
 *
 * Usage: npx tsx --env-file=.env scripts/s016-t001-freeze-extract-incidents.ts
 */
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config";

const RUN_PREFIXES = ["5b8005cc", "fddb57fa", "be72361c"] as const;

// The named claims from the three run reviews, by id prefix.
const E1_IDS = ["6c3dcb86", "9d64f9c9"];
const E2_IDS = ["1665eab0"];
const E3_IDS = ["181d6ebb"];

// Caption / credit / byline / bio markers — used only to SHORTLIST fddb57fa's E2 candidates for
// hand-labelling in this freeze; it is not a detector and must not become one (see T003's gate).
const NON_ASSERTION_RE =
  /\b(was photographed|photo(graph)? by|photograph:|image:|credit:|getty|reuters|associated press|can be found|loves|enjoys|in her spare time|in his spare time|in their spare time|is a (student|writer|senior|junior|freshman|sophomore)|studies at|majoring in|contributor|staff writer)\b/i;

interface FrozenClaim {
  claim_id: string;
  run_id: string;
  claim_text: string;
  source_excerpt: string | null;
  verdict: string | null;
  evidence: string | null;
  confidence: number | null;
  reason: string | null;
  source_count: number;
}

async function main() {
  const db = getDb();

  const like = RUN_PREFIXES.map((p) => `${p}%`);
  const raw = (await db.execute(sql`
    SELECT c.claim_id, c.run_id, c.claim_text, c.source_excerpt, c.verdict,
           c.evidence, c.confidence, c.reason, c.sources, c.created_at
    FROM grounnel.grounnel_claims c
    WHERE c.run_id::text LIKE ${like[0]}
       OR c.run_id::text LIKE ${like[1]}
       OR c.run_id::text LIKE ${like[2]}
    ORDER BY c.run_id, c.created_at
  `)) as unknown as Record<string, unknown>[] | { rows: Record<string, unknown>[] };

  // postgres-js returns the row array directly; node-postgres wraps it in { rows }.
  const rows: Record<string, unknown>[] = Array.isArray(raw) ? raw : raw.rows;

  const freeze = (r: Record<string, unknown>): FrozenClaim => ({
    claim_id: String(r.claim_id),
    run_id: String(r.run_id),
    claim_text: String(r.claim_text),
    source_excerpt: (r.source_excerpt as string | null) ?? null,
    verdict: (r.verdict as string | null) ?? null,
    evidence: (r.evidence as string | null) ?? null,
    confidence: (r.confidence as number | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    source_count: Array.isArray(r.sources) ? r.sources.length : 0,
  });

  const byPrefix = (ids: string[]) =>
    rows.filter((r) => ids.some((id) => String(r.claim_id).startsWith(id))).map(freeze);

  const inRun = (prefix: string) => rows.filter((r) => String(r.run_id).startsWith(prefix));

  // E1 — every same-excerpt group in 5b8005cc, not just the named pair, so the census in T002 has
  // this run's ground truth to score itself against.
  const groups = new Map<string, FrozenClaim[]>();
  for (const r of inRun("5b8005cc")) {
    const ex = r.source_excerpt as string | null;
    if (!ex?.trim()) continue;
    const key = ex.trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(freeze(r));
  }
  const e1Groups = [...groups.entries()]
    .filter(([, cs]) => cs.length >= 2)
    .map(([excerpt, claims]) => ({ source_excerpt: excerpt, claims }));

  // E2 — shortlist by marker, in both runs; every row here needs a hand label, none is auto-truth.
  const e2Shortlist = rows
    .filter((r) => {
      const ex = (r.source_excerpt as string | null) ?? "";
      return NON_ASSERTION_RE.test(ex) || NON_ASSERTION_RE.test(String(r.claim_text));
    })
    .map(freeze);

  const incidents = {
    frozen_at: new Date().toISOString(),
    spec: "016-extract-claim-fidelity",
    task: "T001",
    note: "Frozen from persisted telemetry, not transcribed. E2's shortlist is marker-based and needs hand labels; the marker regex is a triage aid for this freeze only, never a production detector.",
    runs: RUN_PREFIXES.map((p) => {
      const rs = inRun(p);
      return { prefix: p, run_id: rs[0] ? String(rs[0].run_id) : null, claim_count: rs.length };
    }),
    E1_duplicate_claims: {
      named_pair: byPrefix(E1_IDS),
      all_same_excerpt_groups_in_5b8005cc: e1Groups,
      group_count: e1Groups.length,
    },
    E2_non_assertion_text: {
      named: byPrefix(E2_IDS),
      marker_shortlist: e2Shortlist,
      shortlist_count: e2Shortlist.length,
    },
    E3_referent_widening: {
      named: byPrefix(E3_IDS),
    },
  };

  const out = "specs/016-extract-claim-fidelity/incidents.json";
  writeFileSync(out, JSON.stringify(incidents, null, 2) + "\n");

  console.log("wrote", out);
  for (const r of incidents.runs) console.log(`  run ${r.prefix} -> ${r.claim_count} claims`);
  console.log("E1 named pair rows          :", incidents.E1_duplicate_claims.named_pair.length);
  console.log("E1 same-excerpt groups (>=2):", e1Groups.length);
  console.log("E2 named rows               :", incidents.E2_non_assertion_text.named.length);
  console.log("E2 marker shortlist         :", e2Shortlist.length);
  console.log("E3 named rows               :", incidents.E3_referent_widening.named.length);

  console.log("\n=== E1 groups ===");
  for (const g of e1Groups) {
    console.log(`  excerpt: ${g.source_excerpt.slice(0, 110)}`);
    for (const c of g.claims) console.log(`    ${c.claim_id.slice(0, 8)} [${c.verdict}] ${c.claim_text.slice(0, 95)}`);
  }

  console.log("\n=== E2 shortlist ===");
  for (const c of e2Shortlist) {
    console.log(`  ${c.run_id.slice(0, 8)} ${c.claim_id.slice(0, 8)} [${c.verdict}] ${c.claim_text.slice(0, 90)}`);
  }

  console.log("\n=== E3 ===");
  for (const c of incidents.E3_referent_widening.named) {
    console.log(`  ${c.claim_id.slice(0, 8)} [${c.verdict}]`);
    console.log(`    claim   : ${c.claim_text}`);
    console.log(`    excerpt : ${c.source_excerpt}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
