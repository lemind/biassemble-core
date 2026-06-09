import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { 
  GenerateQuestionRequestSchema,
  GenerateAssessmentRequestSchema,
  type AssessmentOutput,
} from "../contracts/reflection.schemas.js";
import { authHook } from "../lib/auth.js";
import { logger } from "../observability/logger.js";
import type { QuestionService } from "../orchestrators/reflection/question.service.js";
import type { AssessmentService } from "../orchestrators/reflection/assessment.service.js";

const MODULE = "routes";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_JSON = JSON.parse(
  readFileSync(resolve(__dirname, "..", "..", "contracts", "reflection.schemas.json"), "utf-8")
);

export function registerReflectionRoutes(
  server: FastifyInstance,
  services: {
    question: QuestionService;
    assessment: AssessmentService;
  }
) {
  /**
   * GET /v1/contracts — public JSON Schema (no auth)
   * Generated from Zod schemas via `pnpm generate:contracts`.
   */
  server.get("/v1/contracts", async () => {
    return CONTRACTS_JSON;
  });

  /**
   * POST /v1/reflection/question
   */
  server.post("/v1/reflection/question", { preHandler: [authHook] }, async (request, reply) => {
    try {
      const body = GenerateQuestionRequestSchema.parse(request.body);
      
      const result = await services.question.generate(
        body.story,
        request.id
      );

      return result;
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({ 
          error: "Invalid request body",
          details: error.issues 
        });
      }
      logger.error(
        { module: MODULE, operation: "POST /v1/reflection/question", error, requestId: request.id },
        "Question generation failed"
      );
      return reply.status(502).send({ error: "AI provider failed" });
    }
  });

  /**
   * POST /v1/reflection/assessment
   *
   * Two-phase assessment endpoint:
   * - mode=story_only → runs initial assessment on story only, no Q&A required
   * - mode=full → runs post-questions assessment with story + Q&A
   *
   * Query param `includeReasoningTrace=true` includes the reasoning trace in the response body.
   * The trace is always computed and persisted regardless of this flag (FR-003).
   */
  server.post("/v1/reflection/assessment", { preHandler: [authHook] }, async (request, reply) => {
    try {
      const body = GenerateAssessmentRequestSchema.parse(request.body);
      const includeTrace = request.query && (request.query as Record<string, string>).includeReasoningTrace === "true";

      let result: AssessmentOutput;

      if (body.mode === "story_only") {
        result = await services.assessment.runStoryOnlyAssessment(
          body.sessionId,
          body.story,
          request.id
        );
      } else {
        // mode === "full" (default)
        if (body.questions.length !== body.answers.length) {
          return reply.status(400).send({ 
            error: "Questions and answers count must match" 
          });
        }

        result = await services.assessment.runFullAssessment(
          body.sessionId,
          body.story,
          body.questions,
          body.answers,
          request.id
        );
      }

      if (!includeTrace) {
        const { reasoningTrace, ...rest } = result;
        return rest;
      }

      return result;
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({ 
          error: "Invalid request body",
          details: error.issues 
        });
      }
      logger.error(
        { module: MODULE, operation: "POST /v1/reflection/assessment", error, requestId: request.id },
        "Assessment generation failed"
      );
      return reply.status(502).send({ error: "AI provider failed" });
    }
  });
}