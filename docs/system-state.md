# System State

Last updated: 2026-06-19

## Active Stage

**003-observability-reliability** — Phase 1 (DB schema + LLM call recording)

## What's Deployed

- **Assessment flow**: Story-only and full assessment with reasoning traces
- **Question flow**: Contextual follow-up question generation
- **Reasoning schemas**: Zod-validated AssessmentOutput, QuestionOutput, ReasoningTrace
- **Eval metrics**: computeEvaluationMetrics(), computeSystemMetrics()
- **Drizzle schema**: runs, reasoning_traces, eval_results, llm_calls tables
- **LLM call recording**: recordLlmCall() captures provider calls with token usage, timing, errors
- **Inngest eval job**: Stub implementation (not yet running real evaluations)

## Known Issues

- **gemini-2.0-flash deprecation**: Deprecates June 1, 2026 → migrate to gemini-2.5-flash
- **Pre-existing test failures**: 16 tests failing (normalize, prompt_version, noBiasDetected) — unrelated to Stage 003 work

## Test Status

- **Total**: 277 tests
- **Passing**: 261
- **Failing**: 16 (pre-existing, not blocking)

Run `pnpm test:run` for current count.

## Last Real Eval Run

**None yet** — all evaluations have used MockProvider. Real Gemini eval not yet executed.

## Database Migrations

- `0001_initial.sql` — runs, reasoning_traces, eval_results
- `0002_eval_extensions.sql` — eval_results extensions
- `0003_observability_reliability.sql` — llm_calls table, eval_results Stage 003 columns

## Next Steps

1. Complete Phase 2: Reliability metrics aggregation
2. Run first real eval with Gemini 2.5-flash
3. Implement pipeline outcome tracking (Stage 004)
