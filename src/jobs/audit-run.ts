/**
 * Inngest audit job — runs one audit's EXTRACT→RETRIEVE→VERIFY→GATE pipeline
 * in the background. Parallel to jobs/eval-run.ts's self-contained pattern
 * (constructs its own dependency graph rather than receiving DI from
 * server.ts, matching how Inngest functions are registered in this repo).
 *
 * ── Trigger ────────────────────────────────────────────────────────────
 *   Event: audit/run
 *   Payload: { auditId, outputText, sources[], task?, threshold, maxClaims }
 *
 * The `audits` row (status="running") already exists before this fires —
 * created synchronously by routes/audit.ts before returning 202 (see the
 * ordering note on the `audits.status` column in db/schema.ts). This job
 * only ever transitions it to complete/failed.
 */
import { inngest } from "./client.js";
import { GeminiProvider } from "../providers/gemini.js";
import { PromptRegistry } from "../prompts/registry.js";
import { DrizzleLlmCallStore } from "../persistence/llm-call-store.js";
import { DrizzleAuditStore } from "../persistence/audit-store.js";
import { ExtractService } from "../orchestrators/audit/extract.service.js";
import { VerifyService } from "../orchestrators/audit/verify.service.js";
import { GateService } from "../orchestrators/audit/gate.service.js";
import { AuditService } from "../orchestrators/audit/audit.service.js";
import { logger } from "../observability/logger.js";
import { env } from "../lib/env.js";

const MODULE = "audit-run";

export const auditRunJob = inngest.createFunction(
  { id: "audit-run", name: "Audit — Run" },
  { event: "audit/run" },
  async ({ event }) => {
    const { auditId, outputText, sources, task, threshold, maxClaims } = event.data as {
      auditId: string;
      outputText: string;
      sources: Array<{ id: string; name: string; text: string }>;
      task: string | undefined;
      threshold: number;
      maxClaims: number;
    };

    logger.info({ module: MODULE, auditId }, "Starting audit run");

    const provider = new GeminiProvider();
    const prompts = new PromptRegistry();
    const llmCallStore = new DrizzleLlmCallStore();
    const auditStore = new DrizzleAuditStore();
    const modelName = env.GEMINI_MODEL;

    const extractService = new ExtractService(provider, prompts, modelName, llmCallStore, auditStore);
    const verifyService = new VerifyService(provider, prompts, modelName, llmCallStore, auditStore);
    const gateService = new GateService(auditStore);
    const pipelineCodeVersion = process.env.VERCEL_GIT_COMMIT_SHA ?? "dev";
    const auditService = new AuditService(extractService, verifyService, gateService, auditStore, pipelineCodeVersion);

    try {
      await auditService.run(auditId, { outputText, sources, task, threshold, maxClaims });
      logger.info({ module: MODULE, auditId }, "Audit run finished");
      return { auditId, status: "finished" };
    } catch (error) {
      // audit.service.ts already persists status=failed per-stage internally;
      // this catch is only for something escaping that (a genuine bug), so
      // the Inngest job itself doesn't silently succeed on an unhandled throw.
      logger.error({ module: MODULE, auditId, error }, "Audit run threw unexpectedly");
      throw error;
    }
  }
);
