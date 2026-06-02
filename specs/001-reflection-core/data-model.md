# Data Model: AI Core Reflection MVP

**Feature**: `specs/001-reflection-core` | **Date**: 2026-05-22

Core is **stateless** — no database. Entities below are **request/response DTOs** and **internal catalog records**, not persisted rows.

## HTTP DTOs (integration boundary)

### GenerateQuestionRequest

| Field | Type | Rules |
|-------|------|-------|
| sessionId | string (uuid) | Required; opaque to Core |
| story | string | Required; length 50–3000 |

### QuestionOutput

| Field | Type | Rules |
|-------|------|-------|
| questions | string[] | Length 2–5; each min 1 char |
| isComplete | boolean | Required |
| prompt_version | string (optional) | Semver tag from PromptRegistry, e.g. `"1.0.0"` |
| schema_version | string (optional) | Semver tag from contracts, e.g. `"1.0.0"` |

### GenerateAssessmentRequest

| Field | Type | Rules |
|-------|------|-------|
| sessionId | string (uuid) | Required |
| story | string | Required |
| questions | string[] | Min 1; aligns with batch from question step |
| answers | string[] | Same length as questions (validated in orchestrator) |

### BiasItem

| Field | Type | Rules |
|-------|------|-------|
| name | string | Min 1; SHOULD match catalog name when possible |
| biasCatalogId | string (optional) | Catalog ID after normalization via `normalize.ts` |
| explanation | string | Min 10 |
| storyConnection | string | Min 10; must reference user content |
| alternativePerspective | string | Min 10 |

### AssessmentOutput

| Field | Type | Rules |
|-------|------|-------|
| biases | BiasItem[] | Min 1; no max |
| reflectionPrompt | string | Min 10 |
| prompt_version | string (optional) | Semver tag from PromptRegistry, e.g. `"1.0.0"` |
| schema_version | string (optional) | Semver tag from contracts, e.g. `"1.0.0"` |

## Internal: Bias catalog entry (MVP — ~30 Tier-A entries)

| Field | Type | Purpose |
|-------|------|---------|
| id | string | Stable key for evals and future RAG |
| name | string | Display / model label |
| category | string | Grouping for prompt cheat-sheet (8–12 families) |
| definition | string | One-line definition injected into assessment prompt |
| detectionSignals | string[] | Hints for model matching |

**MVP scope**: ~30 curated Tier-A biases (confirmation bias, anchoring, sunk cost fallacy, survivorship bias, availability heuristic, halo effect, negativity bias, self-serving bias, optimism bias, hindsight bias, dunning-kruger effect, fundamental attribution error, bandwagon effect, cherry-picking, framing effect, gambler's fallacy, just-world hypothesis, moral licensing, overconfidence effect, placebo effect, reactance, selection bias, spotlight effect, status quo bias, stereotyping, temporal discounting, third-person effect, ultimate attribution error, zero-risk bias).

**No expansion** until evaluations justify it, retrieval exists, and confidence scoring is implemented (Tier 3).

## Internal: Prompt registry entry

| Field | Type | Purpose |
|-------|------|---------|
| id | string | e.g. `assessment@1.0.0` |
| role | enum | `system` \| `user-template` |
| path | string | File under `prompts/` (directory-based: `question-batch/system.md`, `assessment/system.md`) |
| variables | string[] | e.g. `story`, `qaPairs`, `biasShortlist` |

## Internal: Provider interface

### CompletionOptions

| Field | Type | Purpose |
|-------|------|---------|
| temperature | number (optional) | Model temperature |
| maxTokens | number (optional) | Max output tokens |
| timeoutMs | number (optional) | Request timeout (env: `AI_TIMEOUT_MS`) |

### Provider.completeJson

| Param | Type | Purpose |
|-------|------|---------|
| system | string | System prompt |
| user | string | User message |
| responseSchema | ZodSchema | Expected output shape |
| options? | CompletionOptions | Optional overrides |

## Internal: Workflow context

| Field | Type | Purpose |
|-------|------|---------|
| requestId | string | `x-request-id` for tracing (generated in `lib/request-id.ts`) |
| attempt | number | Retry counter |
| providerId | string | e.g. `gemini` |

## State transitions

None in Core. Public app owns session: `created` → `questioning` → `assessing` → `completed` \| `error`.

## Validation ownership

| Layer | Owner |
|-------|-------|
| HTTP body in/out | Core Zod (`contracts/`) |
| Story length 50–3000 | Core on question route; public also validates on `/api/story` |
| Q&A length match | Core assessment orchestrator |
| Session persistence | Public Drizzle only |
| x-request-id propagation | Core (`lib/request-id.ts`); public backend should forward header |
| Repair pipeline (invalid LLM output) | Core (`parsers/repair.ts` + retry orchestrator) |