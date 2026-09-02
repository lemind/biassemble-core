/**
 * spec 015 T002 — simulate G1's input-duplicate predicate against the frozen acceptance rows.
 * Zero API cost. Reads specs/015-evidence-provenance-floors/acceptance-rows.json.
 *
 * Pre-registered kill criterion (tasks.md): report the widest threshold band where must-fire is
 * 20/20 across BOTH sets and must-not-fire is 0. If no such band exists, G1 does not ship.
 *
 * Usage: npx tsx --env-file=.env scripts/s015-t002-simulate-g1.ts
 */
import { readFileSync } from "node:fs";

const K = 5; // word-shingle width; below this a quoted phrase is too short to identify a document

interface Claim {
  run_prefix: string;
  claim_id: string;
  claim_text: string;
  verdict: string;
  evidence: string;
  domains: string[];
  page_excerpts: { url: string; excerpt: string }[];
}

interface Frozen {
  inputs: { run_prefix: string; text: string }[];
  must_fire_A_same_host: { claims: Claim[] };
  must_fire_B_syndicated: { claims: Claim[] };
  must_not_fire_news: { claims: Claim[] };
  must_not_fire_same_run_third_party: { claims: Claim[] };
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function shingles(text: string, k = K): Set<string> {
  const w = words(text);
  if (w.length < k) return new Set(w.length ? [w.join(" ")] : []);
  const out = new Set<string>();
  for (let i = 0; i + k <= w.length; i++) out.add(w.slice(i, i + k).join(" "));
  return out;
}

/** Fraction of `needle`'s shingles that also occur in `haystack` — 1.0 means fully reproduced. */
function containment(needle: Set<string>, haystack: Set<string>): number {
  if (needle.size === 0) return 0;
  let hits = 0;
  for (const s of needle) if (haystack.has(s)) hits++;
  return hits / needle.size;
}

interface Scored {
  set: string;
  claim: Claim;
  span: number;
  page: number;
}

function main() {
  const frozen: Frozen = JSON.parse(
    readFileSync("specs/015-evidence-provenance-floors/acceptance-rows.json", "utf8"),
  );
  const inputShingles = new Map(frozen.inputs.map((i) => [i.run_prefix, shingles(i.text)]));

  const score = (setName: string, claims: Claim[]): Scored[] =>
    claims.map((claim) => {
      const input = inputShingles.get(claim.run_prefix)!;
      const span = containment(shingles(claim.evidence), input);
      // Page level: how much of the INPUT the retrieved page reproduces. A page that is the
      // document scores high; a page that merely quotes one of its sentences scores near zero.
      let page = 0;
      for (const p of claim.page_excerpts ?? []) {
        page = Math.max(page, containment(input, shingles(p.excerpt)));
      }
      return { set: setName, claim, span, page };
    });

  const A = score("must_fire_A", frozen.must_fire_A_same_host.claims);
  const B = score("must_fire_B", frozen.must_fire_B_syndicated.claims);
  const CN = score("control_news", frozen.must_not_fire_news.claims);
  const CS = score("control_same_run", frozen.must_not_fire_same_run_third_party.claims);
  const mustFire = [...A, ...B];
  const mustNot = [...CN, ...CS];

  const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((n / d) * 100).toFixed(0)}%`);
  console.log("=== SETS ===");
  console.log(`  must fire   : ${mustFire.length}  (A=${A.length} same-host, B=${B.length} syndicated)`);
  console.log(`  must NOT    : ${mustNot.length}  (news=${CN.length}, same-run third-party=${CS.length})`);

  console.log("\n=== SPAN-LEVEL THRESHOLD SWEEP (evidence vs input text) ===");
  console.log("  thr    fireA  fireB  | news  sameRun   <- any non-zero on the right is a veto");
  for (const t of [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0]) {
    const f = (rows: Scored[]) => rows.filter((r) => r.span >= t).length;
    console.log(
      `  ${t.toFixed(2)}   ${String(f(A)).padStart(2)}/${A.length}   ${String(f(B)).padStart(2)}/${B.length}  | ${String(f(CN)).padStart(4)}  ${String(f(CS)).padStart(6)}`,
    );
  }

  console.log("\n=== PAGE-LEVEL THRESHOLD SWEEP (input reproduced by the retrieved page) ===");
  console.log("  thr    fireA  fireB  | news  sameRun");
  for (const t of [0.1, 0.2, 0.3, 0.5, 0.7, 0.9]) {
    const f = (rows: Scored[]) => rows.filter((r) => r.page >= t).length;
    console.log(
      `  ${t.toFixed(2)}   ${String(f(A)).padStart(2)}/${A.length}   ${String(f(B)).padStart(2)}/${B.length}  | ${String(f(CN)).padStart(4)}  ${String(f(CS)).padStart(6)}`,
    );
  }

  // The band: widest span threshold where must-fire is complete and must-not-fire is empty.
  const candidates: number[] = [];
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const th = Math.round(t * 100) / 100;
    const fired = mustFire.filter((r) => r.span >= th).length;
    const leaked = mustNot.filter((r) => r.span >= th).length;
    if (fired === mustFire.length && leaked === 0) candidates.push(th);
  }
  console.log("\n=== PRE-REGISTERED BAND (span level) ===");
  if (candidates.length === 0) {
    console.log("  NO BAND EXISTS — must-fire 100% and must-not-fire 0 never hold together.");
    const best = [0.5, 0.7, 0.8, 0.9, 0.95, 1.0].map((t) => ({
      t,
      fired: mustFire.filter((r) => r.span >= t).length,
      leaked: mustNot.filter((r) => r.span >= t).length,
    }));
    for (const b of best) {
      console.log(`    thr ${b.t.toFixed(2)}: fires ${b.fired}/${mustFire.length} (${pct(b.fired, mustFire.length)}), leaks ${b.leaked}/${mustNot.length}`);
    }
  } else {
    console.log(`  BAND: ${candidates[0]!.toFixed(2)} .. ${candidates[candidates.length - 1]!.toFixed(2)}  (must-fire ${mustFire.length}/${mustFire.length}, must-not-fire 0/${mustNot.length})`);
  }

  // ---- PAGE-LEVEL, per PAGE rather than per claim: this is the unit the gate actually inspects.
  // A page is labelled circular by direct inspection (is it a copy of the input?), never by score.
  const CIRCULAR_HOSTS = ["ivypanda.com", "studycorgi.com", "gradesfixer.com", "jps.library.utoronto.ca"];
  const seen = new Map<string, { run: string; url: string; host: string; excerpt: string }>();
  for (const c of [...frozen.must_fire_A_same_host.claims, ...frozen.must_fire_B_syndicated.claims,
                   ...frozen.must_not_fire_news.claims, ...frozen.must_not_fire_same_run_third_party.claims]) {
    for (const p of c.page_excerpts ?? []) {
      const key = `${c.run_prefix}|${p.url}`;
      if (seen.has(key)) continue;
      let host = p.url;
      try { host = new URL(p.url).hostname; } catch { /* keep raw */ }
      seen.set(key, { run: c.run_prefix, url: p.url, host, excerpt: p.excerpt });
    }
  }
  const scoredPages = [...seen.values()].map((pg) => ({
    ...pg,
    known_circular: CIRCULAR_HOSTS.some((h) => pg.host.includes(h)),
    reproduced: containment(inputShingles.get(pg.run)!, shingles(pg.excerpt)),
  }));

  console.log("\n=== PAGE-LEVEL, PER PAGE — how much of the input does this page reproduce? ===");
  console.log("  distinct pages scored:", scoredPages.length);
  const buckets: [number, number][] = [[0, 0.05], [0.05, 0.15], [0.15, 0.25], [0.25, 0.4], [0.4, 1.01]];
  for (const [lo, hi] of buckets) {
    const inB = scoredPages.filter((p) => p.reproduced >= lo && p.reproduced < hi);
    const circ = inB.filter((p) => p.known_circular).length;
    console.log(`  [${lo.toFixed(2)},${hi.toFixed(2)})  pages=${String(inB.length).padStart(3)}  known-circular-host=${circ}`);
  }
  console.log("\n  every page reproducing >= 0.15 of its input:");
  for (const p of scoredPages.filter((x) => x.reproduced >= 0.15).sort((a, b) => b.reproduced - a.reproduced)) {
    console.log(`    ${p.reproduced.toFixed(2)}  ${p.run}  ${p.host}${p.known_circular ? "   <- known circular host" : ""}`);
  }
  console.log("\n  highest-scoring pages BELOW 0.15 (the false-positive frontier):");
  for (const p of scoredPages.filter((x) => x.reproduced < 0.15).sort((a, b) => b.reproduced - a.reproduced).slice(0, 8)) {
    console.log(`    ${p.reproduced.toFixed(2)}  ${p.run}  ${p.host}`);
  }

  const worst = (rows: Scored[], n: number) => [...rows].sort((a, b) => b.span - a.span).slice(0, n);
  console.log("\n=== HIGHEST-SCORING must-NOT-fire rows (the false-positive frontier) ===");
  for (const r of worst(mustNot, 12)) {
    console.log(`  span=${r.span.toFixed(2)} page=${r.page.toFixed(2)} [${r.set}] ${r.claim.run_prefix} ${r.claim.claim_id.slice(0, 8)}`);
    console.log(`     ev: ${r.claim.evidence.slice(0, 105)}`);
  }
  console.log("\n=== LOWEST-SCORING must-fire rows (the recall frontier) ===");
  for (const r of [...mustFire].sort((a, b) => a.span - b.span).slice(0, 8)) {
    console.log(`  span=${r.span.toFixed(2)} page=${r.page.toFixed(2)} [${r.set}] ${r.claim.claim_id.slice(0, 8)}`);
    console.log(`     ev: ${r.claim.evidence.slice(0, 105)}`);
  }
}

main();
