// Spec 017 T022-T024 — how often does an `unsupported` verdict say "no source states X" while the
// passages it read actually assert the opposite? Read-only, zero API.
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";

// The shapes VERIFY uses when it reports an absence rather than a refutation.
const ABSENCE_RE = /\b(none of (the|these)|no (sentence|passage|source)s? (state|mention|say|indicate|suggest)|do(es)? not (state|mention|explicitly)|nothing in the (passage|source)|not mentioned|do not (state|mention|suggest|discuss))/i;

async function main(): Promise<void> {
  const db = getDb();
  const q = async (s: any): Promise<any[]> => { const r: any = await db.execute(s); return Array.isArray(r) ? r : r.rows ?? []; };

  const totals = await q(sql`
    SELECT verdict, count(*) AS n FROM grounnel.grounnel_claims
    WHERE status = 'done' AND verdict IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`);
  console.log("=== all persisted claims, by verdict ===");
  for (const t of totals) console.log(`  ${String(t.verdict).padEnd(20)} ${t.n}`);

  const uns = await q(sql`
    SELECT claim_id, claim_text, reason FROM grounnel.grounnel_claims
    WHERE status = 'done' AND verdict = 'unsupported' AND reason IS NOT NULL`);
  const absence = uns.filter((r) => ABSENCE_RE.test(String(r.reason)));
  console.log(`\n=== T022: absence-shaped reasons ===`);
  console.log(`  unsupported with a reason : ${uns.length}`);
  console.log(`  of those, absence-shaped  : ${absence.length}  (${((100 * absence.length) / Math.max(uns.length, 1)).toFixed(1)}%)`);

  // T023 — of the absence-shaped ones, how many read a passage that names the claim's own subject?
  // A refutation requires the sources to be ABOUT the thing; if they are not, "no evidence" is right.
  console.log(`\n=== T023: did those claims actually have on-topic sources? ===`);
  let onTopic = 0, noPages = 0;
  const samples: string[] = [];
  for (const r of absence) {
    const pages = await q(sql`SELECT excerpt FROM grounnel.grounnel_search_pages WHERE claim_id = ${r.claim_id}`);
    if (pages.length === 0) { noPages++; continue; }
    const text = pages.map((p) => String(p.excerpt ?? "")).join(" ").toLowerCase();
    // Content words from the claim, longest first — crude but enough to separate "read pages about
    // this subject" from "read pages about something else entirely".
    const terms = String(r.claim_text).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter((w) => w.length > 4).sort((a, b) => b.length - a.length).slice(0, 4);
    const hits = terms.filter((t) => text.includes(t)).length;
    if (terms.length > 0 && hits >= Math.ceil(terms.length / 2)) {
      onTopic++;
      if (samples.length < 12) samples.push(`  [${hits}/${terms.length} terms] ${String(r.claim_text).slice(0, 66)}\n      reason: ${String(r.reason).replace(/\s+/g, " ").slice(0, 110)}`);
    }
  }
  console.log(`  absence-shaped claims examined : ${absence.length}`);
  console.log(`  had zero stored pages          : ${noPages}`);
  console.log(`  READ ON-TOPIC SOURCES          : ${onTopic}  <- candidates for "refutation reported as absence"`);
  console.log(`  read off-topic/no sources      : ${absence.length - onTopic - noPages}  <- "no evidence" is the CORRECT answer here`);
  console.log(`\n  share of ALL unsupported that are on-topic-absence: ${((100 * onTopic) / Math.max(uns.length, 1)).toFixed(1)}%`);
  console.log(`\n=== samples (manual read required — on-topic is necessary, not sufficient, for refutation) ===`);
  for (const s of samples) console.log(s);
  process.exit(0);
}

await main();
