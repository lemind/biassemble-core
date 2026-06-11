/**
 * Core Inngest functions — registered with serve() in the Fastify server.
 * Similar to backend's src/lib/workflow/inngest-functions.ts.
 */
import { evalAssessmentJob, evalGoldenStoryJob, evalNoBiasStoryJob } from "./eval-assessment";

export const inngestFunctions = [evalAssessmentJob, evalGoldenStoryJob, evalNoBiasStoryJob];
