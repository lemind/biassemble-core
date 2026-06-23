import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import {
  GenerateQuestionRequestSchema,
  GenerateAssessmentRequestSchema,
  type AssessmentOutput,
  type QuestionOutput,
} from "../contracts/reflection.schemas";
import type { StoryAnalysis, Interpretation } from "../contracts/reasoning.schemas";
import { authHook } from "../lib/auth";
import { logger } from "../observability/logger";

const MODULE = "routes";

import contractsJson from "../../contracts/reflection.schemas.json" with { type: "json" };
const CONTRACTS_JSON = contractsJson;

export interface QuestionServiceLike {
  generate(sessionId: string, story: string, requestId: string, storyAnalysis?: StoryAnalysis, interpretations?: Interpretation[]): Promise<QuestionOutput>;
}

export interface AssessmentServiceLike {
  runStoryOnlyAssessment(sessionId: string, story: string, requestId: string): Promise<AssessmentOutput>;
  runFullAssessment(sessionId: string, story: string, questions: string[], answers: string[], requestId: string): Promise<AssessmentOutput>;
}

export function registerReflectionRoutes(
  server: FastifyInstance,
  services: {
    question: QuestionServiceLike;
    assessment: AssessmentServiceLike;
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
        body.sessionId,
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