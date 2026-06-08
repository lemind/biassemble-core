import Fastify from "fastify";
import inngestFastify from "inngest/fastify";
import { env } from "./lib/env.js";
import { requestIdHook } from "./lib/request-id.js";
import { logger } from "./observability/logger.js";
import { GeminiProvider } from "./providers/gemini.js";
import { PromptRegistry } from "./prompts/registry.js";
import { BiasCatalogService } from "./catalog/bias-catalog.js";
import { QuestionService } from "./orchestrators/reflection/question.service.js";
import { AssessmentService } from "./orchestrators/reflection/assessment.service.js";
import { registerReflectionRoutes } from "./routes/reflection.js";
import { inngest } from "./jobs/client.js";
import { inngestFunctions } from "./jobs/inngest-functions.js";

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

  const modelName = env.GEMINI_MODEL;
  const questionService = new QuestionService(provider, prompts, modelName);
  const assessmentService = new AssessmentService(provider, prompts, catalog, modelName);

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
  });

  // Inngest webhook
  server.register(inngestFastify, {
    client: inngest,
    functions: inngestFunctions,
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