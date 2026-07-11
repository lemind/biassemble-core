# Quickstart: Verifying Three-Way Bias Provenance Tracking

## Prerequisites

- `biassemble-core` deps installed (`pnpm install`).
- Engine reachable with `SELECTION_STRATEGY=llm_union` (for the rich path), or use the mocked engine
  response fixtures for unit/contract tests.

## Fast local verification (no live engine)

```bash
# Unit + contract tests for the new behavior
pnpm vitest run tests/unit -t "provenance"
pnpm vitest run tests/contract -t "engine-response"
```

Expect:
- `context-builder` returns an `engineSources` map with `["vector"]` / `["llm"]` / `["vector","llm"]`
  and falls back to `["vector"]` when `source` is null but `retrieval_score > 0`.
- `comparison-recorder` produces `ragVectorList` / `ragLlmList` (both-bias in both) and counts
  `ragVectorHitFinal` / `ragLlmHitFinal` / `ragBothHitFinal` consistent with the final list.
- Engine-response parser accepts array `source`, normalizes legacy scalar `"both"`, tolerates absence.

## End-to-end check (live engine, llm_union)

1. Point core at an engine running `SELECTION_STRATEGY=llm_union`.
2. Run a full assessment on a story known to trip both vector and local-LLM signals.
3. Inspect the assessment output: each bias carries `engineSources`.
4. Inspect the stored `retrieval_comparisons` row:
   ```sql
   select rag_list, rag_vector_list, rag_llm_list,
          rag_hit_final, rag_vector_hit_final, rag_llm_hit_final, rag_both_hit_final,
          rag_status
   from core.retrieval_comparisons
   order by created_at desc limit 1;
   ```
   - `rag_vector_list` ∪ `rag_llm_list` covers `rag_list`; a both-source bias appears in both.
   - the three per-source `*_hit_final` counts are ≤ their list sizes and consistent with `final_list`.

## Regression checks

- Run an assessment under `vector_only` / `nli_union`: `engineSources` resolve via the fallback
  (`["vector"]` for retrieved biases), per-source lists may be empty, `rag_list` and existing counts
  unchanged, no errors.
- Force a comparison-store failure (e.g. mock throws): assessment response still returns normally;
  `comparison_record_failed` is logged; nothing propagates to the caller.
- Confirm the model-call count per assessment is unchanged (no new LLM call introduced).

## What "done" looks like

- SC-001..SC-006 in [spec.md](./spec.md) hold.
- No change to the assessment prompt or retrieved context (diff the prompt builder — untouched).
- Migration applies cleanly and is additive (historical rows still valid; new columns nullable).
