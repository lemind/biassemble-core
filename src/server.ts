import Fastify from "fastify";
import { Redis } from "@upstash/redis";
import { fastifyPlugin as inngestFastify } from "inngest/fastify";
import { env, upstashRedisConfig } from "./lib/env";
import { requestIdHook } from "./lib/request-id";
import { logger } from "./observability/logger";
import { GeminiProvider } from "./providers/gemini";
import { PromptRegistry } from "./prompts/registry";
import { BiasCatalogService } from "./catalog/bias-catalog";
import { QuestionService } from "./orchestrators/reflection/question.service";
import { AssessmentService } from "./orchestrators/reflection/assessment.service";
import { registerReflectionRoutes } from "./routes/reflection";
import { registerAuditRoutes, type AuditEnqueuer } from "./routes/audit";
import { registerGrounnelRoutes } from "./routes/grounnel";
import { inngest } from "./jobs/client";
import { buildInngestFunctions } from "./jobs/inngest-functions";
import { createRagRetrieveJob } from "./jobs/rag-retrieve";
import { DrizzleLlmCallStore } from "./persistence/llm-call-store";
import { DrizzleRunStore } from "./persistence/run-store";
import { DrizzleTraceStore } from "./persistence/trace-store";
import { DrizzleRetrievalComparisonStore } from "./persistence/retrieval-comparison-store";
import { DrizzleAuditStore } from "./persistence/audit-store";
import { RagEngineClient } from "./rag/engine-client";
import { UpstashRedisHashClient, RedisGrounnelStore } from "./persistence/grounnel-store";
import { DrizzleGrounnelHistoryStore } from "./persistence/grounnel-history-store";
import { DrizzleGrounnelLlmCallStore } from "./persistence/grounnel-llm-call-store";
import { DrizzleGrounnelSearchCallStore } from "./persistence/grounnel-search-call-store";
import { DrizzleGrounnelGateEventStore } from "./persistence/grounnel-gate-event-store";
import { DrizzleGrounnelRerankDecisionStore } from "./persistence/grounnel-rerank-decision-store";
import { GrounnelExtractService } from "./orchestrators/grounnel/extract.service";
import { GrounnelPipelineService } from "./orchestrators/grounnel/pipeline.service";
import { HybridSearchProvider } from "./providers/search/hybrid-provider";
import { TavilySearchProvider } from "./providers/search/tavily-provider";
import { RedisRateLimiter, UpstashRateLimitRedisClient, type RateLimiter } from "./lib/rate-limit";

/**
 * Build and configure a Fastify instance with all routes and DI.
 * Does NOT call listen() — caller decides whether to start or
 * hand off to a serverless wrapper.
 */
export function buildApp() {
  const server = Fastify({
    logger: false, // we use our own pino logger
    // request.ip otherwise resolves to Vercel's own proxy, not the real client — the one thing
    // T011's per-IP RateLimiter actually needs to work (tasks.md T012).
    trustProxy: true,
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

  // specs/008-b2b — audit mode DI. Inngest job (jobs/audit-run.ts) is
  // self-contained (constructs its own dependency graph, matching
  // jobs/eval-run.ts's existing pattern) — this enqueuer just sends the event.
  const auditStore = new DrizzleAuditStore();
  const auditEnqueuer: AuditEnqueuer = {
    async enqueue(data) {
      await inngest.send({ name: "audit/run", data });
    },
  };

  // specs/009-grounnel — no Postgres, no Inngest for this surface (D019 §4, D020 §3). Same conditional-wiring as ragClient above — booted only once all secrets exist, absent otherwise, not a boot crash.
  let grounnel:
    | {
        extractService: GrounnelExtractService;
        pipelineService: GrounnelPipelineService;
        grounnelStore: RedisGrounnelStore;
        historyStore: DrizzleGrounnelHistoryStore;
        rateLimiter: RateLimiter;
      }
    | undefined;
  if (env.TAVILY_API_KEY && upstashRedisConfig) {
    const redis = new Redis({ ...upstashRedisConfig, automaticDeserialization: false });
    const grounnelStore = new RedisGrounnelStore(new UpstashRedisHashClient(redis));
    // Best-effort Postgres history (D023 §7) — safe to construct unconditionally even without
    // DATABASE_URL configured; every method catches and logs internally, never throws.
    const historyStore = new DrizzleGrounnelHistoryStore();
    const llmCallStore = new DrizzleGrounnelLlmCallStore();
    const searchCallStore = new DrizzleGrounnelSearchCallStore();
    const gateEventStore = new DrizzleGrounnelGateEventStore();
    const rerankDecisionStore = new DrizzleGrounnelRerankDecisionStore();
    const tavilyProvider = new TavilySearchProvider(env.TAVILY_API_KEY);
    const searchProvider = new HybridSearchProvider(env.GEMINI_API_KEY, modelName, tavilyProvider, searchCallStore);
    grounnel = {
      extractService: new GrounnelExtractService(provider, prompts, grounnelStore, historyStore, llmCallStore),
      pipelineService: new GrounnelPipelineService(searchProvider, provider, prompts, grounnelStore, historyStore, llmCallStore, gateEventStore, rerankDecisionStore),
      grounnelStore,
      // Spec 019 — the shared-assessment route reads Postgres directly; Redis expires after 7 days.
      historyStore,
      // D020 §4 fix — shared across every Lambda instance via the same Upstash connection as
      // grounnelStore, unlike the old in-memory RateLimiter (buckets were per-process, so 5/hour
      // was only ever enforced per instance, not globally).
      rateLimiter: new RedisRateLimiter(new UpstashRateLimitRedisClient(redis)),
    };
  } else {
    logger.warn(
      { module: "server", missing: { tavily: !env.TAVILY_API_KEY, redis: !upstashRedisConfig } },
      "Grounnel routes not registered — TAVILY_API_KEY and/or Upstash Redis credentials are missing"
    );
  }

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

  // Audit routes (specs/008-b2b)
  registerAuditRoutes(server, {
    auditStore,
    enqueuer: auditEnqueuer,
    modelName,
    extractPromptVersion: prompts.getAuditVersion("extract"),
    verifyPromptVersion: prompts.getAuditVersion("verify"),
    pipelineCodeVersion: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
  });

  // Grounnel routes (specs/009-grounnel, T012)
  if (grounnel) {
    registerGrounnelRoutes(server, grounnel);
  }

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