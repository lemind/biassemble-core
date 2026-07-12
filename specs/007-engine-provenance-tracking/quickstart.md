# Quickstart: Verifying Engine Provenance Tracking

## Fast local verification (no live engine)

```bash
pnpm vitest run tests/unit/rag -t "engineSources"
pnpm vitest run tests/unit/observability -t "breakdown"
```

Expect:
- `workspace-builder` returns an `engineSources` map with `["vector"]` / `["llm"]` /
  `["vector","llm"]`, falling back to `["vector"]` when `source` is null but `retrieval_score > 0`.
- `comparison-recorder` produces a `sourceBreakdown` map keyed by whatever source names were present
  in the input — test this with a fake third source name (e.g. `"reranker"`) to prove the recorder
  makes no assumption about exactly two sources.
- Nowhere in the test suite does an assertion check for a literal `"both"` value in stored or
  returned data — grep the test files for `"both"` and confirm zero hits outside of comments
  describing what NOT to do.

## End-to-end check (live engine, per-bias source populated)

1. Run a full assessment on a story where the background retrieval job returns biases with per-bias
   `source` populated.
2. Inspect the assessment output: each bias carries `engineSources`.
3. Inspect the stored `retrieval_comparisons` row:
   ```sql
   select rag_list, source_breakdown, rag_hit_final, rag_status, selection_strategy, llm_model
   from core.retrieval_comparisons
   order by created_at desc limit 1;
   ```
   - `source_breakdown` has one key per distinct source that appeared, each with its own `list` and
     `hitFinal`.
   - No key named `both` exists.
   - `selection_strategy`/`llm_model` are populated whenever `source_breakdown` is — use
     `WHERE selection_strategy = 'llm_union'` for SC-003 cohort queries instead of
     `source_breakdown IS NOT NULL`, which is only a proxy.
   - To get a "confirmed by both vector and llm" count: unnest each side with
     `jsonb_array_elements_text(source_breakdown->'vector'->'list')` /
     `...->'llm'->'list'` and `INTERSECT` the two result sets (Postgres `jsonb` has no single
     built-in array-intersection function, so this takes a small subquery, not a single operator) —
     confirm the count this produces is computable at all without a dedicated stored field, which is
     the actual point: the capability exists without persisting a `both` value, even though the query
     to exercise it isn't one line.

## Regression checks

- Run an assessment where the background retrieval result has no per-bias `source` field at all:
  `engineSources` resolves via the fallback (`["vector"]` for retrieved biases), `source_breakdown`
  has a single `vector` key, `rag_list` and existing counts unchanged, no errors.
- Force a comparison-store failure: assessment response still returns normally; failure logged;
  nothing propagates to the caller.
- Confirm the model-call count per assessment is unchanged (no new LLM call introduced).
- Confirm `context_source` no longer appears anywhere in `src/**/*.ts` (grep), and that the schema
  change doesn't break any existing consumer (none currently read it besides the files this feature
  touches — confirmed via grep before starting).

## What "done" looks like

- SC-001..SC-007 in [spec.md](./spec.md) hold — SC-007 specifically: grep the entire diff for the
  string `"both"` outside of comments/docs explaining why it's absent, and confirm zero hits.
- No change to the assessment prompt or retrieved context.
- Migration applies cleanly, additively, and is the only schema change (no other columns touched).
