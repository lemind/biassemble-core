/**
 * Core Inngest functions — registered with serve() in the Fastify server.
 * Similar to backend's src/lib/workflow/inngest-functions.ts.
 */
import { evalAssessmentJob } from "./eval-assessment.js";

export const inngestFunctions = [evalAssessmentJob];