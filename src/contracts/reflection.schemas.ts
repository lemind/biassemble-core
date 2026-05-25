import { z } from "zod";

// ─── Constraints (local constants) ─────────────────────────

const STORY_MIN_LENGTH = 50;
const STORY_MAX_LENGTH = 3000;
const QUESTIONS_MIN = 2;
const QUESTIONS_MAX = 5;
const BIASES_MIN_COUNT = 1;
const BIAS_FIELD_MIN_LENGTH = 10;
const REFLECTION_MIN_LENGTH = 10;

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
  explanation: z.string().min(BIAS_FIELD_MIN_LENGTH),
  storyConnection: z.string().min(BIAS_FIELD_MIN_LENGTH),
  alternativePerspective: z.string().min(BIAS_FIELD_MIN_LENGTH),
});

export const QuestionOutputSchema = z.object({
  questions: z.array(z.string().min(1)).min(QUESTIONS_MIN).max(QUESTIONS_MAX),
  isComplete: z.boolean(),
});

export const AssessmentOutputSchema = z.object({
  biases: z.array(BiasItemSchema).min(BIASES_MIN_COUNT),
  reflectionPrompt: z.string().min(REFLECTION_MIN_LENGTH),
});

// ─── Types ─────────────────────────────────────────────────

export type GenerateQuestionRequest = z.infer<typeof GenerateQuestionRequestSchema>;
export type GenerateAssessmentRequest = z.infer<typeof GenerateAssessmentRequestSchema>;
export type QuestionOutput = z.infer<typeof QuestionOutputSchema>;
export type AssessmentOutput = z.infer<typeof AssessmentOutputSchema>;
export type BiasItem = z.infer<typeof BiasItemSchema>;