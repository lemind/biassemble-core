# Integration Map

This document tracks WHERE cross-cutting functions are called from. Update this when adding new call sites.

## LLM Observability

### `recordLlmCall()`
Records an LLM provider call to the `llm_calls` table.

**Call sites:**
- `src/observability/llm-call-recorder.ts:61` — Inside `executeAndRecordLlmCall()` helper
  - Called by `assessment.service.ts:199` (primary call)
  - Called by `assessment.service.ts:225` (fallback call)
  - Called by `question.service.ts:66` (primary call)
  - Called by `question.service.ts:87` (fallback call)

### `executeAndRecordLlmCall()`
Helper that wraps provider calls with timing, error handling, and recording.

**Call sites:**
- `src/orchestrators/reflection/assessment.service.ts:199` — Primary assessment call
- `src/orchestrators/reflection/assessment.service.ts:225` — Fallback assessment call
- `src/orchestrators/reflection/question.service.ts:66` — Primary question generation call
- `src/orchestrators/reflection/question.service.ts:87` — Fallback question generation call

### `updateLlmCallParsedOutput()`
Updates the `parsed_output` field after successful parsing/repair.

**Call sites:**
- `src/orchestrators/reflection/assessment.service.ts:238` — After fallback parsing succeeds
- `src/orchestrators/reflection/assessment.service.ts:251` — After primary parsing succeeds
- `src/orchestrators/reflection/question.service.ts:100` — After fallback parsing succeeds
- `src/orchestrators/reflection/question.service.ts:113` — After primary parsing succeeds

## Reasoning Traces

### `persistTrace()`
Persists a reasoning trace to the `reasoning_traces` table.

**Call sites:**
- `src/orchestrators/reflection/assessment.service.ts:270` — After assessment parsing completes

## Evidence Validation

### `validateEvidence()`
Validates that bias evidence excerpts are grounded in the input story/answers.

**Call sites:**
- `src/orchestrators/reflection/assessment.service.ts:309` — After bias name normalization

## Evaluation Metrics

### `computeEvaluationMetrics()`
Computes evidence_grounded_rate and false_positive_rate for an assessment.

**Call sites:**
- `src/evaluation/run-eval.ts:123` — During evaluation scenario execution
- `src/evaluation/run-eval.ts:175` — During no-bias dataset evaluation

## Provider Interface

### `Provider.completeJson()`
Calls the LLM provider and returns structured JSON response with token usage.

**Call sites:**
- `src/orchestrators/reflection/assessment.service.ts:200` — Primary assessment (wrapped in executeAndRecordLlmCall)
- `src/orchestrators/reflection/assessment.service.ts:226` — Fallback assessment (wrapped in executeAndRecordLlmCall)
- `src/orchestrators/reflection/question.service.ts:67` — Primary question generation (wrapped in executeAndRecordLlmCall)
- `src/orchestrators/reflection/question.service.ts:88` — Fallback question generation (wrapped in executeAndRecordLlmCall)

## Adding New Functions

When you create a new cross-cutting function:

1. Add an entry to this document
2. List all call sites with file path and line number
3. Note any architectural constraints (e.g., "only called from X")
4. Update when new call sites are added
