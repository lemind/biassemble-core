# Integration Map

Ownership rules for cross-cutting functions. Update when adding new call sites.

## LLM Observability

### `recordLlmCall()`
Records an LLM provider call to the `llm_calls` table.

**Ownership:** Only called from inside `executeAndRecordLlmCall()`.

### `executeAndRecordLlmCall()`
Wraps provider calls with timing, error handling, and recording.

**Ownership:** Only called from orchestrator services:
- `assessment.service.ts` — primary and fallback assessment calls
- `question.service.ts` — primary and fallback question generation calls

### `updateLlmCallParsedOutput()`
Updates the `parsed_output` field after successful parsing/repair.

**Ownership:** Only called from orchestrator services, immediately after a successful parse:
- `assessment.service.ts` — after fallback or primary parsing succeeds
- `question.service.ts` — after fallback or primary parsing succeeds

## Reasoning Traces

### `persistTrace()`
Persists a reasoning trace to the `reasoning_traces` table.

**Ownership:** Only called from `assessment.service.ts`, after assessment parsing completes.

## Evidence Validation

### `validateEvidence()`
Validates that bias evidence excerpts are grounded in the input story/answers.

**Ownership:** Only called from `assessment.service.ts`, after bias name normalization.

## Evaluation Metrics

### `computeEvaluationMetrics()`
Computes evidence_grounded_rate and false_positive_rate for an assessment.

**Ownership:** Only called from `run-eval.ts` during evaluation scenario execution.

## Provider Interface

### `Provider.completeJson()`
Calls the LLM provider and returns structured JSON response with token usage.

**Ownership:** Only called via `executeAndRecordLlmCall()` in orchestrator services — never directly.

## Adding New Functions

When you create a new cross-cutting function:

1. Add an entry to this document
2. State the ownership rule (who may call it, and under what constraints)
3. Update when new call sites are added
