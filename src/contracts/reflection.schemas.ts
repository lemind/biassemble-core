import { z } from "zod";

// ─── Request schemas ───────────────────────────────────────

export const GenerateQuestionRequestSchema = z.object({
  sessionId: z.string().uuid(),
  story: z.string().min(50).max(3000),
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
  explanation: z.string().min(10),
  storyConnection: z.string().min(10),
  alternativePerspective: z.string().min(10),
});

export const QuestionOutputSchema = z.object({
  questions: z.array(z.string().min(1)).min(2).max(5),
  isComplete: z.boolean(),
});

export const AssessmentOutputSchema = z.object({
  biases: z.array(BiasItemSchema).min(1),
  reflectionPrompt: z.string().min(10),
});

// ─── Types ─────────────────────────────────────────────────

export type GenerateQuestionRequest = z.infer<typeof GenerateQuestionRequestSchema>;
export type GenerateAssessmentRequest = z.infer<typeof GenerateAssessmentRequestSchema>;
export type QuestionOutput = z.infer<typeof QuestionOutputSchema>;
export type AssessmentOutput = z.infer<typeof AssessmentOutputSchema>;
export type BiasItem = z.infer<typeof BiasItemSchema>;