import { z } from "zod";
import { EvidenceEntrySchema, ReasoningTraceSchema } from "./reasoning.schemas";

// ─── Constants ────────────────────────────────────────────

const STORY_MIN_LENGTH = 50;
const STORY_MAX_LENGTH = 3000;
const QUESTIONS_MIN = 2;
const QUESTIONS_MAX = 5;
const BIAS_FIELD_MIN_LENGTH = 10;
const REFLECTION_MIN_LENGTH = 10;

/** Schema version carried in every response. Bump when breaking changes are made. */
export const SCHEMA_VERSION = "1.0.0" as const;

/** Prompt version carried in every response. Bump when prompts are updated. */
export const PROMPT_VERSION = "1.0.0" as const;

// ─── Enums ──────────────────────────────────────────────────

export const InputContextEnum = z.enum(["story-only", "full"]);
export const AssessmentModeEnum = z.enum(["story_only", "full"]);

// ─── Request schemas ───────────────────────────────────────

export const GenerateQuestionRequestSchema = z.object({
  sessionId: z.string().uuid(),
  story: z.string().min(STORY_MIN_LENGTH).max(STORY_MAX_LENGTH),
});

export const GenerateAssessmentRequestSchema = z.object({
  sessionId: z.string().uuid(),
  story: z.string().min(1),
  questions: z.array(z.string().min(1)).default([]),
  answers: z.array(z.string().min(1)).default([]),
  mode: AssessmentModeEnum.default("full"),
}).refine(
  (data) => {
    // story_only mode allows empty questions/answers
    if (data.mode === "story_only") return true;
    // full mode requires at least 1 question and answer
    return data.questions.length >= 1 && data.answers.length >= 1;
  },
  {
    message: "Full assessment mode requires at least 1 question and answer",
    path: ["questions"],
  }
);

// ─── Response schemas ──────────────────────────────────────

export const BiasItemSchema = z.object({
  name: z.string().min(1),
  /** Canonical catalog ID if the bias name was matched against the taxonomy. */
  biasCatalogId: z.string().optional(),
  explanation: z.string().min(BIAS_FIELD_MIN_LENGTH),
  storyConnection: z.string().min(BIAS_FIELD_MIN_LENGTH),
  alternativePerspective: z.string().min(BIAS_FIELD_MIN_LENGTH),
  evidence: z.array(EvidenceEntrySchema).optional(),
});

export const QuestionOutputSchema = z.object({
  questions: z.array(z.string().min(1)).min(QUESTIONS_MIN).max(QUESTIONS_MAX),
  isComplete: z.boolean(),
  prompt_version: z.string().optional(),
  schema_version: z.literal(SCHEMA_VERSION).optional(),
});

export const AssessmentOutputSchema = z.object({
  biases: z.array(BiasItemSchema),
  reflectionPrompt: z.string().min(REFLECTION_MIN_LENGTH),
  prompt_version: z.string().optional(),
  schema_version: z.literal(SCHEMA_VERSION).optional(),
  noBiasDetected: z.boolean(),
  reasoningTrace: ReasoningTraceSchema.optional(),
  inputContext: InputContextEnum.optional(),
  modelName: z.string().min(1).optional(),
});

// ─── Types ─────────────────────────────────────────────────

export type GenerateQuestionRequest = z.infer<typeof GenerateQuestionRequestSchema>;
export type GenerateAssessmentRequest = z.infer<typeof GenerateAssessmentRequestSchema>;
export type QuestionOutput = z.infer<typeof QuestionOutputSchema>;
export type AssessmentOutput = z.infer<typeof AssessmentOutputSchema>;
export type BiasItem = z.infer<typeof BiasItemSchema>;