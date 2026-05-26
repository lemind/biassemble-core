import Fastify from "fastify";
import { env } from "./lib/env.js";
import { requestIdHook } from "./lib/request-id.js";
import { logger } from "./observability/logger.js";
import { GeminiProvider } from "./providers/gemini.js";
import { PromptRegistry } from "./prompts/registry.js";
import { BiasCatalogService } from "./catalog/bias-catalog.js";
import { QuestionService } from "./orchestrators/reflection/question.service.js";
import { AssessmentService } from "./orchestrators/reflection/assessment.service.js";
import { registerReflectionRoutes } from "./routes/reflection.js";

const server = Fastify({
  logger: false, // we use our own pino logger
});

// ─── Dependency Injection ──────────────────────────────────

const provider = new GeminiProvider();
const prompts = new PromptRegistry();
const catalog = new BiasCatalogService();

const questionService = new QuestionService(provider, prompts);
const assessmentService = new AssessmentService(provider, prompts, catalog);

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

// ─── Start ─────────────────────────────────────────────────
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

export { server };