import { describe, it, expect } from "vitest";
import {
  PromptVersionSchema,
  StageEnum,
  ScopeEnum,
  SourceEnum,
  DatasetEnum,
  SeverityEnum,
  EvidenceEntrySchema,
  StoryAnalysisSchema,
  InterpretationSchema,
  BiasHypothesisSchema,
  EvidenceMappingSchema,
  ReasoningTraceSchema,
  ReflectionSessionSchema,
  RunSchema,
  EvaluationMetricsSchema,
  SystemMetricsSchema,
  EvalResultSchema,
} from "../../../src/contracts/reasoning.schemas.js";

describe("T501 — reasoning.schemas", () => {
  // ─── Branded types ──────────────────────────────────────────

  describe("PromptVersionSchema", () => {
    it("should accept non-empty string", () => {
      expect(() => PromptVersionSchema.parse("v1.0")).not.toThrow();
    });

    it("should reject empty string", () => {
      expect(() => PromptVersionSchema.parse("")).toThrow();
    });
  });

  // ─── Enums ──────────────────────────────────────────────────

  describe("StageEnum", () => {
    it("should accept valid stages", () => {
      expect(StageEnum.parse("initial_assessment")).toBe("initial_assessment");
      expect(StageEnum.parse("post_questions_assessment")).toBe("post_questions_assessment");
    });

    it("should reject invalid stage", () => {
      expect(() => StageEnum.parse("invalid")).toThrow();
    });
  });

  describe("ScopeEnum", () => {
    it("should accept valid scopes", () => {
      expect(ScopeEnum.parse("story_only")).toBe("story_only");
      expect(ScopeEnum.parse("story_plus_answers")).toBe("story_plus_answers");
    });

    it("should reject invalid scope", () => {
      expect(() => ScopeEnum.parse("invalid")).toThrow();
    });
  });

  describe("SourceEnum", () => {
    it("should accept valid sources", () => {
      expect(SourceEnum.parse("story")).toBe("story");
      expect(SourceEnum.parse("answer")).toBe("answer");
    });

    it("should reject invalid source", () => {
      expect(() => SourceEnum.parse("external")).toThrow();
    });
  });

  describe("DatasetEnum", () => {
    it("should accept valid datasets", () => {
      expect(DatasetEnum.parse("golden")).toBe("golden");
      expect(DatasetEnum.parse("no_bias")).toBe("no_bias");
      expect(DatasetEnum.parse("all")).toBe("all");
    });

    it("should reject invalid dataset", () => {
      expect(() => DatasetEnum.parse("invalid")).toThrow();
    });
  });

  describe("SeverityEnum", () => {
    it("should accept valid severities", () => {
      expect(SeverityEnum.parse("low")).toBe("low");
      expect(SeverityEnum.parse("medium")).toBe("medium");
      expect(SeverityEnum.parse("high")).toBe("high");
    });

    it("should reject invalid severity", () => {
      expect(() => SeverityEnum.parse("critical")).toThrow();
    });
  });

  // ─── EvidenceEntry ──────────────────────────────────────────

  describe("EvidenceEntrySchema", () => {
    it("should accept valid evidence entry", () => {
      const entry = { source: "story", excerpt: "some text", relevance: "relevant" };
      expect(() => EvidenceEntrySchema.parse(entry)).not.toThrow();
    });

    it("should reject empty excerpt", () => {
      const entry = { source: "story", excerpt: "", relevance: "relevant" };
      expect(() => EvidenceEntrySchema.parse(entry)).toThrow();
    });

    it("should reject empty relevance", () => {
      const entry = { source: "story", excerpt: "text", relevance: "" };
      expect(() => EvidenceEntrySchema.parse(entry)).toThrow();
    });

    it("should reject invalid source", () => {
      const entry = { source: "external", excerpt: "text", relevance: "relevant" };
      expect(() => EvidenceEntrySchema.parse(entry)).toThrow();
    });
  });

  // ─── StoryAnalysis ──────────────────────────────────────────

  describe("StoryAnalysisSchema", () => {
    it("should accept valid story analysis", () => {
      const analysis = {
        themes: ["conflict", "resolution"],
        emotional_tone: "tense",
        key_events: ["argument", "apology"],
      };
      expect(() => StoryAnalysisSchema.parse(analysis)).not.toThrow();
    });

    it("should reject missing fields", () => {
      expect(() => StoryAnalysisSchema.parse({ themes: [] })).toThrow();
    });
  });

  // ─── Interpretation ─────────────────────────────────────────

  describe("InterpretationSchema", () => {
    it("should accept valid interpretation", () => {
      const interpretation = {
        interpretation: "The user feels conflicted",
        plausibility: 0.8,
        supporting_evidence: ["quote from story"],
      };
      expect(() => InterpretationSchema.parse(interpretation)).not.toThrow();
    });

    it("should accept interpretation with rejected flag", () => {
      const interpretation = {
        interpretation: "Alternative view",
        plausibility: 0.3,
        supporting_evidence: [],
        rejected: true,
      };
      expect(() => InterpretationSchema.parse(interpretation)).not.toThrow();
    });

    it("should reject plausibility out of range", () => {
      const interpretation = {
        interpretation: "Test",
        plausibility: 1.5,
        supporting_evidence: [],
      };
      expect(() => InterpretationSchema.parse(interpretation)).toThrow();
    });

    it("should reject empty interpretation", () => {
      const interpretation = {
        interpretation: "",
        plausibility: 0.5,
        supporting_evidence: [],
      };
      expect(() => InterpretationSchema.parse(interpretation)).toThrow();
    });
  });

  // ─── BiasHypothesis ─────────────────────────────────────────

  describe("BiasHypothesisSchema", () => {
    it("should accept valid hypothesis with high confidence", () => {
      const hypothesis = {
        bias_name: "confirmation bias",
        confidence: 0.9,
        supporting_excerpts: ["quote"],
        uncertainty_reasons: [],
      };
      expect(() => BiasHypothesisSchema.parse(hypothesis)).not.toThrow();
    });

    it("should require uncertainty_reasons when confidence < 0.8", () => {
      const hypothesis = {
        bias_name: "confirmation bias",
        confidence: 0.7,
        supporting_excerpts: ["quote"],
        uncertainty_reasons: [],
      };
      expect(() => BiasHypothesisSchema.parse(hypothesis)).toThrow();
    });

    it("should accept low confidence with uncertainty reasons", () => {
      const hypothesis = {
        bias_name: "confirmation bias",
        confidence: 0.5,
        supporting_excerpts: ["quote"],
        uncertainty_reasons: ["Not enough data"],
      };
      expect(() => BiasHypothesisSchema.parse(hypothesis)).not.toThrow();
    });

    it("should reject empty bias_name", () => {
      const hypothesis = {
        bias_name: "",
        confidence: 0.9,
        supporting_excerpts: [],
        uncertainty_reasons: [],
      };
      expect(() => BiasHypothesisSchema.parse(hypothesis)).toThrow();
    });
  });

  // ─── EvidenceMapping ────────────────────────────────────────

  describe("EvidenceMappingSchema", () => {
    it("should accept valid evidence mapping", () => {
      const mapping = {
        bias_id: "bias-1",
        evidence: [{ source: "story", excerpt: "text", relevance: "relevant" }],
      };
      expect(() => EvidenceMappingSchema.parse(mapping)).not.toThrow();
    });

    it("should reject empty evidence array", () => {
      const mapping = { bias_id: "bias-1", evidence: [] };
      expect(() => EvidenceMappingSchema.parse(mapping)).toThrow();
    });

    it("should reject empty bias_id", () => {
      const mapping = {
        bias_id: "",
        evidence: [{ source: "story", excerpt: "text", relevance: "relevant" }],
      };
      expect(() => EvidenceMappingSchema.parse(mapping)).toThrow();
    });
  });

  // ─── ReasoningTrace ─────────────────────────────────────────

  describe("ReasoningTraceSchema", () => {
    const validTrace = {
      story_analysis: {
        themes: ["conflict"],
        emotional_tone: "tense",
        key_events: ["argument"],
      },
      interpretations: [
        {
          interpretation: "User feels conflicted",
          plausibility: 0.8,
          supporting_evidence: ["quote"],
        },
      ],
      bias_hypotheses: [
        {
          bias_name: "confirmation bias",
          confidence: 0.9,
          supporting_excerpts: ["quote"],
          uncertainty_reasons: [],
        },
      ],
      evidence_mapping: [
        {
          bias_id: "bias-1",
          evidence: [{ source: "story", excerpt: "text", relevance: "relevant" }],
        },
      ],
      prompt_version: "v1.0",
    };

    it("should accept valid reasoning trace", () => {
      expect(() => ReasoningTraceSchema.parse(validTrace)).not.toThrow();
    });

    it("should reject missing prompt_version", () => {
      const { prompt_version: _, ...rest } = validTrace;
      expect(() => ReasoningTraceSchema.parse(rest)).toThrow();
    });
  });

  // ─── ReflectionSession ──────────────────────────────────────

  describe("ReflectionSessionSchema", () => {
    it("should accept valid session", () => {
      const session = {
        id: "00000000-0000-4000-8000-000000000001",
        story_id: "00000000-0000-4000-8000-000000000002",
        created_at: "2026-01-01T00:00:00Z",
      };
      expect(() => ReflectionSessionSchema.parse(session)).not.toThrow();
    });

    it("should reject non-uuid id", () => {
      const session = {
        id: "not-a-uuid",
        story_id: "00000000-0000-4000-8000-000000000002",
        created_at: "2026-01-01T00:00:00Z",
      };
      expect(() => ReflectionSessionSchema.parse(session)).toThrow();
    });
  });

  // ─── Run ────────────────────────────────────────────────────

  describe("RunSchema", () => {
    const validRun = {
      id: "00000000-0000-4000-8000-000000000001",
      session_id: "00000000-0000-4000-8000-000000000002",
      model_name: "gemini-2.0-flash",
      stage: "initial_assessment",
      scope: "story_only",
      prompt_version: "v1.0",
      input_hash: "abc123",
      created_at: "2026-01-01T00:00:00Z",
    };

    it("should accept valid run", () => {
      expect(() => RunSchema.parse(validRun)).not.toThrow();
    });

    it("should reject inconsistent stage/scope (initial + story_plus_answers)", () => {
      const run = { ...validRun, stage: "initial_assessment", scope: "story_plus_answers" };
      expect(() => RunSchema.parse(run)).toThrow();
    });

    it("should reject inconsistent stage/scope (post_questions + story_only)", () => {
      const run = { ...validRun, stage: "post_questions_assessment", scope: "story_only" };
      expect(() => RunSchema.parse(run)).toThrow();
    });

    it("should accept post_questions + story_plus_answers", () => {
      const run = { ...validRun, stage: "post_questions_assessment", scope: "story_plus_answers" };
      expect(() => RunSchema.parse(run)).not.toThrow();
    });
  });

  // ─── EvaluationMetrics ──────────────────────────────────────

  describe("EvaluationMetricsSchema", () => {
    it("should accept valid metrics", () => {
      const metrics = { evidence_grounded_rate: 0.95, false_positive_rate: 0.05 };
      expect(() => EvaluationMetricsSchema.parse(metrics)).not.toThrow();
    });

    it("should accept null values", () => {
      const metrics = { evidence_grounded_rate: null, false_positive_rate: null };
      expect(() => EvaluationMetricsSchema.parse(metrics)).not.toThrow();
    });

    it("should reject out of range", () => {
      const metrics = { evidence_grounded_rate: 1.5, false_positive_rate: 0.5 };
      expect(() => EvaluationMetricsSchema.parse(metrics)).toThrow();
    });
  });

  // ─── SystemMetrics ──────────────────────────────────────────

  describe("SystemMetricsSchema", () => {
    it("should accept valid metrics", () => {
      const metrics = { schema_parse_rate: 1.0, repair_rate: 0.5 };
      expect(() => SystemMetricsSchema.parse(metrics)).not.toThrow();
    });

    it("should accept null values", () => {
      const metrics = { schema_parse_rate: null, repair_rate: null };
      expect(() => SystemMetricsSchema.parse(metrics)).not.toThrow();
    });
  });

  // ─── EvalResult ─────────────────────────────────────────────

  describe("EvalResultSchema", () => {
    const validEvalResult = {
      id: "00000000-0000-4000-8000-000000000001",
      prompt_version: "v1.0",
      model_name: "gemini-2.0-flash",
      dataset: "golden",
      evaluation_metrics: { evidence_grounded_rate: 0.9, false_positive_rate: 0.1 },
      system_metrics: { schema_parse_rate: 1.0, repair_rate: 0.5 },
      input_hash: "abc123",
      passed: true,
      run_at: "2026-01-01T00:00:00Z",
    };

    it("should accept valid eval result", () => {
      expect(() => EvalResultSchema.parse(validEvalResult)).not.toThrow();
    });

    it("should accept eval result with optional run_id", () => {
      const result = { ...validEvalResult, run_id: "00000000-0000-4000-8000-000000000002" };
      expect(() => EvalResultSchema.parse(result)).not.toThrow();
    });

    it("should reject invalid dataset", () => {
      const result = { ...validEvalResult, dataset: "invalid" };
      expect(() => EvalResultSchema.parse(result)).toThrow();
    });

    it("should reject empty prompt_version", () => {
      const result = { ...validEvalResult, prompt_version: "" };
      expect(() => EvalResultSchema.parse(result)).toThrow();
    });
  });
});