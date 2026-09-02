/**
 * spec 016 T002 — census duplicate extraction across all runs. Zero API cost.
 *
 * T001 showed same-`source_excerpt` is mostly CORRECT decomposition (5 of 9 groups in one run), so
 * this census scores three candidate predicates separately and reports each one's yield and its
 * false-positive exposure, rather than a single "duplicate rate".
 *
 * Usage: npx tsx --env-file=.env scripts/s016-t002-census-duplicate-claims.ts
 */
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config";

const PUNCT_RE = /[.,!?;:"'()‘’“”–—$%]/g;

const STOPWORDS = new Set([
  "a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "is", "are", "was", "were", "be",
  "been", "has", "have", "had", "that", "this", "it", "its", "as", "at", "by", "with", "from",
  "will", "would", "than", "more", "most", "up", "out", "s",
]);

// Attribution surface markers — used only to guess which twin RETAINS attribution, for the
// merge-direction column. Never a filter.
const ATTRIBUTION_RE =
  /\b(expects?|expected|said|says|claimed?|claims|reported|reports|according to|estimates?|forecasts?|predicts?|believes?|told|announced)\b/i;

function normalize(text: string): string {
  return text.toLowerCase().replace(PUNCT_RE, "").replace(/\s+/g, " ").trim();
}

function contentTokens(text: string): Set<string> {
  return new Set(normalize(text).split(" ").filter((t) => t.length > 0 && !STOPWORDS.has(t)));
}

/** Overlap coefficient — |A∩B| / min(|A|,|B|). Chosen over Jaccard so a short claim fully contained in a longer one scores 1.0. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const t of a) if (b.has(t)) hits++;
  return hits / Math.min(a.size, b.size);
}

type Kind = "exact" | "containment" | "overlap" | "distinct";

interface Row {
  claimId: string;
  runId: string;
  claimText: string;
  sourceExcerpt: string;
  verdict: string | null;
  runSource: string;
}

interface Pair {
  a: Row;
  b: Row;
  kind: Kind;
  score: number;
  excerpt: string;
}

async function main() {
  const db = getDb();

  const raw = (await db.execute(sql`
    SELECT c.claim_id, c.run_id, c.claim_text, c.source_excerpt, c.verdict, r.source AS run_source
    FROM grounnel.grounnel_claims c
    JOIN grounnel.grounnel_runs r ON r.run_id = c.run_id
    WHERE c.source_excerpt IS NOT NULL AND btrim(c.source_excerpt) <> ''
  `)) as unknown as Record<string, unknown>[] | { rows: Record<string, unknown>[] };
  const raws: Record<string, unknown>[] = Array.isArray(raw) ? raw : raw.rows;

  const rows: Row[] = raws.map((r) => ({
    claimId: String(r.claim_id),
    runId: String(r.run_id),
    claimText: String(r.claim_text),
    sourceExcerpt: String(r.source_excerpt),
    verdict: (r.verdict as string | null) ?? null,
    runSource: String(r.run_source),
  }));

  // Total claim population, including the null-excerpt rows this census cannot see.
  const totals = (await db.execute(sql`
    SELECT r.source AS run_source,
           count(*)::int AS claims,
           count(*) FILTER (WHERE c.source_excerpt IS NULL OR btrim(c.source_excerpt) = '')::int AS null_excerpt,
           count(DISTINCT c.run_id)::int AS runs
    FROM grounnel.grounnel_claims c
    JOIN grounnel.grounnel_runs r ON r.run_id = c.run_id
    GROUP BY r.source
  `)) as unknown as Record<string, unknown>[] | { rows: Record<string, unknown>[] };
  const totalRows: Record<string, unknown>[] = Array.isArray(totals) ? totals : totals.rows;

  // Group by (run_id, normalized excerpt).
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.runId}::${normalize(r.sourceExcerpt)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const multi = [...groups.values()].filter((g) => g.length >= 2);

  // Classify every within-group pair once.
  const pairs: Pair[] = [];
  for (const g of multi) {
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const a = g[i]!;
        const b = g[j]!;
        const na = normalize(a.claimText);
        const nb = normalize(b.claimText);
        const score = overlap(contentTokens(a.claimText), contentTokens(b.claimText));
        let kind: Kind = "distinct";
        if (na === nb) kind = "exact";
        else if (na.includes(nb) || nb.includes(na)) kind = "containment";
        else if (score >= 0.8) kind = "overlap";
        pairs.push({ a, b, kind, score, excerpt: a.sourceExcerpt });
      }
    }
  }

  const of = (k: Kind) => pairs.filter((p) => p.kind === k);
  const runsWithExcerpts = new Set(rows.map((r) => r.runId)).size;

  console.log("=== POPULATION ===");
  for (const t of totalRows) {
    console.log(
      `  source=${t.run_source}  runs=${t.runs}  claims=${t.claims}  null/blank source_excerpt=${t.null_excerpt}`,
    );
  }
  console.log(`  claims with an excerpt (this census's scope): ${rows.length} across ${runsWithExcerpts} runs`);

  console.log("\n=== SAME-EXCERPT GROUPS ===");
  console.log("  groups of >=2 claims :", multi.length);
  console.log("  claims inside them   :", multi.reduce((n, g) => n + g.length, 0));
  console.log("  within-group pairs   :", pairs.length);

  console.log("\n=== PREDICATE YIELD (pairs) ===");
  console.log("  T1 exact normalized equality :", of("exact").length);
  console.log("  T2a containment (substring)  :", of("containment").length);
  console.log("  T2b token overlap >= 0.80    :", of("overlap").length);
  console.log("  distinct (must NOT fire)     :", of("distinct").length);

  console.log("\n=== T2b THRESHOLD BAND — overlap score distribution on non-exact, non-containment pairs ===");
  const rest = pairs.filter((p) => p.kind === "overlap" || p.kind === "distinct");
  for (const t of [0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]) {
    const fires = rest.filter((p) => p.score >= t).length;
    console.log(`  >= ${t.toFixed(2)} : ${fires} pairs fire  (${rest.length - fires} left alone)`);
  }

  // Droppable claims: one per exact/containment/overlap pair, deduped by claim id so a 3-way group
  // is not counted twice. Kept claim is the one retaining attribution where that is detectable.
  const droppable = new Set<string>();
  for (const p of pairs) {
    if (p.kind === "distinct") continue;
    const aAttr = ATTRIBUTION_RE.test(p.a.claimText);
    const bAttr = ATTRIBUTION_RE.test(p.b.claimText);
    // Drop the non-attributed twin; on a tie drop the longer id-later one deterministically.
    const drop = aAttr && !bAttr ? p.b : bAttr && !aAttr ? p.a : p.a.claimId < p.b.claimId ? p.b : p.a;
    droppable.add(drop.claimId);
  }
  console.log("\n=== DROPPABLE CLAIMS (all three tiers) ===");
  console.log("  distinct claims that could be collapsed away :", droppable.size);
  console.log(`  as a share of excerpt-bearing claims          : ${((droppable.size / rows.length) * 100).toFixed(2)}%`);

  // Actual per-claim spend, measured rather than assumed.
  const spend = (await db.execute(sql`
    SELECT count(DISTINCT c.claim_id)::int AS claims,
           (SELECT count(*)::int FROM grounnel.grounnel_llm_calls) AS llm_calls,
           (SELECT count(*)::int FROM grounnel.grounnel_search_calls) AS search_calls
    FROM grounnel.grounnel_claims c
  `)) as unknown as Record<string, unknown>[] | { rows: Record<string, unknown>[] };
  const spendRow = (Array.isArray(spend) ? spend : spend.rows)[0]!;
  const claims = Number(spendRow.claims);
  const llmPer = Number(spendRow.llm_calls) / claims;
  const searchPer = Number(spendRow.search_calls) / claims;
  console.log("\n=== MEASURED SPEND PER CLAIM (whole corpus) ===");
  console.log(`  gemini calls / claim : ${llmPer.toFixed(2)}`);
  console.log(`  search calls / claim : ${searchPer.toFixed(2)}`);
  console.log(
    `  collapsing ${droppable.size} claims would have avoided ~${Math.round(droppable.size * llmPer)} gemini + ~${Math.round(droppable.size * searchPer)} search calls`,
  );

  // Run-internal exact duplicates IGNORING source_excerpt — 69% of claims have no excerpt, so the
  // grouped census above is blind to them; this covers the whole corpus.
  const anyDupes = (await db.execute(sql`
    SELECT c.run_id, r.source AS run_source,
           count(*)::int AS n,
           array_agg(substring(c.claim_id::text, 1, 8)) AS ids,
           min(c.claim_text) AS sample
    FROM grounnel.grounnel_claims c
    JOIN grounnel.grounnel_runs r ON r.run_id = c.run_id
    GROUP BY c.run_id, r.source, lower(btrim(regexp_replace(c.claim_text, '[[:space:]]+', ' ', 'g')))
    HAVING count(*) > 1
    ORDER BY count(*) DESC
  `)) as unknown as Record<string, unknown>[] | { rows: Record<string, unknown>[] };
  const anyDupeRows: Record<string, unknown>[] = Array.isArray(anyDupes) ? anyDupes : anyDupes.rows;
  console.log("\n=== RUN-INTERNAL EXACT DUPLICATES, whole corpus (no excerpt needed) ===");
  console.log("  groups          :", anyDupeRows.length);
  console.log("  redundant claims:", anyDupeRows.reduce((a, d) => a + (Number(d.n) - 1), 0));
  for (const d of anyDupeRows) {
    console.log(`  x${d.n}  ${String(d.run_id).slice(0, 8)} (${d.run_source})  [${(d.ids as string[]).join(", ")}]  ${String(d.sample).slice(0, 95)}`);
  }

  const show = (k: Kind, limit: number) => {
    console.log(`\n=== ${k.toUpperCase()} pairs (first ${limit}) ===`);
    for (const p of of(k).slice(0, limit)) {
      console.log(`  [${p.score.toFixed(2)}] ${p.a.claimId.slice(0, 8)} / ${p.b.claimId.slice(0, 8)}  run ${p.a.runId.slice(0, 8)} (${p.a.runSource})`);
      console.log(`     A: ${p.a.claimText.slice(0, 100)}`);
      console.log(`     B: ${p.b.claimText.slice(0, 100)}`);
    }
  };
  show("exact", 12);
  show("containment", 12);
  show("overlap", 15);

  console.log("\n=== DISTINCT pairs scoring 0.60-0.79 — the must-not-fire band to eyeball ===");
  for (const p of of("distinct").filter((x) => x.score >= 0.6).slice(0, 15)) {
    console.log(`  [${p.score.toFixed(2)}] ${p.a.claimId.slice(0, 8)} / ${p.b.claimId.slice(0, 8)}`);
    console.log(`     A: ${p.a.claimText.slice(0, 100)}`);
    console.log(`     B: ${p.b.claimText.slice(0, 100)}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
