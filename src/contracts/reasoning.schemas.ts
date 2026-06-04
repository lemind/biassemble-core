import { z } from "zod";

// ─── Branded types ──────────────────────────────────────────

/** Opaque string type for prompt version tracking. */
export const PromptVersionSchema = z.string().min(1).brand("PromptVersion");
export type PromptVersion = z.infer<typeof PromptVersionSchema>;

// ─── Enums ──────────────────────────────────────────────────

export const StageEnum = z.enum([
  "initial_assessment",
  "post_questions_assessment",
]);

export const ScopeEnum = z.enum(["story_only", "story_plus_answers"]);

export const SourceEnum = z.enum(["story", "answer"]);

export const DatasetEnum = z.enum(["golden", "no_bias", "all"]);

export const SeverityEnum = z.enum(["low", "medium", "high"]);

// ─── Reasoning schemas ──────────────────────────────────────

export const EvidenceEntrySchema = z.object({
  source: SourceEnum,
  excerpt: z.string().min(1),
  relevance: z.string().min(1),
});
export type EvidenceEntry = z.infer<typeof EvidenceEntrySchema>;

export const StoryAnalysisSchema = z.object({
  themes: z.array(z.string()),
  emotional_tone: z.string(),
  key_events: z.array(z.string()),
});
export type StoryAnalysis = z.infer<typeof StoryAnalysisSchema>;

export const InterpretationSchema = z.object({
  interpretation: z.string().min(1),
  plausibility: z.number().min(0).max(1),
  supporting_evidence: z.array(z.string()),
  rejected: z.boolean().optional(),
});
export type Interpretation = z.infer<typeof InterpretationSchema>;

export const BiasHypothesisSchema = z
  .object({
    bias_name: z.string().min(1),
    confidence: z.number().min(0).max(1),
    supporting_excerpts: z.array(z.string()),
    uncertainty_reasons: z.array(z.string().min(1)),
  })
  .refine(
    (h) => h.confidence >= 0.8 || h.uncertainty_reasons.length > 0,
    { message: "uncertainty_reasons required when confidence < 0.8" },
  );
export type BiasHypothesis = z.infer<typeof BiasHypothesisSchema>;

export const EvidenceMappingSchema = z.object({
  bias_id: z.string().min(1),
  evidence: z.array(EvidenceEntrySchema).min(1),
});
export type EvidenceMapping = z.infer<typeof EvidenceMappingSchema>;

export const ReasoningTraceSchema = z.object({
  story_analysis: StoryAnalysisSchema,
  interpretations: z.array(InterpretationSchema),
  bias_hypotheses: z.array(BiasHypothesisSchema),
  evidence_mapping: z.array(EvidenceMappingSchema),
  prompt_version: PromptVersionSchema,
});
export type ReasoningTrace = z.infer<typeof ReasoningTraceSchema>;

// ─── Session / Run schemas ──────────────────────────────────

export const ReflectionSessionSchema = z.object({
  id: z.string().uuid(),
  story_id: z.string().uuid(),
  created_at: z.string().datetime(),
});

/** SHA-256 of the canonical input string: story + answers joined with '\n\n' */
export const RunSchema = z
  .object({
    id: z.string().uuid(),
    session_id: z.string().uuid(),
    model_name: z.string().min(1),
    stage: StageEnum,
    scope: ScopeEnum,
    prompt_version: PromptVersionSchema,
    input_hash: z.string().min(1),
    created_at: z.string().datetime(),
  })
  .refine(
    (r) =>
      (r.stage === "initial_assessment" && r.scope === "story_only") ||
      (r.stage === "post_questions_assessment" && r.scope === "story_plus_answers"),
    { message: "stage and scope must be consistent: initial_assessment ↔ story_only, post_questions_assessment ↔ story_plus_answers" },
  );

// ─── Evaluation result schema ───────────────────────────────

export const EvaluationMetricsSchema = z.object({
  evidence_grounded_rate: z.number().min(0).max(1).nullable(),
  false_positive_rate: z.number().min(0).max(1).nullable(),
});

export const SystemMetricsSchema = z.object({
  schema_parse_rate: z.number().min(0).max(1).nullable(),
  repair_rate: z.number().min(0).max(1).nullable(),
});

/** SHA-256 of the canonical input string: story + answers joined with '\n\n' */
export const EvalResultSchema = z.object({
  id: z.string().uuid(),
  run_id: z.string().uuid().optional(),
  prompt_version: z.string().min(1),
  model_name: z.string().min(1),
  dataset: DatasetEnum,
  evaluation_metrics: EvaluationMetricsSchema,
  system_metrics: SystemMetricsSchema,
  input_hash: z.string().min(1),
  passed: z.boolean(),
  run_at: z.string().datetime(),
});

// ─── Reserved stubs (not populated in MVP) ──────────────────

/**
 * @deprecated — stub only, not final shape.
 * Full Claim has: id, text, source, span, confidence.
 */
export const ClaimSchema = z.object({
  claim: z.string().min(1),
  source: SourceEnum,
});
export type Claim = z.infer<typeof ClaimSchema>;

export const ProviderComparisonSchema = z.object({
  prompt_version: PromptVersionSchema,
  results: z.record(z.string(), z.unknown()),
  disagreement_score: z.number().min(0).max(1).optional(),
});

export const ContradictionSchema = z.object({
  statement_a: z.string().min(1),
  statement_b: z.string().min(1),
  severity: SeverityEnum,
});