// Spec 017 T026 — how many contradictions does the widened D030 §3d protection newly shield?
// Read-only. Approximation: replays whole persisted trails, where production applies the rule to
// the current pass only, so this is an UPPER bound on divergence.
import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";

const PROTECTED = new Set(["reason_ordinal", "instance_attribution"]);
interface Ev { gate: string; after: string; overridden: boolean }

function originIndex(t: Ev[]): number {
  for (let i = t.length - 1; i >= 0; i--) if (t[i]!.overridden && t[i]!.after === "contradicted") return i;
  return -1;
}
const oldRule = (t: Ev[]): boolean => { const i = originIndex(t); return i !== -1 && PROTECTED.has(t[i]!.gate); };
const newRule = (t: Ev[]): boolean => {
  const i = originIndex(t);
  if (i === -1) return false;
  if (PROTECTED.has(t[i]!.gate)) return true;
  return t.slice(0, i).some((e) => e.overridden && PROTECTED.has(e.gate));
};

async function main(): Promise<void> {
  const db = getDb();
  const q = async (s: any): Promise<any[]> => { const r: any = await db.execute(s); return Array.isArray(r) ? r : r.rows ?? []; };
  const rows = await q(sql`
    SELECT ge.claim_id, ge.gate, ge.verdict_after, ge.overridden, c.verdict AS final_verdict, c.claim_text
    FROM grounnel.grounnel_gate_events ge
    JOIN grounnel.grounnel_claims c ON c.claim_id = ge.claim_id
    ORDER BY ge.claim_id, ge.created_at`);
  const byClaim = new Map<string, { trail: Ev[]; final: string; text: string }>();
  for (const r of rows) {
    const k = String(r.claim_id);
    if (!byClaim.has(k)) byClaim.set(k, { trail: [], final: String(r.final_verdict), text: String(r.claim_text) });
    byClaim.get(k)!.trail.push({ gate: String(r.gate), after: String(r.verdict_after), overridden: r.overridden === true });
  }
  let withContradiction = 0, oldP = 0, newP = 0;
  const newlyProtected: { text: string; final: string }[] = [];
  for (const [, v] of byClaim) {
    if (originIndex(v.trail) === -1) continue;
    withContradiction++;
    const o = oldRule(v.trail), n = newRule(v.trail);
    if (o) oldP++;
    if (n) newP++;
    if (!o && n) newlyProtected.push({ text: v.text, final: v.final });
  }
  console.log(`claims with a gate trail          : ${byClaim.size}`);
  console.log(`trails containing a contradiction : ${withContradiction}`);
  console.log(`protected under the OLD rule      : ${oldP}`);
  console.log(`protected under the NEW rule      : ${newP}`);
  console.log(`NEWLY protected by T026           : ${newlyProtected.length}  (${((100 * newlyProtected.length) / Math.max(withContradiction, 1)).toFixed(2)}% of contradiction trails)`);
  const byFinal = new Map<string, number>();
  for (const c of newlyProtected) byFinal.set(c.final, (byFinal.get(c.final) ?? 0) + 1);
  console.log(`\nfinal verdict of the newly-protected claims:`);
  for (const [k, n] of [...byFinal].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${n}`);
  console.log(`\nsample (these keep `+"`contradicted`"+` where reconciliation would previously have removed it):`);
  for (const c of newlyProtected.slice(0, 12)) console.log(`  [${c.final}] ${c.text.slice(0, 88)}`);
  process.exit(0);
}
await main();
