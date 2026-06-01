import { z } from "zod";

// ─── Constants ────────────────────────────────────────────

const STORY_MIN_LENGTH = 50;
const STORY_MAX_LENGTH = 3000;
const QUESTIONS_MIN = 2;
const QUESTIONS_MAX = 5;
const BIASES_MIN_COUNT = 1;
const BIAS_FIELD_MIN_LENGTH = 10;
const REFLECTION_MIN_LENGTH = 10;

/** Schema version carried in every response. Bump when breaking changes are made. */
export const SCHEMA_VERSION = "1.0.0" as const;

/** Prompt version carried in every response. Bump when prompts are updated. */
export const PROMPT_VERSION = "1.0.0" as const;

// ─── Request schemas ───────────────────────────────────────

export const GenerateQuestionRequestSchema = z.object({
  sessionId: z.string().uuid(),
  story: z.string().min(STORY_MIN_LENGTH).max(STORY_MAX_LENGTH),
});

export const GenerateAssessmentRequestSchema = z.object({
  sessionId: z.string().uuid(),
  story: z.string().min(1),
  questions: z.array(z.string().min(1)).min(1),
  answers: z.array(z.string().min(1)).min(1),
});

// ─── Response schemas ──────────────────────────────────────

export const BiasItemSchema = z.object({
  name: z.string().min(1),
  /** Canonical catalog ID if the bias name was matched against the taxonomy. */
  biasCatalogId: z.string().optional(),
  explanation: z.string().min(BIAS_FIELD_MIN_LENGTH),
  storyConnection: z.string().min(BIAS_FIELD_MIN_LENGTH),
  alternativePerspective: z.string().min(BIAS_FIELD_MIN_LENGTH),
});

export const QuestionOutputSchema = z.object({
  questions: z.array(z.string().min(1)).min(QUESTIONS_MIN).max(QUESTIONS_MAX),
  isComplete: z.boolean(),
  prompt_version: z.string(),
  schema_version: z.literal(SCHEMA_VERSION),
});

export const AssessmentOutputSchema = z.object({
  biases: z.array(BiasItemSchema).min(BIASES_MIN_COUNT),
  reflectionPrompt: z.string().min(REFLECTION_MIN_LENGTH),
  prompt_version: z.string(),
  schema_version: z.literal(SCHEMA_VERSION),
});

// ─── Types ─────────────────────────────────────────────────

export type GenerateQuestionRequest = z.infer<typeof GenerateQuestionRequestSchema>;
export type GenerateAssessmentRequest = z.infer<typeof GenerateAssessmentRequestSchema>;
export type QuestionOutput = z.infer<typeof QuestionOutputSchema>;
export type AssessmentOutput = z.infer<typeof AssessmentOutputSchema>;
export type BiasItem = z.infer<typeof BiasItemSchema>;
