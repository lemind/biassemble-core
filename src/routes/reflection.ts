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
import type { RetrievalComparisonStore } from "../persistence/ports";
import { recordComparison } from "../observability/comparison-recorder";
import type { RagCase } from "../rag/context-builder";

const MODULE = "routes";

import contractsJson from "../../contracts/reflection.schemas.json" with { type: "json" };
const CONTRACTS_JSON = contractsJson;

export interface QuestionServiceLike {
  generate(sessionId: string, story: string, requestId: string, storyAnalysis?: StoryAnalysis, interpretations?: Interpretation[]): Promise<QuestionOutput>;
}

export interface FullAssessmentResult {
  output: AssessmentOutput;
  runId: string;
  ragCase: RagCase;
  ragList: string[];
  sourceLists: Record<string, string[]>;
  selectionStrategy?: string;
  llmModel?: string;
  llmListRaw: string[];
}

export interface AssessmentServiceLike {
  runStoryOnlyAssessment(sessionId: string, story: string, requestId: string): Promise<AssessmentOutput>;
  runFullAssessment(sessionId: string, story: string, questions: string[], answers: string[], requestId: string): Promise<FullAssessmentResult>;
  // Stage 005: fires RAG retrieval as a background job — fire-and-forget by
  // design, returns void (internally waitUntil-wrapped). Optional so existing
  // AssessmentServiceLike mocks (question-focused tests) don't need updating —
  // routes must guard with `?.()` when calling it.
  fireRagRetrieval?(sessionId: string, story: string, requestId: string): void;
}

export function registerReflectionRoutes(
  server: FastifyInstance,
  services: {
    question: QuestionServiceLike;
    assessment: AssessmentServiceLike;
    comparisonStore?: RetrievalComparisonStore;
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

      // Stage 005: fire RAG retrieval in the background alongside question
      // generation — this is the actual story-submission trigger point the
      // backend calls on every request, unlike the story_only assessment mode
      // which nothing in production ever invokes. fireRagRetrieval is
      // fire-and-forget by design (void return, internally waitUntil-wrapped)
      // — nothing further needed here.
      services.assessment.fireRagRetrieval?.(body.sessionId, body.story, request.id);

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

        const fullResult = await services.assessment.runFullAssessment(
          body.sessionId,
          body.story,
          body.questions,
          body.answers,
          request.id
        );
        result = fullResult.output;

        if (services.comparisonStore) {
          recordComparison(
            {
              sessionId: body.sessionId,
              runId: fullResult.runId,
              ragList: fullResult.ragList,
              sourceLists: fullResult.sourceLists,
              llmListRaw: fullResult.llmListRaw,
              finalList: result.biases.map(b => b.name),
              ragCase: fullResult.ragCase,
              selectionStrategy: fullResult.selectionStrategy,
              llmModel: fullResult.llmModel,
            },
            services.comparisonStore,
          ).catch(() => {/* already logged in recordComparison */});
        }
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