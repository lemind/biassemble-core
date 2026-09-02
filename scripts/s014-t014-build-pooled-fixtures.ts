/**
 * spec 014 T014 — rebuild the screen's key rows as POOLED fixtures. Zero API cost.
 *
 * T011's one-sentence fixtures did not reproduce the live failures: `n1` returned `unsupported`
 * isolated but `contradicted` live. The defect is passage SELECTION under competing sources, which
 * a single sentence removes. This reconstructs the exact bundles VERIFY saw, via the same
 * buildPassageSentencesMulti production uses.
 *
 * Usage: npx tsx --env-file=.env scripts/s014-t014-build-pooled-fixtures.ts
 */
import { writeFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config";
import { buildPassageSentencesMulti } from "../src/orchestrators/grounnel/passage-sentences";

// Mirrors passageLabelForIndex in pipeline.service.ts.
const LABELS = ["A", "B", "C", "D", "E", "F"];

const TARGETS = [
  { key: "n1-pooled", run: "9a784003", claim: "68da8ff4", note: "negation polarity — live verdict contradicted, isolated fixture gave unsupported" },
  { key: "r1-pooled", run: "be72361c", claim: "ed8b3a37", note: "reporting claim under distractor pressure — live verdict contradicted" },
];

async function main() {
  const db = getDb();
  const q = async (s: ReturnType<typeof sql>) => {
    const r = (await db.execute(s)) as unknown as Record<string, unknown>[] | { rows: Record<string, unknown>[] };
    return Array.isArray(r) ? r : r.rows;
  };

  const out: Record<string, unknown>[] = [];
  for (const t of TARGETS) {
    const claims = await q(sql`
      SELECT claim_id::text AS claim_id, claim_text, verdict, evidence
      FROM grounnel.grounnel_claims
      WHERE substring(run_id::text,1,8) = ${t.run} AND substring(claim_id::text,1,8) = ${t.claim}
    `);
    if (!claims.length) { console.log(`!! ${t.key}: claim not found`); continue; }
    const c = claims[0]!;

    // Rank order matters — VERIFY sees passages in rerank order, and the defect is which one it picks.
    // DISTINCT ON url — rerank runs once per tier, so the same URL has several decision rows and a
    // naive join hands the same source back as A, B and C.
    const ranked = await q(sql`
      SELECT * FROM (
        SELECT DISTINCT ON (d.url)
               d.url, d.combined_score, d.llm_score, d.selected, p.excerpt
        FROM grounnel.grounnel_rerank_decisions d
        LEFT JOIN grounnel.grounnel_search_pages p
          ON p.claim_id = d.claim_id AND p.url = d.url
        WHERE d.claim_id = ${String(c.claim_id)}::uuid
        ORDER BY d.url, d.combined_score DESC
      ) x ORDER BY x.combined_score DESC
    `);
    const usable = ranked.filter((r) => (r.excerpt as string | null)?.trim());
    const selected = usable.filter((r) => r.selected === true);
    const ordered = selected.length ? selected : usable;

    // The page carrying the live cited evidence MUST be in the pool. Ranking alone drops it: for
    // 68da8ff4 the Guardian scored 51.7 while the two sources VERIFY ignored scored 95 — that gap
    // IS the defect, so a top-3-by-score slice reconstructs a bundle the failure cannot occur in.
    const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const evidenceKey = norm(String(c.evidence ?? "")).split(" ").slice(0, 12).join(" ");
    const carrier = evidenceKey.length > 20 ? ordered.find((r) => norm(String(r.excerpt)).includes(evidenceKey)) : undefined;
    const others = ordered.filter((r) => r !== carrier).slice(0, carrier ? 2 : 3);
    // Rank order preserved, carrier placed where its score puts it.
    const pool = [...others, ...(carrier ? [carrier] : [])].sort(
      (a, b) => Number(b.combined_score) - Number(a.combined_score),
    );
    if (carrier) console.log(`  (evidence carrier included: ${String(carrier.url).slice(0, 60)} @${Number(carrier.combined_score).toFixed(1)})`);

    if (!pool.length) { console.log(`!! ${t.key}: no page text for any ranked source`); continue; }

    const passages = pool.map((r, i) => ({ label: LABELS[i]!, text: String(r.excerpt) }));
    const sentences = buildPassageSentencesMulti(String(c.claim_text), passages);

    out.push({
      key: t.key, note: t.note, run: t.run,
      claim_id: String(c.claim_id),
      claim: String(c.claim_text),
      live_verdict: c.verdict,
      live_evidence: c.evidence,
      sources: pool.map((r, i) => ({ label: LABELS[i], url: r.url, combined: r.combined_score, llm: r.llm_score, selected: r.selected })),
      passage_sentences: sentences,
    });

    console.log(`\n=== ${t.key} (${t.run}/${t.claim}) live=${c.verdict} ===`);
    console.log(`  claim: ${String(c.claim_text).slice(0, 100)}`);
    for (const [label, arr] of Object.entries(sentences)) {
      const src = pool[LABELS.indexOf(label)]!;
      let host = String(src.url);
      try { host = new URL(host).hostname; } catch { /* keep raw */ }
      const list = arr as Array<{ n: number; text: string }>;
      console.log(`  ${label} (${host}, combined=${Number(src.combined_score).toFixed(1)}) ${list.length} sentences`);
      for (const s of list.slice(0, 4)) console.log(`     ${s.n}. ${s.text.slice(0, 105)}`);
    }
  }

  writeFileSync("specs/014-verify-negated-claim-polarity/pooled-fixtures.json", JSON.stringify(out, null, 2) + "\n");
  console.log(`\nwrote pooled-fixtures.json (${out.length} rows)`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
