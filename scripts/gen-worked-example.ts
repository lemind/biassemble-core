/**
 * Regenerates the site's landing-page worked example (site spec 004, T010a) from a real production
 * run. Emits a typed module — the site never queries this database. Run:
 *   npx tsx --env-file=.env scripts/gen-worked-example.ts
 */
import { sql } from "drizzle-orm";
import { writeFileSync } from "node:fs";
import { getDb } from "../src/db/config.js";

const RUN_ID = "bb62670f-1f82-49d4-8316-1c1265f5ddc1";
const OUT = "../biassemble/frontend/src/data/workedExample.ts";
// Two paragraphs of that run, chosen for one clean contradiction plus two supported claims with
// reachable sources. Claims are kept only if their excerpt falls inside the slice, so highlight
// offsets stay valid.
const KEEP_PARAGRAPH = (p: string) =>
  p.includes("Great Fire of London") || p.includes("Eiffel Tower looked smaller");

const db = getDb();
const q = async (s: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> => {
  const r = (await db.execute(s)) as unknown as { rows?: Record<string, unknown>[] };
  return Array.isArray(r) ? r : (r.rows ?? []);
};

const [run] = await q(sql`
  SELECT text, prompt_version_extract pe, prompt_version_verify pv, created_at
  FROM grounnel.grounnel_runs WHERE run_id = ${RUN_ID}::uuid`);
if (!run) throw new Error(`run ${RUN_ID} not found`);

const text = String(run.text).split(/\n\n+/).filter(KEEP_PARAGRAPH).join("\n\n");

const claims = (
  await q(sql`
    SELECT claim_id, claim_text, verdict, source_excerpt, evidence, confidence, reason, sources, status
    FROM grounnel.grounnel_claims WHERE run_id = ${RUN_ID}::uuid ORDER BY created_at`)
)
  .filter((c) => c.source_excerpt && text.includes(String(c.source_excerpt)))
  .map((c) => ({
    id: c.claim_id,
    text: c.claim_text,
    status: c.status,
    verdict: c.verdict,
    evidence: c.evidence,
    confidence: c.confidence,
    reason: c.reason,
    sources: c.sources,
    // Citations are not persisted (grounnel_claims has no column for them), so a regenerated
    // example never shows inline citation numbers even though a live run does.
    citations: [],
    sourceExcerpt: c.source_excerpt,
  }));

const body = {
  runId: RUN_ID,
  ranAt: String(run.created_at),
  promptVersionExtract: run.pe,
  promptVersionVerify: run.pv,
  text,
  claims,
};

writeFileSync(
  OUT,
  `// Generated from production run ${RUN_ID} (${run.pe}/${run.pv}, ${String(run.created_at).slice(0, 10)})
// by biassemble-core scripts/gen-worked-example.ts. Verbatim pipeline output, nothing hand-edited.
// Regenerate, don't edit.
import type { Claim } from '../types/grounnel';

export interface WorkedExample {
  runId: string;
  ranAt: string;
  promptVersionExtract: string;
  promptVersionVerify: string;
  text: string;
  claims: Claim[];
}

const workedExample: WorkedExample = ${JSON.stringify(body, null, 2)};

export default workedExample;
`,
);

console.log(`${claims.length} claims, ${text.length} chars → ${OUT}`);
process.exit(0);
