# D007 — `llm_calls` (Observability) vs `reasoning_traces` (Product)

**Decision**: Two separate tables: `llm_calls` stores raw LLM outputs (pre-parse) for debugging/replay. `reasoning_traces` stores validated, parsed traces used by the application. One row per actual provider call — no `retry_count` column.

**Why**: If a call times out and is retried twice, there are 3 rows in `llm_calls`. This makes metrics computation clean — no ambiguity about what retry_count means.

**Do not**: Merge these tables. A failed call with no parse still gets an `llm_calls` row but no `reasoning_traces` row.

**Source**: specs/003-observability-reliability/spec.md (FR2), specs/003-observability-reliability/plan.md
