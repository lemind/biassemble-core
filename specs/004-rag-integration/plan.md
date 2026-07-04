# Implementation Plan: RAG Integration

**Branch**: `004-rag-integration` | **Date**: 2026-07-04 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/004-rag-integration/spec.md`

## Summary

Wire biassemble-engine's `POST /retrieve-biases` into the assessment pipeline. Replace the flat `{{biasShortlist}}` with a tiered `{{biasContext}}`: full documents for retrieved biases (Tier 1) + roster for all 38 (Tier 2) on Case A; roster-only on Cases B and C. A nullable `rag_result` JSONB column on `runs` bridges story-only and full assessment. A fire-and-forget recorder writes one comparison row per completed session to `retrieval_comparisons`.

## Technical Context

**Language/Version**: TypeScript 5 (strict), Node 22 LTS

**Primary Dependencies**: Fastify 5, Zod 4, Drizzle ORM, Pino, Vitest, esbuild

**Storage**: PostgreSQL (Supabase) via Drizzle ORM — `core` pg schema

**Testing**: Vitest (unit + integration), same pattern as Stage 003

**Target Platform**: Node.js server, Vercel Functions (esbuild bundle)

**Project Type**: Internal web-service (private AI core, called by biassemble backend)

**Performance Goals**: RAG call ≤ 500ms (RAG_TIMEOUT_MS); total assessment pipeline ≤ 10s (AI_TIMEOUT_MS)

**Constraints**: Never retry on RAG errors; RAG failures must not fail the assessment; fire-and-forget for all observability side-effects (D011)

**Scale/Scope**: Low volume (development / early production). No circuit breaker required at this stage.

**Key facts confirmed from codebase**:
- `BiasEntry` (local catalog) has: `id, name, category, definition, detectionSignals` — no examples/indicators. Tier 2 roster uses `name + definition`.
- `BiasResult` (engine response) has: `id, name, retrieval_score, definition, examples, indicators, false_positives, related_biases` — all strings. Tier 1 full documents come entirely from the engine response.
- `RetrieveResponse` also includes `retrieved_chunks, taxonomy_version, embedding_model, request_id`.
- `PromptRegistry.render()` uses simple `{{varName}}` string replacement (no templating library).
- `RunStore` currently has `createRun()` and `getRunsBySession()` — needs `storeRagResult()` and `getRagResultForSession()`.

## Constitution Check

Constitution not yet filled in for this project (template placeholder). No gates to evaluate. No violations.

## Project Structure

### Documentation (this feature)

```text
specs/004-rag-integration/
├── plan.md          ← this file
├── data-model.md    ← Phase 1 output
└── tasks.md         ← /speckit-tasks output (not created here)
```

### Source Code (repository root)

```text
src/
├── lib/
│   └── env.ts                             # Add RAG_ENGINE_URL, RAG_API_KEY, RAG_TIMEOUT_MS
├── rag/                                   # NEW module
│   ├── engine-client.ts                   # RagEngineClient — HTTP + timeout + error categorization
│   └── context-builder.ts                 # buildBiasContext() — Cases A/B/C, returns { biasContext, ragCase }
├── observability/
│   └── comparison-recorder.ts             # NEW: recordComparison() fire-and-forget
├── orchestrators/reflection/
│   └── assessment.service.ts              # Wire RAG: retrieve → storeRagResult → buildBiasContext
├── persistence/
│   ├── ports.ts                           # Extend RunStore; add RetrievalComparisonStore
│   ├── run-store.ts                       # Add storeRagResult(), getRagResultForSession()
│   └── retrieval-comparison-store.ts      # NEW: DrizzleRetrievalComparisonStore
├── db/
│   ├── schema.ts                          # Add rag_result to runs; add retrieval_comparisons table
│   ├── queries.ts                         # updateRunRagResult(), getRagResultBySession(), insertRetrievalComparison()
│   └── migrations/
│       └── 0004_rag_integration.sql       # NEW
├── contracts/
│   └── reflection.schemas.ts              # Add context_source: "retrieved" | "roster" to BiasItem
├── routes/
│   └── reflection.ts                      # Wire recordComparison() fire-and-forget after runFullAssessment
├── server.ts                              # DI: construct RagEngineClient, RetrievalComparisonStore
└── prompts/
    └── reflection/assessment/
        ├── system.json                    # Bump version to 1.2.0
        └── system.md                     # {{biasShortlist}} → {{biasContext}}

tests/
├── unit/
│   ├── rag/
│   │   ├── engine-client.test.ts
│   │   └── context-builder.test.ts
│   └── observability/
│       └── comparison-recorder.test.ts
└── integration/
    └── rag-assessment.test.ts
```

**Structure Decision**: Single project. New `src/rag/` module for the retrieval client and context builder. Comparison recorder in `src/observability/` following Stage 003 fire-and-forget pattern. All persistence via ports (no direct DB calls from services or routes).

## Phases

### Phase 1: Database Schema, Ports & Migration

Foundation. All later phases depend on this.

- Extend `runs` table: add `ragResult` JSONB nullable column (`src/db/schema.ts`)
- Add `retrieval_comparisons` table (`src/db/schema.ts`) — all columns per spec data model
- Add query functions to `src/db/queries.ts`:
  - `updateRunRagResult(runId, ragResult)` — nullable JSONB update
  - `getRagResultBySession(sessionId)` — returns `ragResult` from the most recent `initial_assessment` run for the session
  - `insertRetrievalComparison(data)` — insert one comparison row
- Extend `RunStore` in `src/persistence/ports.ts`:
  - `storeRagResult(runId: string, result: unknown): Promise<void>` — best-effort, non-throwing
  - `getRagResultForSession(sessionId: string): Promise<unknown | null>`
- Add `RetrievalComparisonStore` interface to `src/persistence/ports.ts`
- Add `RetrievalComparisonRecord` type to `src/persistence/types.ts`
- Create migration `src/db/migrations/0004_rag_integration.sql`

### Phase 2: Environment Variables & RAG Client

Standalone. No DB dependency.

- Add to `src/lib/env.ts`:
  - `RAG_ENGINE_URL: z.string().url()` (required)
  - `RAG_API_KEY: z.string().min(1)` (required)
  - `RAG_TIMEOUT_MS: z.coerce.number().int().positive().default(500)`
- Create `src/rag/engine-client.ts`:
  - `RagClientResult` type: `{ status: "ok"; data: EngineResponse } | { status: "unavailable" } | { status: "auth_error" }`
  - `EngineResponse` type mirroring `RetrieveResponse` from biassemble-engine
  - `RagEngineClient` class with `retrieve(story: string): Promise<RagClientResult>`
  - AbortController timeout (`RAG_TIMEOUT_MS`), Bearer auth (`RAG_API_KEY`)
  - Error categorization: 401/403 → auth_error (warn); 5xx/network/timeout → unavailable (info); invalid shape → unavailable (warn with `rag_invalid_response`)
  - Never throws

### Phase 3: Context Builder

Depends on Phase 2 (`RagClientResult`, `EngineResponse` types).

- Create `src/rag/context-builder.ts`:
  - `RagCase` type: `"retrieved" | "roster_fallback" | "unavailable"`
  - `BiasContextResult` type: `{ biasContext: string; ragCase: RagCase; retrievedIds: Set<string> }`
  - `buildBiasContext(result: RagClientResult, catalog: BiasEntry[]): BiasContextResult`
  - Case A: `result.status === "ok"` and at least one `retrieval_score > 0.0` → Tier 1 full docs + Tier 2 roster
  - Case B: `result.status === "ok"` and all `retrieval_score === 0.0` → roster-only; document ADR D014 inline
  - Case C: `result.status !== "ok"` → roster-only
  - Returns `retrievedIds` (Set of bias IDs with score > 0) for `context_source` derivation

### Phase 4: Assessment Service Integration

Depends on Phases 1, 2, 3.

- Extend `AssessmentService` constructor: add optional `ragClient?: RagEngineClient`
- Update `runStoryOnlyAssessment`:
  1. If `ragClient` present: `await ragClient.retrieve(story)` (needed immediately for context building), then kick off `runStore.storeRagResult(runId, result)` without await (fire-and-forget, best-effort)
  2. `buildBiasContext(ragResult ?? { status: "unavailable" }, catalog)` → `{ biasContext, ragCase, retrievedIds }`
  3. Pass `{ biasContext }` to `prompts.render("assessment", ...)`
  4. After LLM output: set `context_source` per bias (`retrievedIds.has(bias.biasCatalogId ?? "") ? "retrieved" : "roster"`). **Assumption**: engine `BiasResult.id` and local catalog `BiasEntry.id` share the same string format (e.g. `"confirmation_bias"`). If they ever diverge, `context_source` silently returns `"roster"` for all biases on Case A — document this assumption with a comment in `context-builder.ts`.
  5. Log `rag_context: ragCase` on info log
- Update `runFullAssessment`:
  1. `runStore.getRagResultForSession(sessionId)` → `ragResult | null`
  2. Reconstruct `RagClientResult` from stored JSON (or `{ status: "unavailable" }` if null)
  3. Same `buildBiasContext` → `context_source` derivation → logging as above
- `generate()` backward-compat: no RAG, roster-only, no change required

### Phase 5: Prompt + Contract Updates

Depends on Phase 4 (render call sites updated together with template variable).

- Rename `{{biasShortlist}}` → `{{biasContext}}` in `src/prompts/reflection/assessment/system.md`
- Bump `version` to `"1.2.0"` in `src/prompts/reflection/assessment/system.json`
- Add `context_source: z.enum(["retrieved", "roster"]).optional()` to `BiasItem` in `src/contracts/reflection.schemas.ts`

### Phase 6: Comparison Recorder & Route Wiring

Depends on Phase 1 (schema), Phase 4 (`AssessmentOutput.biases`).

- Implement `DrizzleRetrievalComparisonStore` in `src/persistence/retrieval-comparison-store.ts`
- Create `src/observability/comparison-recorder.ts`:
  - `RecordComparisonParams`: `{ sessionId, runId, ragList, llmListRaw, finalList, ragCase, ragResult }`
  - Compute: overlap, rag_only, llm_only, rag_hit_final, llm_hit_final, normalization_additions
  - Fire-and-forget: wrap in try/catch, log warn on failure, never throw
- Wire in `src/routes/reflection.ts`: after `assessmentService.runFullAssessment()` returns, call `recordComparison()` without await
- Wire `RetrievalComparisonStore` DI in `src/server.ts`

### Phase 7: Deployment

- Run `pnpm db:migrate` against production (Supabase)
- Set `RAG_ENGINE_URL`, `RAG_API_KEY`, `RAG_TIMEOUT_MS` in Vercel environment
- Verify `rag_result` column on `runs` and `retrieval_comparisons` table exist

## Complexity Tracking

No constitution violations.
