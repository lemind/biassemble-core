import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { 
  GenerateQuestionRequestSchema,
  GenerateAssessmentRequestSchema,
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
   */
  server.post("/v1/reflection/assessment", { preHandler: [authHook] }, async (request, reply) => {
    try {
      const body = GenerateAssessmentRequestSchema.parse(request.body);

      if (body.questions.length !== body.answers.length) {
        return reply.status(400).send({ 
          error: "Questions and answers count must match" 
        });
      }

      const result = await services.assessment.generate(
        body.story,
        body.questions,
        body.answers,
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
        { module: MODULE, operation: "POST /v1/reflection/assessment", error, requestId: request.id },
        "Assessment generation failed"
      );
      return reply.status(502).send({ error: "AI provider failed" });
    }
  });
}