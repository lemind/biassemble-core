import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { 
  GenerateQuestionRequestSchema,
  GenerateAssessmentRequestSchema,
  QuestionOutputSchema,
  AssessmentOutputSchema,
  BiasItemSchema,
} from "../contracts/reflection.schemas.js";
import { authHook } from "../lib/auth.js";
import { logger } from "../observability/logger.js";
import type { QuestionService } from "../orchestrators/reflection/question.service.js";
import type { AssessmentService } from "../orchestrators/reflection/assessment.service.js";

const MODULE = "routes";

/**
 * Convert a Zod schema into a JSON description object.
 * Walks the shape recursively to produce { fieldName: "type constraints" }.
 */
function describeZodShape(schema: any): Record<string, any> {
  const shape: Record<string, any> = {};
  if (!schema._def?.typeName || !schema.shape) return {};

  for (const [key, field] of Object.entries(schema.shape)) {
    const f = field as any;
    shape[key] = describeType(f);
  }
  return shape;
}

function describeType(field: any): string {
  // ZodString
  if (field._def?.typeName === "ZodString") {
    const checks = field._def.checks || [];
    // UUID detected via 'uuid' kind in checks array
    if (checks.some((ch: any) => ch.kind === "uuid")) {
      return "uuid";
    }
    const parts = ["string"];
    for (const ch of checks) {
      if (ch.kind === "min") parts.push(`min ${ch.value}`);
      if (ch.kind === "max") parts.push(`max ${ch.value}`);
    }
    return parts.join(" ");
  }
  // ZodNumber
  if (field._def?.typeName === "ZodNumber") {
    return "number";
  }
  // ZodBoolean
  if (field._def?.typeName === "ZodBoolean") {
    return "boolean";
  }
  // ZodArray
  if (field._def?.typeName === "ZodArray") {
    const inner = describeType(field._def.type);
    const checks = field._def.checks || [];
    let prefix = inner;
    for (const ch of checks) {
      if (ch.kind === "min") prefix += ` min ${ch.value}`;
      if (ch.kind === "max") prefix += ` max ${ch.value}`;
    }
    return `${prefix}[]`;
  }
  // ZodObject
  if (field._def?.typeName === "ZodObject") {
    return JSON.stringify(describeZodShape(field));
  }
  return "unknown";
}

export function registerReflectionRoutes(
  server: FastifyInstance,
  services: {
    question: QuestionService;
    assessment: AssessmentService;
  }
) {
  /**
   * GET /v1/contracts — public schema description (no auth)
   */
  server.get("/v1/contracts", async () => {
    return {
      reflection: {
        GenerateQuestionRequest: describeZodShape(GenerateQuestionRequestSchema),
        GenerateAssessmentRequest: describeZodShape(GenerateAssessmentRequestSchema),
        QuestionOutput: describeZodShape(QuestionOutputSchema),
        AssessmentOutput: describeZodShape(AssessmentOutputSchema),
        BiasItem: describeZodShape(BiasItemSchema),
      },
    };
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