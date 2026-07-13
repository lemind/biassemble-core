# D017 — Three-Way Bias Provenance Tracking (Engine Vector / Engine LLM / Assessment LLM)

> Supersedes the identically-named draft that was carried over unrevised from the pre-Stage-005
> branch. Revised to (a) target the current async-RAG architecture (`workspace-builder.ts`, not the
> now-vestigial `context-builder.ts`) and (b) remove every place a prior draft of this ADR hardcoded
> a fixed-arity `"both"` value — see Decision 3's rationale.

## Decision 1: Consume the engine's `source` field, superseding the `retrieval_score=0.0` inference rule

**Decision**: `biassemble-engine` ships a `source` field on every `BiasResult` in `POST /retrieve-biases` — an **array** of the methods that surfaced each bias: `["vector"]` | `["llm"]` | `["vector","llm"]`, or `null` for `vector_only`/`nli_union` (populated only under `SELECTION_STRATEGY=llm_union`, per contract v3). It is an array, **not** a collapsed `"both"` string, so each contributing engine signal stays individually visible. Extend `BiasResult`/`EngineResponse` in `src/rag/engine-client.ts` with the additive fields (`source: ("vector"|"llm")[] | null` per bias; top-level `llm_model`, `llm_latency_ms`, `truncated_story`, `llm_scores`, `vector_scores`), and prefer `source` over the `retrieval_score=0.0` heuristic wherever it is present.

**Why**: The inference rule was always a workaround for a missing field. Reading `source` directly distinguishes "the engine's vector search found this" from "the engine's own local LLM found this" from "both signals found it" — the score-based heuristic could only ever tell retrieved-something from retrieved-nothing.

**Do not**: Remove the `retrieval_score=0.0` fallback — `vector_only`/`nli_union` responses still carry `source: null` (contract v3 is additive-only). Only `llm_union` responses get the richer signal.

**Source**: biassemble-engine `specs/004-add-llm-model/contracts/retrieve-biases-v3.md`. `engine-client.ts` is untouched by Stage 005 (async RAG) — this decision applies as originally scoped.

---

## Decision 2: Replace `context_source` with a per-bias engine-signal array

**Decision**: `context_source` — currently `z.enum(["retrieved", "llm", "both"]).optional()` in `src/contracts/reflection.schemas.ts`, assigned in `assessment.service.ts`'s `callProvider()` — is replaced outright by `engineSources: ("vector" | "llm")[]` per bias, copied from the engine's `source` array for that bias:

- `["vector"]` — engine's vector search found it, its local LLM did not
- `["llm"]` — engine's local LLM named it, vector search did not
- `["vector","llm"]` — both engine signals found it (there is no separate `"both"` value — the array's length says it)
- `[]` — the assessment LLM named it with no engine signal for it

**Note on the existing `"both"` enum value**: `context_source`'s `"both"` was already reserved (Stage 005, unmerged/unemitted — see the doc comment on `BiasItemSchema.context_source` at the time of writing) for "a future merge of story_only LLM candidates against the RAG workspace." That future never needs a `"both"` literal — this decision's array replaces it directly, so the reservation is dropped along with the rest of the enum.

**Where this is computed now**: RAG retrieval is async (Stage 005) — `buildBiasWorkspace()` in `src/rag/workspace-builder.ts` (not the legacy `buildBiasContext()` in `context-builder.ts`, which now only serves the hardcoded roster-only stub in `runStoryOnlyAssessment`) builds the workspace from whatever `runs.rag_result` holds by the time `runFullAssessment` runs. `BiasWorkspace` gains a new field, `engineSources: Map<string, EngineSource[]>` (hyphenated catalog id → engine signals — same id normalization already used for `retrievedIds`, same `["vector"]` fallback when `source` is null but `retrieval_score > 0`, per Decision 1's "do not remove the fallback"). `assessment.service.ts`'s `callProvider()` looks each normalized bias up in that map (`engineSourcesMap.get(result.id ?? "") ?? []`) — this requires `callProvider`'s signature to carry the map through from both its callers, since the map is built earlier in `runFullAssessment`/`runStoryOnlyAssessment`, not inside `callProvider` itself.

The request-level RAG status (`RagCase`: `"retrieved" | "roster_fallback" | "unavailable"`) still distinguishes the no-engine-signal case: `engineSources === []` means *assessment-LLM-alone* only when the workspace was actually built from a real retrieval; it means *unknown — engine never ran* when the request had no usable RAG result at all. Keep the request-level status alongside `engineSources` (already flows into the stored comparison record as today) so the two `[]` meanings never collapse into each other.

This is derived, not an extra LLM call. No change to D001 (single LLM call per assessment run stands).

**Why**: Same instrumentation goal as before — knowing, across real requests, how often each signal (engine vector, engine local LLM, assessment LLM alone) gets *confirmed* by the final output.

**Do not**: Treat `["vector","llm"]` as higher-confidence in the *prompt* — this is observability, computed after the model call, and must not change what context the assessment LLM sees. Read `engineSources === []` as "assessment LLM found it alone" when the request-level status says the engine never produced a usable result.

**Source**: `src/orchestrators/reflection/assessment.service.ts` (`callProvider`), `src/rag/workspace-builder.ts` (`BiasWorkspace`), `src/contracts/reflection.schemas.ts` (`BiasItemSchema`).

---

## Decision 3: Persist per-source breakdown as one open-ended map — no fixed-arity columns

**Decision**: Extend `retrieval_comparisons` (`src/db/schema.ts`) with a new `source_breakdown: jsonb`
column, holding a map keyed by whatever source name actually appears in that run's engine response
(plus two small per-run metadata columns, `selection_strategy` and `llm_model`, covered in this
Decision's Migration note below — they carry scalar per-run facts, not source data, and don't affect
the no-fixed-arity argument this Decision makes):

```json
{
  "vector": { "list": ["Confirmation Bias", "Anchoring Bias"], "hitFinal": 2 },
  "llm":    { "list": ["Confirmation Bias", "Halo Effect"],    "hitFinal": 1 }
}
```

`recordComparison()` (`src/observability/comparison-recorder.ts`) builds this by grouping the run's retrieved biases by their (normalized) `source` entries — a bias with `["vector","llm"]` appears under both keys, same as before — and computing each key's `hitFinal` against `finalList`, exactly like the existing aggregate `ragHitFinal` does today. **There is no `ragVectorList`, `ragLlmList`, or `ragBothHitFinal` column, and no `"both"` key.** A combined-signal count (today: "confirmed by both vector and llm") is a **read-time** derivation — intersect `source_breakdown.vector.list` and `source_breakdown.llm.list` — never a stored value. The existing `ragList`, `llmList`, `finalList`, and aggregate `ragHitFinal` columns are untouched (back-compat).

**Why this shape, not per-source columns**: A prior draft of this ADR proposed `ragVectorList`/`ragLlmList` columns plus a dedicated `ragBothHitFinal` column for the two-source overlap. That's a fixed-arity design — it special-cases exactly one combination (vector+llm) and requires a schema migration for every new source the engine ever adds, or every new combination someone wants counted (three sources means a `ragTripleHitFinal` column, etc.). A `Record<sourceName, {list, hitFinal}>` map needs zero schema change when a source is added, removed, or renamed — it falls directly out of Decision 1's own reasoning ("array, not a collapsed string") applied consistently to the aggregate layer instead of stopping at the per-bias layer.

**Do not**: Block the assessment response on this write (D011 — fire-and-forget, try/catch, log-and-continue, unchanged). Add a new LLM call to backfill this — the source split must come from the same engine response already fetched for the current run. Store any derived combination (e.g. "both") as its own key — combinations are computed on read.

**Migration note**: An earlier, never-merged branch applied `rag_vector_list`/`rag_llm_list`/`rag_vector_hit_final`/`rag_llm_hit_final`/`rag_both_hit_final` directly to the live database outside the tracked migration history (drift — `schema.ts` never declared them). Those columns held no real data (one empty test row) and were dropped directly against the live database, out of band, before this ADR's implementation began — not as a step inside the migration that adds `source_breakdown`. That migration is therefore additive-only (`ADD COLUMN` for `source_breakdown`, `selection_strategy`, `llm_model`); it contains no `DROP COLUMN`, since by the time it is written there is nothing left to drop.

**Source**: `src/db/schema.ts` (`retrievalComparisons`), `src/observability/comparison-recorder.ts`, `docs/decisions/011-fire-and-forget-observability.md`.

---

## Non-goals

- No new LLM calls — this is provenance tagging and logging on data already fetched/produced. D001 is unaffected.
- No change to what context the assessment LLM sees or how it's prompted — tags are computed *after* the LLM call.
- Not a precision/accuracy initiative for the engine's local LLM.
- Catalog expansion (38 → 200+ biases) is a distinct future initiative, out of scope here.
- Widening beyond `vector`/`llm` (a hypothetical third engine signal) is not implemented here — the point of Decision 2/3's shapes is that doing so later requires no schema change and no new special-cased field, not that a third source is being built now.
