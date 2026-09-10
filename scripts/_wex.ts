import { sql } from "drizzle-orm";
import { getDb } from "../src/db/config.js";
import { writeFileSync } from "node:fs";
const db = getDb();
const q = async (s: any): Promise<any[]> => { const r: any = await db.execute(s); return Array.isArray(r) ? r : r.rows ?? []; };
const id='bb62670f-1f82-49d4-8316-1c1265f5ddc1';
const [run] = await q(sql`SELECT text, prompt_version_extract pe, prompt_version_verify pv, created_at FROM grounnel.grounnel_runs WHERE run_id=${id}::uuid`);
const paras: string[] = run.text.split(/\n\n+/);
const wanted = paras.filter((p: string) => p.includes('Great Fire of London') || p.includes('Eiffel Tower looked smaller'));
const text = wanted.join('\n\n');
const cl = await q(sql`SELECT claim_id, claim_text, verdict, source_excerpt, evidence, confidence, reason, sources, status FROM grounnel.grounnel_claims WHERE run_id=${id}::uuid ORDER BY created_at`);
const kept = cl.filter(c => c.source_excerpt && text.includes(c.source_excerpt));
console.log(`paragraphs=${wanted.length} chars=${text.length} claims=${kept.length}`);
for (const c of kept) console.log(`  [${c.verdict}] ${c.claim_text}`);
const fixture = {
  generatedFrom: { runId: id, ranAt: String(run.created_at), promptVersionExtract: run.pe, promptVersionVerify: run.pv },
  text,
  claims: kept.map(c => ({
    id: c.claim_id, text: c.claim_text, status: c.status, verdict: c.verdict,
    evidence: c.evidence, confidence: c.confidence, reason: c.reason,
    sources: c.sources, citations: [], sourceExcerpt: c.source_excerpt,
  })),
};
const header = `// Generated from production run ${id} (${run.pe}/${run.pv}, ${String(run.created_at).slice(0,10)}) by
// biassemble-core scripts/_wex.ts. Two paragraphs of that run's text and the three claims whose
// excerpts fall inside them — verbatim pipeline output, nothing hand-edited. Regenerate, don't edit.
import type { Claim } from '../types/grounnel';

export interface WorkedExample {
  runId: string;
  ranAt: string;
  promptVersionExtract: string;
  promptVersionVerify: string;
  text: string;
  claims: Claim[];
}

const workedExample: WorkedExample = `;
writeFileSync('/home/dl/_prog/biassemble/biassemble/frontend/src/data/workedExample.ts',
  header + JSON.stringify({ ...fixture.generatedFrom, text: fixture.text, claims: fixture.claims }, null, 2) + ';\n\nexport default workedExample;\n');
console.log('written');
process.exit(0);
