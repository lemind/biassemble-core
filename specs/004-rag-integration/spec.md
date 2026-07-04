# Spec 004 — RAG Integration

## Stage ID & Name

**004-rag-integration** — Connect biassemble-engine retrieval service to the assessment pipeline with tiered context injection and graceful failure degradation.

## Epic / Feature

**Epic:** Retrieval-Augmented Assessment
**Feature:** Tiered bias context injection, RAG failure degradation, retrieval-vs-LLM comparison recording

## User Stories

**Story A** (core value):
As a **developer of Biassemble**, I want the assessment prompt to use retrieved bias documents when retrieval finds relevant candidates, so that the LLM gets story-specific context instead of a flat roster of all 38 biases.

**Story B** (degradation):
As a **developer of Biassemble**, I want the assessment to continue with roster-only context when retrieval fails or finds nothing above threshold, so that a temporarily unavailable retrieval sidecar never breaks a user's session.

**Story C** (analytics):
As a **developer of Biassemble**, I want to record which biases the retrieval engine suggested versus which the LLM detected, so that I can evaluate retrieval quality over time.

## Why / Problem Statement

Currently:
- The assessment prompt injects a flat shortlist of all 38 bias names + one-line definitions (`biasShortlist`).
- No retrieval is performed — the LLM selects biases from the full roster every time.
- Token cost grows linearly with taxonomy size. The LLM has no story-specific signal to focus on.

The biassemble-engine RAG service (`POST /retrieve-biases`) is deployed and stable. After Stage 004:
- Assessments use story-specific retrieved context when available (Case A: Tier 1 full documents + Tier 2 roster).
- Assessments fall back to roster-only context when retrieval returns nothing relevant (Case B) or is unavailable (Case C).
- Retrieval failures are invisible to the user.
- Retrieval-vs-LLM comparison data is recorded fire-and-forget for analytics.

## Success Criteria

1. **Tiered context injected**: When retrieval returns candidates above threshold, the prompt includes Tier 1 full documents for retrieved biases and Tier 2 roster for all 38.
2. **Roster fallback works**: When retrieval returns all entries with `retrieval_score=0.0` (Case B) or fails (Case C), the assessment uses roster-only context — no change in user-visible behavior.
3. **Errors categorized**: 401/403 logs `rag_auth_error` at warn; 5xx/timeout logs `rag_fallback`; invalid response shape logs `rag_invalid_response`. None surface to the user.
4. **RAG result persisted**: The `ragResult` JSONB column on `runs` bridges story-only and full assessment — `runStoryOnlyAssessment` stores it, `runFullAssessment` reads it.
5. **Comparison recorded**: One `retrieval_comparisons` row is written fire-and-forget per completed session, capturing rag_list, llm_list, final_list, overlap counts, and rag_status.

## Requirements

### Functional Requirements

- **FR1: RagEngineClient**
  - Calls `POST /retrieve-biases` with `{ story }` payload; Bearer auth via `RAG_API_KEY`.
  - Timeout after `RAG_TIMEOUT_MS` (default 500ms); never retry on timeout or any other error.
  - Returns a typed result: `{ status: "ok", data: EngineResponse }` on success, `{ status: "unavailable" }` on timeout/network/5xx/invalid shape, `{ status: "auth_error" }` on 401/403.
  - Never throws. All error handling is internal.

- **FR2: Tiered context builder**
  - **Case A** (real retrieval): at least one bias has `retrieval_score > 0.0`. Build Tier 1 (full documents — definition, examples, indicators, false_positives, related_biases — for retrieved biases) + Tier 2 (name + one-line definition for all 38).
  - **Case B** (roster fallback): all returned biases have `retrieval_score=0.0`. Build roster-only context. The `retrieval_score=0.0` inference rule is documented in code with a reference to ADR D014.
  - **Case C** (unavailable): client returned non-ok status. Build roster-only context.
  - Returns `{ biasContext: string, ragCase: "retrieved" | "roster_fallback" | "unavailable" }` so callers share a single derived case without re-detecting it.
  - The context variable is named `biasContext` in all code and templates (replaces `biasShortlist`).

- **FR3: Assessment service integration**
  - `runStoryOnlyAssessment`: calls the RAG client, stores the raw engine response as `ragResult` JSONB on the run record, builds `biasContext` via the context builder, passes it to the LLM.
  - `runFullAssessment`: reads `ragResult` from the story-only run record for the same session, builds `biasContext`. If no story-only run is found or `ragResult` is null, falls back to roster-only context silently.
  - Both phases log `rag_context: "retrieved" | "roster_fallback" | "unavailable"` on the info-level call log.

- **FR4: Graceful degradation**
  - Assessment never throws due to a RAG error.
  - Error logging:
    - 401/403 → log `rag_auth_error` at `warn` level (misconfiguration, not transient)
    - 5xx / network / timeout → log `rag_fallback` at `info` level
    - Invalid response shape → log `rag_invalid_response` at `warn` level
  - No circuit breaker in this stage (known gap — see Out of Scope).

- **FR5: RAG result persistence**
  - Add `ragResult` JSONB column (nullable) to `runs` table.
  - `runStoryOnlyAssessment` stores the raw engine response object (or `null` if unavailable/auth error). The DB write is best-effort: failures are logged at warn and swallowed — the assessment continues regardless.
  - `runFullAssessment` reads `ragResult` from the story-only run for the session. Null (write failed, run not found, or pre-Stage-004 run) → roster-only fallback, no error.

- **FR6: Prompt template update**
  - Rename template variable from `{{biasShortlist}}` to `{{biasContext}}` in `src/prompts/assessment/system.md`.
  - Bump prompt version to `1.2.0` in `system.json`.
  - Update `assessment.service.ts` render calls to pass `{ biasContext }`.

- **FR7: `context_source` field on BiasItem**
  - Add `context_source: z.enum(["retrieved", "roster"])` to `BiasItem` in `reflection.schemas.ts`.
  - `context_source` is derived in service code after the LLM returns, not by the LLM. For each bias in the output, check whether its catalog ID (or normalized name) appears in the set of IDs returned by the engine with `retrieval_score > 0.0`. If yes: `"retrieved"`. Otherwise: `"roster"`.
  - On Cases B/C (roster-only), all biases get `context_source: "roster"` — set unconditionally by the service, not prompted.

- **FR8: Comparison recorder**
  - After `runFullAssessment` returns (in the route handler), call `recordComparison()` fire-and-forget.
  - Writes one row to `retrieval_comparisons` per completed session.
  - Fields: session_id, run_id, rag_list, llm_list, final_list, overlap, rag_only, llm_only, rag_hit_final, llm_hit_final, normalization_additions, rag_status.
  - `rag_list` = bias names from engine response (`[]` if unavailable). `llm_list` = raw bias names from LLM output before normalization. `final_list` = bias names in returned `AssessmentOutput.biases` after normalization.
  - Errors are logged at warn and swallowed — never propagated.

### Non-Functional Requirements

- **NFR1: Retrieval timeout**: `RAG_TIMEOUT_MS` defaults to 500ms. Configurable. The assessment pipeline has a 10s budget (`AI_TIMEOUT_MS`); 500ms is conservative for a same-region network call.
- **NFR2: Fire-and-forget**: RAG errors and comparison recording errors are non-fatal. D011 discipline applies to both.
- **NFR3: No user-visible impact**: Users see identical response shapes for all three cases. Retrieval is a context-quality optimization, not a correctness dependency.
- **NFR4: Backward compatibility**: The existing `generate()` entry point on `AssessmentService` continues to work with roster-only context. No existing tests require modification before the task that wires RAG.

## Data Model Changes

### Extended Table: `runs`

Add one nullable column:

| Column | Type | Description |
|--------|------|-------------|
| `rag_result` | JSONB (nullable) | Raw engine response from `POST /retrieve-biases`. Null when RAG was unavailable, returned auth_error, or the run predates Stage 004. |

**Why on `runs` and not a separate table**: The RAG result must travel from `runStoryOnlyAssessment` (one HTTP request) to `runFullAssessment` (a second HTTP request from the public backend). The `runs` table is the existing shared state between both calls. One nullable JSONB column is the minimal bridge — no new table, no session-level cache.

### New Table: `retrieval_comparisons`

One row per completed assessment session (written after `runFullAssessment`).

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID (PK) | |
| `session_id` | UUID | Session identifier (no FK — sessions are owned by the backend, not core) |
| `run_id` | UUID (FK → runs.id) | The full-assessment run that triggered this row |
| `rag_list` | JSONB | Bias names from engine response (`string[]`). `[]` if unavailable. |
| `llm_list` | JSONB | Bias names from LLM output before normalization (`string[]`) |
| `final_list` | JSONB | Bias names in returned `AssessmentOutput.biases` after normalization (`string[]`) |
| `overlap` | INTEGER | Biases present in both rag_list and llm_list |
| `rag_only` | INTEGER | Biases in rag_list but not llm_list |
| `llm_only` | INTEGER | Biases in llm_list but not rag_list |
| `rag_hit_final` | INTEGER | Biases in rag_list that appear in final_list |
| `llm_hit_final` | INTEGER | Biases in llm_list that appear in final_list |
| `normalization_additions` | INTEGER | Biases in final_list not in either rag_list or llm_list (injected by name normalization or ValidationGate after the LLM returned) |
| `rag_status` | TEXT | `"retrieved"` (Case A), `"roster_fallback"` (Case B), `"unavailable"` (Case C) |
| `created_at` | TIMESTAMPTZ | |

**Index**: `retrieval_comparisons_session_id_idx` on `session_id`.

## UX / Flow Changes

No user-facing changes. Assessment API response shapes are identical across all three cases.

Internal assessment flow after Stage 004:

```
POST /v1/reflection/assessment (story-only call)
  └── runStoryOnlyAssessment(sessionId, story, requestId)
        ├── RagEngineClient.retrieve(story)         → RagClientResult
        ├── runStore.storeRagResult(runId, result)  → best-effort, non-blocking
        ├── buildBiasContext(result, catalog)        → { biasContext, ragCase }
        └── LLM call with prompts.render("assessment", { biasContext })

POST /v1/reflection/assessment (full call, same session)
  └── runFullAssessment(sessionId, story, questions, answers, requestId)
        ├── runStore.getRagResultForSession(sessionId) → ragResult | null
        ├── buildBiasContext(ragResult, catalog)         → { biasContext, ragCase }
        ├── LLM call with prompts.render("assessment", { biasContext })
        └── [fire-and-forget] recordComparison(...)
```

## Edge Cases

- **EC1: No story-only run found in runFullAssessment**: Falls back to roster-only context without error. Covers the `generate()` backward-compat path and the unlikely case where the story-only run was not persisted.
- **EC2: Engine returns partial response**: If the response body parses as JSON but fails the shape check (missing `biases` array), treat as `rag_invalid_response` (Case C), log at warn, continue with roster-only.
- **EC3: All 38 biases have retrieval_score=0.0**: Case B (roster fallback). This is the ADR D014 contract — the inference rule is documented in `context-builder.ts` with a reference to the ADR.
- **EC4: Mixed scores — some > 0, some = 0**: Case A applies. Only entries with `retrieval_score > 0.0` appear in Tier 1; all 38 (including the retrieved ones) appear in Tier 2. Retrieved biases appearing in both tiers is intentional — the Tier 2 roster is always the complete set.
- **EC5: recordComparison() fails**: Logged at warn, swallowed. The assessment response is already returned; recording is a side effect.
- **EC6: runFullAssessment called before runStoryOnlyAssessment**: No story-only run exists; `getRagResultForSession` returns null; assessment proceeds with roster-only context.

## Open Questions

- **OQ1**: Should the context builder expose the `ragCase` as a typed return value so the service doesn't re-derive it for logging? **Decision**: Yes — return `{ biasContext: string, ragCase: "retrieved" | "roster_fallback" | "unavailable" }` from `buildBiasContext()`.
- **OQ2**: Should `retrieval_comparisons` rows be written for story-only assessments too? **Decision**: No — only write after `runFullAssessment`. The comparison is meaningful only when the final bias list is available.

## Dependencies

- **biassemble-engine**: `POST /retrieve-biases` deployed and stable. After engine T008, never returns empty `biases[]`.
- Depends on existing `runs` table for `rag_result` column addition.
- Depends on `BiasCatalogService.getAll()` for Tier 2 roster content (name + definition for all 38). Tier 1 full documents come from the engine response, not the catalog.
- Depends on Stage 003 D011 discipline (fire-and-forget pattern).
- Depends on existing `PromptRegistry.render()` interface for variable rename.

## Out of Scope

- **Circuit breaker**: Not implemented. Known gap documented in ADR D014 Decision 2.
- **Retrieval quality dashboard**: `retrieval_comparisons` data is stored but not surfaced in any UI or API.
- **Engine `source` field**: Adding `source: "retrieved" | "roster"` to `BiasResult` in biassemble-engine is the long-term fix for Case B detection. Not in scope here.
- **Per-question retrieval**: RAG is called once per story in `runStoryOnlyAssessment`; the result is reused for `runFullAssessment`. Separate retrieval per round is out of scope.
- **Retrieval caching**: No in-memory or Redis cache for RAG results within a session.
- **Streaming retrieval**: The RAG client uses request/response, not streaming.
