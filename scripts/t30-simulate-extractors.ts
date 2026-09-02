/**
 * T30 — offline simulation of proper-noun extractor candidates against every recorded
 * subject_entity firing. Zero API cost. D030 §3n: simulate before implementing; 6 candidates for
 * this gate have already been refuted by skipping this step.
 *
 * Usage: npx tsx --env-file=.env scripts/t30-simulate-extractors.ts
 */
import { getDb } from "../src/db/config";
import { grounnelGateEvents, grounnelClaims, grounnelRerankDecisions, grounnelSearchPages } from "../src/db/schema";
import { and, eq } from "drizzle-orm";

const PROPER_NOUN_RE = /\b[A-Z][a-zA-Z'-]+\b/g;
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const STOPWORDS = new Set(["the", "he", "she", "they", "his", "her", "their", "a", "an", "in", "on", "at", "this", "that", "its", ...MONTH_NAMES].map((w) => w.toLowerCase()));

/** Current production behaviour. */
function current(text: string): Set<string> {
  return new Set((text.match(PROPER_NOUN_RE) ?? []).map((w) => w.toLowerCase().replace(/'s?$/, "")).filter((w) => !STOPWORDS.has(w)));
}

function isSentenceInitial(text: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const ch = text[i]!;
    if (/\s/.test(ch)) continue;
    return /[.!?:;\n]/.test(ch);
  }
  return true;
}

/** Candidate A (attempt 1, already known broken on fragments) — keep only if it recurs mid-sentence. */
function candidateA(text: string): Set<string> {
  const cands: Array<{ w: string; initial: boolean }> = [];
  for (const m of text.matchAll(PROPER_NOUN_RE)) {
    const w = m[0].toLowerCase().replace(/'s?$/, "");
    if (STOPWORDS.has(w)) continue;
    cands.push({ w, initial: isSentenceInitial(text, m.index) });
  }
  const mid = new Set(cands.filter((c) => !c.initial).map((c) => c.w));
  return new Set(cands.filter((c) => !c.initial || mid.has(c.w)).map((c) => c.w));
}

/**
 * Candidate B — drop a capitalised token that ALSO appears lowercase somewhere in the corpus
 * (claim + evidence). "Researchers"/"researchers" co-occur; "Germany" never appears lowercase.
 * Anchor-shape independent, so it survives the bare-fragment subjectEntity that broke candidate A.
 */
function candidateB(text: string, corpus: string): Set<string> {
  const lower = new Set((corpus.match(/\b[a-z][a-zA-Z'-]+\b/g) ?? []).map((w) => w.toLowerCase()));
  return new Set([...current(text)].filter((w) => !lower.has(w)));
}

async function main() {
  const db = getDb();
  const firings = await db
    .selectDistinct({ runId: grounnelGateEvents.runId, claimId: grounnelGateEvents.claimId, claimText: grounnelClaims.claimText })
    .from(grounnelGateEvents)
    .innerJoin(grounnelClaims, eq(grounnelClaims.claimId, grounnelGateEvents.claimId))
    .where(and(eq(grounnelGateEvents.gate, "subject_entity"), eq(grounnelGateEvents.overridden, true)));

  let scored = 0;
  const stats = { A_abstains: 0, B_abstains: 0, both: 0, neither: 0 };
  const bDropped: Array<{ claim: string; lost: string[] }> = [];

  for (const f of firings) {
    const rows = await db
      .select({ text: grounnelSearchPages.excerpt })
      .from(grounnelRerankDecisions)
      .innerJoin(grounnelSearchPages, and(
        eq(grounnelSearchPages.url, grounnelRerankDecisions.url),
        eq(grounnelSearchPages.claimId, grounnelRerankDecisions.claimId),
        eq(grounnelSearchPages.runId, grounnelRerankDecisions.runId)))
      .where(and(eq(grounnelRerankDecisions.runId, f.runId), eq(grounnelRerankDecisions.claimId, f.claimId), eq(grounnelRerankDecisions.selected, true)));
    if (rows.length === 0) continue;
    const passage = rows.map((r) => r.text).join(" ... ");

    const cur = current(f.claimText);
    if (cur.size === 0) continue; // gate already abstains; not part of the population
    scored++;

    const a = candidateA(f.claimText);
    const b = candidateB(f.claimText, `${f.claimText} ${passage}`);
    const aAbstains = a.size === 0;
    const bAbstains = b.size === 0;
    if (aAbstains && bAbstains) stats.both++;
    else if (aAbstains) stats.A_abstains++;
    else if (bAbstains) stats.B_abstains++;
    else stats.neither++;

    if (bAbstains && bDropped.length < 15) bDropped.push({ claim: f.claimText, lost: [...cur] });
  }

  console.log(`firings with a stored passage and >=1 current name: ${scored}\n`);
  const aTotal = stats.A_abstains + stats.both;
  const bTotal = stats.B_abstains + stats.both;
  console.log(`candidate A (recurs mid-sentence) would abstain on : ${aTotal} (${((aTotal / scored) * 100).toFixed(1)}%)`);
  console.log(`candidate B (never lowercase in corpus) abstains on: ${bTotal} (${((bTotal / scored) * 100).toFixed(1)}%)`);
  console.log(`both ${stats.both} | A only ${stats.A_abstains} | B only ${stats.B_abstains} | neither ${stats.neither}`);

  console.log(`\n--- candidate B: claims whose names it drops (read these — is each really a common noun?) ---`);
  for (const d of bDropped) console.log(`\n  LOST: ${d.lost.join(", ")}\n  CLAIM: ${d.claim.slice(0, 110)}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
