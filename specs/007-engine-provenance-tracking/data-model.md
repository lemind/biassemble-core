# Phase 1 Data Model: Engine Provenance Tracking

Delta from the current async-RAG (Stage 005) architecture. Additive only, except for removing the
dead `"both"` value from `context_source` (which is replaced outright, not extended).

## 1. Engine response (consumed shape) — `src/rag/engine-client.ts`

### `BiasResult` (extended)

| Field | Type | Notes |
|-------|------|-------|
| id, name, retrieval_score, definition, examples, indicators, false_positives, related_biases | (existing) | unchanged |
| `source` | `("vector" \| "llm")[] \| null` | **NEW, additive.** Which engine signal(s) surfaced the bias. `null`/absent under retrieval configs that don't produce it. Parser normalizes a legacy scalar `"both"`→`["vector","llm"]`, `"vector"`→`["vector"]`, `"llm"`→`["llm"]`. |

### `EngineResponse` (extended, all NEW fields additive + optional)

| Field | Type | Notes |
|-------|------|-------|
| biases, retrieved_chunks, taxonomy_version, embedding_model, request_id | (existing) | unchanged |
| `selection_strategy`, `llm_model`, `llm_latency_ms`, `truncated_story`, `llm_scores`, `vector_scores` | various, all optional | additive metadata |

**Validation**: `isEngineResponse` stays lenient (only requires `biases[]` + `request_id`).

## 2. Per-bias provenance (in-flight) — `workspace-builder.ts` → `assessment.service.ts`

### `BiasWorkspace` (extended)

| Field | Type | Notes |
|-------|------|-------|
| candidates, workspaceCase, retrievedIds | (existing) | unchanged |
| `engineSources` | `Map<string, ("vector" \| "llm")[]>` | **NEW.** hyphenated catalog id → engine signals. Absent id ⇒ not retrieved. `source`-null but `retrieval_score>0` ⇒ `["vector"]` (R2/fallback rule). Empty map when `workspaceCase === "unavailable"`. |

### Normalized bias record (replaces `context_source`)

| Field | Old | New |
|-------|-----|-----|
| origin | `context_source: z.enum(["retrieved","llm","both"]).optional()` | `engineSources: z.array(z.enum(["vector","llm"])).optional()` |

**Derivation** (inside `callProvider`, after `callProvider`'s signature gains the map param — see
plan Decision 3 / research R4):

```ts
const engineSources = engineSourcesMap.get(result.id ?? "") ?? [];
```

| `engineSources` | request `ragCase` (from `runFullAssessment`) | Meaning |
|-----------------|------|---------|
| `["vector"]` | retrieved | vector search only |
| `["llm"]` | retrieved | engine local LLM only |
| `["vector","llm"]` | retrieved | both engine signals |
| `[]` | retrieved | assessment LLM alone (workspace built, this bias not in it) |
| `[]` | unavailable | unknown — no retrieval result was available for this request |

(`roster_fallback` is part of the `RagCase` type but not reachable via the current
`buildBiasWorkspace` path — see research R3. The table above reflects the two states that actually
occur.)

## 3. `retrieval_comparisons` table — `src/db/schema.ts`

Three additive nullable columns, plus one existing column gains a type-level constraint (all other
existing columns unchanged):

| Column | Type | Notes |
|--------|------|-------|
| `source_breakdown` | `jsonb` nullable | `Record<sourceName, {list: string[]; hitFinal: number}>`. Keys are whatever source names appeared in that run — not a fixed enum. Null on historical rows and runs where no per-bias source info was available. |
| `selection_strategy` | `text` nullable | From `EngineResponse.selection_strategy` (e.g. `"llm_union"`). Per-run metadata, not per-source — lets an analyst filter SC-003 queries to runs that could have populated `source_breakdown`, instead of using `source_breakdown IS NOT NULL` as a proxy (fragile if a future retrieval mode also populates it without being `llm_union`). |
| `llm_model` | `text` nullable | From `EngineResponse.llm_model`. Lets the confirmation-rate dataset be split or filtered by model version — without this, an engine-side model upgrade silently mixes pre/post data in the same analysis with no way to separate them after the fact. |
| `rag_status` (existing) | `text` → Drizzle `{ enum: RagStatus }` | **TypeScript-only** — matches the 7 other `text(col, {enum:[...]})` columns already in this schema (`stage`, `scope`, `dataset`, `callType`, `status`, `failureType`), none of which have a DB-level `CHECK` constraint. This narrows the column's inferred TS type to the same three values already used in application code (`src/persistence/types.ts`'s `RagStatus`); it does **not** add database-level enforcement, and `drizzle-kit generate` should emit no SQL for this change. Corrected from an earlier draft of this doc that overstated this as schema/migration-level enforcement. |

Example `source_breakdown` value:

```json
{
  "vector": { "list": ["Confirmation Bias", "Anchoring Bias"], "hitFinal": 2 },
  "llm":    { "list": ["Confirmation Bias", "Halo Effect"],    "hitFinal": 1 }
}
```

There is no `both` key and no separate `*_hit_final` columns per source — a combined-signal count is
computed by a reader intersecting two entries' `list` arrays, never stored.

## 4. `RecordComparisonParams` + persistence chain

`comparison-recorder.ts`'s `RecordComparisonParams` gains `sourceLists: Record<string, string[]>`
(raw per-source name lists). **Canonical build site: the workspace layer, not the raw engine
response.** `runFullAssessment` already has `workspace.candidates` (each with `.bias_id` — the raw
underscore engine id — and `.name`) and `workspace.engineSources` (hyphenated-id → signals) in hand
from `buildBiasWorkspace`. Build `sourceLists` by iterating `workspace.candidates`, hyphenating each
`bias_id` the same way `buildBiasWorkspace` already does internally, and looking it up in
`workspace.engineSources` — grouping each candidate's `.name` under every signal in its array. Do
**not** re-iterate the raw `EngineResponse.biases` a second time to build this: that would duplicate
`buildBiasWorkspace`'s `retrieval_score > 0` filter and `["vector"]` fallback logic in a second
location, and the two could silently diverge if one is edited without the other (e.g. a future change
to the fallback rule applied in `workspace-builder.ts` but missed in `assessment.service.ts`, or vice
versa). `recordComparison()` computes `sourceBreakdown` generically from whatever `sourceLists` it is
given:

```ts
const sourceBreakdown: Record<string, { list: string[]; hitFinal: number }> = {};
for (const [source, list] of Object.entries(sourceLists)) {
  const finalSet = new Set(finalList);
  sourceBreakdown[source] = { list, hitFinal: list.filter(n => finalSet.has(n)).length };
}
```

No `if (source === "vector")`/`"llm"` branching — the loop is source-name-agnostic by construction,
which is what makes it extend to a hypothetical third source without a code change (only a new key in
the input `sourceLists`, which itself would come from `workspace-builder.ts`/`engine-client.ts`
recognizing the new engine value in a future change).

`RetrievalComparisonRecord` (persistence/types.ts) gains `sourceBreakdown?: Record<string, {list:
string[]; hitFinal: number}> | null`. `RetrievalComparisonStore.record()` already uses `Omit<...
Record, "id"|"createdAt">` so no port-interface change is needed beyond the type it references.
`insertRetrievalComparison` (db/queries.ts) and `DrizzleRetrievalComparisonStore` thread the field
through the same way the existing fields already do.

## Invariants

- `source_breakdown`'s keys are never fixed in advance by any type — the map's key type is `string`,
  not a literal union, at the persistence layer (the literal `EngineSource = "vector"|"llm"` union
  only constrains what `engine-client.ts`/`workspace-builder.ts` can currently *produce*, not what the
  storage layer can *hold*).
- A bias present under two source keys is counted once in each key's `list`/`hitFinal`, never
  additionally in a merged key.
- Per-source lists are name-keyed and are subsets of `ragList` for that run.
- No field introduced here is read back into the assessment prompt (observability-only, D017
  non-goal, FR-011).
