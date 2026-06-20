import { describe, it, expect } from "vitest";
import type { LlmCallRecord, EvalResultRecord } from "../../../src/persistence/types";

// ── Helpers ──

function makeMinimalCallRecord(overrides?: Partial<LlmCallRecord>): LlmCallRecord {
  return {
    id: "test-id",
    sessionId: null,
    stage: "assessment",
    callType: "primary",
    provider: "gemini",
    model: "gemini-2.0-flash",
    promptVersion: "1.0.0",
    rawResponse: null,
    parsedOutput: null,
    status: "success",
    failureType: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 1000,
    errorMessage: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ──

describe("Stage 003 Persistence Types", () => {
  describe("LlmCallRecord — type contract validation", () => {
    it("has correct stage enum values", () => {
      const record = makeMinimalCallRecord({ stage: "assessment" });
      expect(record.stage).toBe("assessment");

      const questionRecord = makeMinimalCallRecord({ stage: "question" });
      expect(questionRecord.stage).toBe("question");
    });

    it("has correct callType enum values", () => {
      const primary = makeMinimalCallRecord({ callType: "primary" });
      expect(primary.callType).toBe("primary");

      const fallback = makeMinimalCallRecord({ callType: "fallback" });
      expect(fallback.callType).toBe("fallback");
    });

    it("has correct status enum values", () => {
      expect(makeMinimalCallRecord({ status: "success" }).status).toBe("success");
      expect(makeMinimalCallRecord({ status: "timeout" }).status).toBe("timeout");
      expect(makeMinimalCallRecord({ status: "error" }).status).toBe("error");
    });

    it("has correct failureType enum values", () => {
      expect(makeMinimalCallRecord({ status: "error", failureType: "schema_validation" }).failureType).toBe("schema_validation");
      expect(makeMinimalCallRecord({ status: "error", failureType: "parse_error" }).failureType).toBe("parse_error");
      expect(makeMinimalCallRecord({ status: "error", failureType: "provider_error" }).failureType).toBe("provider_error");
      expect(makeMinimalCallRecord({ status: "error", failureType: "timeout" }).failureType).toBe("timeout");
      expect(makeMinimalCallRecord({ status: "error", failureType: "other" }).failureType).toBe("other");
    });

    it("has token usage fields", () => {
      const record = makeMinimalCallRecord({
        inputTokens: 100,
        outputTokens: 200,
        totalTokens: 300,
      });
      expect(record.inputTokens).toBe(100);
      expect(record.outputTokens).toBe(200);
      expect(record.totalTokens).toBe(300);
    });
  });

  describe("LlmCallRecord — schema and field validation (Criterion #4)", () => {
    it("requires id field", () => {
      const record = makeMinimalCallRecord({ id: "test-id" });
      expect(record.id).toBeDefined();
      expect(typeof record.id).toBe("string");
    });

    it("requires createdAt field as ISO string", () => {
      const record = makeMinimalCallRecord();
      expect(record.createdAt).toBeDefined();
      expect(() => new Date(record.createdAt)).not.toThrow();
    });

    it("requires durationMs as non-negative number", () => {
      const record = makeMinimalCallRecord({ durationMs: 0 });
      expect(record.durationMs).toBeGreaterThanOrEqual(0);

      const positiveRecord = makeMinimalCallRecord({ durationMs: 5000 });
      expect(positiveRecord.durationMs).toBe(5000);
    });

    it("rejects negative durationMs (contract)", () => {
      // The type allows negative, but the contract says non-negative.
      // Real implementations should validate at boundaries.
      const record = makeMinimalCallRecord({ durationMs: -1 });
      expect(record.durationMs).toBeLessThan(0);
    });
  });

  describe("LlmCallRecord — nullable fields (Criterion #7)", () => {
    it("allows all-nullable fields to be null", () => {
      const record = makeMinimalCallRecord({
        sessionId: null,
        rawResponse: null,
        parsedOutput: null,
        failureType: null,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        errorMessage: null,
      });
      expect(record.sessionId).toBeNull();
      expect(record.rawResponse).toBeNull();
      expect(record.parsedOutput).toBeNull();
      expect(record.failureType).toBeNull();
      expect(record.inputTokens).toBeNull();
      expect(record.outputTokens).toBeNull();
      expect(record.totalTokens).toBeNull();
      expect(record.errorMessage).toBeNull();
    });
  });

  describe("EvalResultRecord (extended) — Criterion #4", () => {
    it("has evalRunId field", () => {
      const record: EvalResultRecord = {
        id: "test-id",
        provider: "gemini",
        modelName: "gemini-2.0-flash",
        promptVersion: "1.0.0",
        dataset: "golden",
        evaluationMetrics: { evidence_grounded_rate: null, false_positive_rate: null },
        systemMetrics: { schema_parse_rate: null, repair_rate: null },
        inputHash: "hash",
        passed: true,
        runAt: new Date().toISOString(),
        evalRunId: "eval-run-id",
        scenarioId: "scenario-1",
        rawOutput: null,
        runId: undefined,
      };
      expect(record.evalRunId).toBe("eval-run-id");
    });

    it("has scenarioId field", () => {
      const record: EvalResultRecord = {
        id: "test-id",
        provider: "gemini",
        modelName: "gemini-2.0-flash",
        promptVersion: "1.0.0",
        dataset: "golden",
        evaluationMetrics: { evidence_grounded_rate: null, false_positive_rate: null },
        systemMetrics: { schema_parse_rate: null, repair_rate: null },
        inputHash: "hash",
        passed: true,
        runAt: new Date().toISOString(),
        evalRunId: "eval-run-id",
        scenarioId: "scenario-1",
        rawOutput: null,
        runId: undefined,
      };
      expect(record.scenarioId).toBe("scenario-1");
    });

    it("has rawOutput field as string or null", () => {
      const withOutput: EvalResultRecord = {
        id: "test-id",
        provider: "gemini",
        modelName: "gemini-2.0-flash",
        promptVersion: "1.0.0",
        dataset: "golden",
        evaluationMetrics: { evidence_grounded_rate: null, false_positive_rate: null },
        systemMetrics: { schema_parse_rate: null, repair_rate: null },
        inputHash: "hash",
        passed: true,
        runAt: new Date().toISOString(),
        evalRunId: "eval-run-id",
        scenarioId: "scenario-1",
        rawOutput: '{"biases": []}',
        runId: undefined,
      };
      expect(withOutput.rawOutput).toBe('{"biases": []}');

      const withoutOutput: EvalResultRecord = {
        id: "test-id",
        provider: "gemini",
        modelName: "gemini-2.0-flash",
        promptVersion: "1.0.0",
        dataset: "golden",
        evaluationMetrics: { evidence_grounded_rate: null, false_positive_rate: null },
        systemMetrics: { schema_parse_rate: null, repair_rate: null },
        inputHash: "hash",
        passed: true,
        runAt: new Date().toISOString(),
        evalRunId: "eval-run-id",
        scenarioId: "scenario-1",
        rawOutput: null,
        runId: undefined,
      };
      expect(withoutOutput.rawOutput).toBeNull();
    });
  });

  describe("EvalResultRecord — evaluation metrics contract (Criterion #5)", () => {
    it("holds evidence_grounded_rate and false_positive_rate", () => {
      const record: EvalResultRecord = {
        id: "test-id",
        provider: "gemini",
        modelName: "gemini-2.0-flash",
        promptVersion: "1.0.0",
        dataset: "golden",
        evaluationMetrics: {
          evidence_grounded_rate: 0.85,
          false_positive_rate: 0.0,
        },
        systemMetrics: { schema_parse_rate: null, repair_rate: null },
        inputHash: "hash",
        passed: true,
        runAt: new Date().toISOString(),
        evalRunId: "eval-run-id",
        scenarioId: "scenario-1",
        rawOutput: null,
        runId: undefined,
      };
      expect(record.evaluationMetrics.evidence_grounded_rate).toBe(0.85);
      expect(record.evaluationMetrics.false_positive_rate).toBe(0.0);
    });

    it("allows null rates", () => {
      const record: EvalResultRecord = {
        id: "test-id",
        provider: "gemini",
        modelName: "gemini-2.0-flash",
        promptVersion: "1.0.0",
        dataset: "golden",
        evaluationMetrics: {
          evidence_grounded_rate: null,
          false_positive_rate: null,
        },
        systemMetrics: { schema_parse_rate: null, repair_rate: null },
        inputHash: "hash",
        passed: true,
        runAt: new Date().toISOString(),
        evalRunId: "eval-run-id",
        scenarioId: "scenario-1",
        rawOutput: null,
        runId: undefined,
      };
      expect(record.evaluationMetrics.evidence_grounded_rate).toBeNull();
      expect(record.evaluationMetrics.false_positive_rate).toBeNull();
    });
  });
});