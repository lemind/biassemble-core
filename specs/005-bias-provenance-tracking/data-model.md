# Phase 1 Data Model: Three-Way Bias Provenance Tracking

Delta from Stage 004 (RAG integration). Only additive changes.

## 1. Engine response (consumed shape) — `src/rag/engine-client.ts`

### `BiasResult` (extended)

| Field | Type | Notes |
|-------|------|-------|
| id, name, retrieval_score, definition, examples, indicators, false_positives, related_biases | (existing) | unchanged |
| `source` | `("vector" \| "llm")[] \| null` | **NEW, additive.** Which engine signal(s) surfaced the bias. `null`/absent under `vector_only`/`nli_union`. Parser normalizes a legacy scalar `"both"`→`["vector","llm"]`, `"vector"`→`["vector"]`, `"llm"`→`["llm"]` (see research R1). |

### `EngineResponse` (extended, all NEW fields additive + optional)

| Field | Type | Notes |
|-------|------|-------|
| biases, retrieved_chunks, taxonomy_version, embedding_model, request_id | (existing) | unchanged |
| `selection_strategy` | `string \| undefined` | present on `llm_union` |
| `llm_model` | `string \| undefined` | e.g. `"Qwen2.5-1.5B-Instruct"` |
| `llm_latency_ms` | `number \| undefined` | |
| `truncated_story` | `boolean \| undefined` | |
| `llm_scores` | `Record<string, number> \| undefined` | id → local-LLM score |
| `vector_scores` | `Record<string, number> \| undefined` | id → vector score |

**Validation**: `isEngineResponse` stays lenient (only requires `biases[]` + `request_id`). New
fields are optional; unknown/omitted → `undefined`. `source` values outside `{"vector","llm"}` are
dropped during normalization, not rejected (additive-tolerant).

## 2. Per-bias provenance (in-flight) — `context-builder.ts` → `assessment.service.ts`

### `BiasContextResult` (extended)

| Field | Type | Notes |
|-------|------|-------|
| biasContext, ragCase, retrievedIds | (existing) | unchanged |
| `engineSources` | `Map<string, ("vector" \| "llm")[]>` | **NEW.** normalizedId (hyphenated) → engine signals. Absent id ⇒ not retrieved. `source`-null but `retrieval_score>0` ⇒ `["vector"]` (R3). |

### Normalized bias record (replaces `context_source`)

| Field | Old | New |
|-------|-----|-----|
| origin | `context_source: "retrieved" \| "roster"` | `engineSources: ("vector" \| "llm")[]` |
| request-level status | (implicit) | `ragCase` retained alongside for `[]` disambiguation (R4) |

**Derivation**: `engineSources = engineSourcesMap.get(result.id ?? "") ?? []`.

> **Plumbing note (review finding 1)**: the derivation above happens in `callProvider()` (~L371),
> which currently receives only `ragCase` and `retrievedIds`. `callProvider`'s signature MUST be
> extended with an `engineSourcesMap: Map<string, ("vector"|"llm")[]>` parameter, threaded from BOTH
> call sites (`runStoryOnlyAssessment` ~L100, `runFullAssessment` ~L198). Without this the lookup at
> L371 reads an undefined map and silently returns `[]` for every bias.

> **ragCase exposure (review finding 3 — resolved: storage-only)**: `ragCase` is NOT added to the
> per-bias API output. The `engineSources == []` disambiguation is a request-level property, resolved
> from the stored comparison record's `ragStatus` (see §3). FR-005/SC-002 "records" means the stored
> comparison records, not the live API response.

| `engineSources` | `ragCase` | Meaning |
|-----------------|-----------|---------|
| `["vector"]` | retrieved | vector search only |
| `["llm"]` | retrieved | engine local LLM only |
| `["vector","llm"]` | retrieved | both engine signals |
| `[]` | retrieved | assessment LLM alone (engine ran, did not surface it) |
| `[]` | roster_fallback / unavailable | unknown — engine did not run |

### Output contract — `src/contracts/reflection.schemas.ts`

Replace `context_source: z.enum(["retrieved","roster"]).optional()` with
`engineSources: z.array(z.enum(["vector","llm"])).optional()`. (`ragCase`/`ragStatus` already
surfaced via the comparison record; expose on the per-bias output only if current API consumers need
it — default keep it request-level.)

## 3. `retrieval_comparisons` table — `src/db/schema.ts`

Additive nullable columns (existing columns unchanged; `ragList` retained for back-compat):

| Column | Type | Notes |
|--------|------|-------|
| `rag_vector_list` | `jsonb` nullable | engine bias **names** whose sources include `"vector"` |
| `rag_llm_list` | `jsonb` nullable | engine bias **names** whose sources include `"llm"` (a both-bias is in both lists) |
| `rag_vector_hit_final` | `integer` nullable | count of vector-source **names** that reached `final_list` |
| `rag_llm_hit_final` | `integer` nullable | count of llm-source **names** that reached `final_list` |
| `rag_both_hit_final` | `integer` nullable | count of `["vector","llm"]` **names** that reached `final_list` |

> **List format (review finding 2 — CRITICAL)**: these lists MUST hold bias **names** (`b.name`), not
> ids. The existing `rag_list` is `biases…map(b => b.name)` and `final_list` is
> `result.biases.map(b => b.name)`; `ragHitFinal` intersects the two by name. There are three id
> formats in play — engine `b.id` (underscore), the hyphenated ids in `retrievedIds`/`engineSources`,
> and `b.name`. To keep the `*HitFinal` intersections non-zero, build the per-source lists **directly
> from the engine response by name**: `ragVectorList = biases.filter(b => src(b).includes("vector")).map(b => b.name)`
> (same for `"llm"`), where `src(b)` is the normalized `source` (or the `retrieval_score>0` ⇒
> `["vector"]` fallback). Do NOT derive these from the hyphenated `engineSources` map.

Nullable so historical rows and non-`llm_union` runs (no per-source data) remain valid. New Drizzle
migration under `drizzle/`; no backfill.

## 4. `recordComparison` params + store port — `comparison-recorder.ts`, `persistence/ports.ts`

`RecordComparisonParams` gains the pre-split, name-keyed `ragVectorList`/`ragLlmList` (built from the
engine response by name per §3), passed from the route (`reflection.ts`) out of the same engine
response already fetched via `runFullAssessment`'s return. Recorder computes the three new `*HitFinal`
counts against `finalList` (also names) alongside the existing `ragHitFinal`. Building the split at
the service/route layer (where the engine response and `b.name` are in hand) avoids leaking the
hyphenated-id map into the recorder.
`RetrievalComparisonStore.record()` param type extends with the five new (nullable) fields; the
Drizzle store maps them through; the mock/noop store ignores them (unchanged behavior).

## Invariants

- A both-source bias is counted **once** in each per-source list and in `ragBothHitFinal`; it does
  not inflate the aggregate `ragHitFinal` beyond its single membership in `ragList`.
- Per-source lists are subsets of the ids present in the engine response for the run.
- No field here is read back into the assessment prompt (observability-only, D015 non-goal).
