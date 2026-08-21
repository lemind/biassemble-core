/**
 * Core Inngest functions — registered with serve() in the Fastify server.
 * Similar to backend's src/lib/workflow/inngest-functions.ts.
 */
import { evalAssessmentJob, evalGoldenStoryJob, evalNoBiasStoryJob } from "./eval-assessment";
import { evalDatasetRunJob } from "./eval-run";
import { evalGrounnelRunJob } from "./eval-grounnel-run";
import { auditRunJob } from "./audit-run";
// TEMPORARY (D030 §3c investigation) — remove this import + registration once concluded.
import { reconciliationReplayJob } from "./reconciliation-replay";
import type { createRagRetrieveJob } from "./rag-retrieve";

// ragRetrieveJob is constructed in server.ts (needs ragClient + runStore injected)
// and is undefined when RAG isn't configured for this environment — so the full
// function list is assembled here rather than exported statically.
export function buildInngestFunctions(ragRetrieveJob?: ReturnType<typeof createRagRetrieveJob>) {
  const base = [evalAssessmentJob, evalGoldenStoryJob, evalNoBiasStoryJob, evalDatasetRunJob, evalGrounnelRunJob, auditRunJob, reconciliationReplayJob];
  return ragRetrieveJob ? [...base, ragRetrieveJob] : base;
}
