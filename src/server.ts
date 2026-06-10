import Fastify from "fastify";
import inngestFastify from "inngest/fastify";
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
import { inngestFunctions } from "./jobs/inngest-functions";

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
  // If VERCEL_BYPASS_TOKEN is set, append it to the serve host so Inngest
  // can bypass Vercel deployment protection when calling back.
  const serveHost = env.INNGEST_SERVE_HOST
    ? env.VERCEL_BYPASS_TOKEN
      ? `${env.INNGEST_SERVE_HOST}?x-vercel-protection-bypass=${env.VERCEL_BYPASS_TOKEN}`
      : env.INNGEST_SERVE_HOST
    : undefined;

  server.register(inngestFastify, {
    client: inngest,
    functions: inngestFunctions,
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