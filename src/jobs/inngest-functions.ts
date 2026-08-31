/**
 * Core Inngest functions — registered with serve() in the Fastify server.
 * Similar to backend's src/lib/workflow/inngest-functions.ts.
 */
import { evalAssessmentJob, evalGoldenStoryJob, evalNoBiasStoryJob } from "./eval-assessment";
import { evalDatasetRunJob } from "./eval-run";
import { evalGrounnelRunJob } from "./eval-grounnel-run";
import { evalT22VerifyOrderJob } from "./eval-t22-verify-order";
import { evalT25ContentlessEligibilityJob } from "./eval-t25-contentless-eligibility";
import { evalT27ReferentScreenJob } from "./eval-t27-referent-screen";
import { attributionExperimentJob } from "./attribution-experiment";
import { auditRunJob } from "./audit-run";
import type { createRagRetrieveJob } from "./rag-retrieve";

// ragRetrieveJob is constructed in server.ts (needs ragClient + runStore injected)
// and is undefined when RAG isn't configured for this environment — so the full
// function list is assembled here rather than exported statically.
export function buildInngestFunctions(ragRetrieveJob?: ReturnType<typeof createRagRetrieveJob>) {
  const base = [evalAssessmentJob, evalGoldenStoryJob, evalNoBiasStoryJob, evalDatasetRunJob, evalGrounnelRunJob, evalT22VerifyOrderJob, evalT25ContentlessEligibilityJob, evalT27ReferentScreenJob, attributionExperimentJob, auditRunJob];
  return ragRetrieveJob ? [...base, ragRetrieveJob] : base;
}
