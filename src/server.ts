import Fastify from "fastify";
import { fastifyPlugin as inngestFastify } from "inngest/fastify";
import { env } from "./lib/env";
import { requestIdHook } from "./lib/request-id";
import { logger } from "./observability/logger";
import { GeminiProvider } from "./providers/gemini";
import { PromptRegistry } from "./prompts/registry";
import { BiasCatalogService } from "./catalog/bias-catalog";
import { QuestionService } from "./orchestrators/reflection/question.service";
import { AssessmentService } from "./orchestrators/reflection/assessment.service";
import { registerReflectionRoutes } from "./routes/reflection";
import { inngest } from "./jobs/client";
import { buildInngestFunctions } from "./jobs/inngest-functions";
import { createRagRetrieveJob } from "./jobs/rag-retrieve";
import { DrizzleLlmCallStore } from "./persistence/llm-call-store";
import { DrizzleRunStore } from "./persistence/run-store";
import { DrizzleTraceStore } from "./persistence/trace-store";
import { DrizzleRetrievalComparisonStore } from "./persistence/retrieval-comparison-store";
import { RagEngineClient } from "./rag/engine-client";

/**
 * Build and configure a Fastify instance with all routes and DI.
 * Does NOT call listen() — caller decides whether to start or
 * hand off to a serverless wrapper.
 */
export function buildApp() {
  const server = Fastify({
    logger: false, // we use our own pino logger
  });

  // ─── Dependency Injection ──────────────────────────────────

  const provider = new GeminiProvider();
  const prompts = new PromptRegistry();
  const catalog = new BiasCatalogService();
  const llmCallStore = new DrizzleLlmCallStore();
  const runStore = new DrizzleRunStore();
  const traceStore = new DrizzleTraceStore();

  const modelName = env.GEMINI_MODEL;
  const ragClient =
    env.RAG_ENGINE_URL && env.RAG_API_KEY
      ? new RagEngineClient(env.RAG_ENGINE_URL, env.RAG_API_KEY, env.RAG_TIMEOUT_MS, env.RAG_HF_TOKEN)
      : undefined;
  const comparisonStore = new DrizzleRetrievalComparisonStore();
  const questionService = new QuestionService(provider, prompts, modelName, llmCallStore);
  const assessmentService = new AssessmentService(provider, prompts, catalog, modelName, llmCallStore, runStore, traceStore, ragClient, inngest);
  const ragRetrieveJob = ragClient ? createRagRetrieveJob(ragClient, runStore, catalog.getAll(), comparisonStore) : undefined;

  // ─── Global hooks ──────────────────────────────────────────
  server.addHook("onRequest", requestIdHook);

  // ─── Routes ────────────────────────────────────────────────

  // Health route
  server.get("/health", async () => {
    return { status: "ok" };
  });

  // Reflection routes
  registerReflectionRoutes(server, {
    question: questionService,
    assessment: assessmentService,
    comparisonStore,
  });

  // Inngest webhook
  // If VERCEL_BYPASS_TOKEN is set, append it to the serve host so Inngest
  // can bypass Vercel deployment protection when calling back.
  const serveHost = env.INNGEST_SERVE_HOST
    ? env.VERCEL_BYPASS_TOKEN
      ? `${env.INNGEST_SERVE_HOST}?x-vercel-protection-bypass=${env.VERCEL_BYPASS_TOKEN}`
      : env.INNGEST_SERVE_HOST
    : undefined;

  server.register(inngestFastify, {
    client: inngest,
    functions: buildInngestFunctions(ragRetrieveJob),
    options: {
      serveHost,
    },
  });

  return server;
}

// ─── Start (local dev only) ────────────────────────────────
const isVercel = process.env.VERCEL === "1";
if (!isVercel) {
  const server = buildApp();
  const start = async () => {
    try {
      await server.listen({ port: env.PORT, host: "0.0.0.0" });
      logger.info({ port: env.PORT }, "server started");
    } catch (err) {
      logger.error(err, "failed to start server");
      process.exit(1);
    }
  };
  start();
}