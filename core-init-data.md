# Biassemble AI Core — Initial Spec & Init Data

**Purpose**: Single reference to bootstrap the **private** `biassemble-core` repository. Collects information from existing project documents only. Correlates with feature `001-reflection-flow` and public repo architecture.

**Status**: Information gathering — not a task list for Core or public backend.

**Source documents** (read in full for this file):

| Document | Location |
|----------|----------|
| Feature spec | [spec.md](spec.md) |
| Implementation plan | [plan.md](plan.md) |
| Tasks (public repo phases) | [tasks.md](tasks.md) |
| Public/private architecture | [architecture.md](architecture.md) |
| Spec quality checklist | [checklists/requirements.md](checklists/requirements.md) |
| Public system design (repo split) | [System Design Document public.md](../../System Design Document%20public.md) |
| Engineering rules | [AGENTS.md](../../AGENTS.md) |
| Core HTTP API (draft) | [biassemble-core/API.md](../../../biassemble-core/API.md) |
| Core private SDD | [biassemble-core/System Design Document — PRIVATE.md](../../../biassemble-core/System%20Design%20Document%20%E2%80%94%20PRIVATE.md) |
| Core bootstrap prompt | [biassemble-core/AI Core — Private Repository Bootstrap Prompt.md](../../../biassemble-core/AI%20Core%20%E2%80%94%20Private%20Repository%20Bootstrap%20Prompt.md) |
| Core open questions | [biassemble-core/Biassemble AI Core — Internal Questions.md](../../../biassemble-core/Biassemble%20AI%20Core%20%E2%80%94%20Internal%20Questions.md) |

**Public implementation references** (cited in plan/architecture; define what Core must satisfy):

| Artifact | Path in public `biassemble` repo |
|----------|----------------------------------|
| AI HTTP client | `backend/src/lib/ai/core-client.ts` |
| Response validation (Zod) | `backend/src/lib/ai/contracts.ts` |
| JSON parsing | `backend/src/lib/ai/parsers.ts` |
| Bounds & retries | `backend/src/lib/constants.ts` |
| Dev substitute | `backend/src/lib/ai/dev-mock-client.ts` |

---

## 1. Product context (from spec.md)

### What Biassemble does (MVP — reflection flow)

Users write a personal story, answer AI-guided follow-up questions, and receive cognitive bias feedback with story-specific explanations and alternative perspectives. Non-clinical, reflective, anonymous.

### User stories (priority)

| ID | Priority | Summary |
|----|----------|---------|
| US1 | P1 | Full journey: story → questions → answers → assessment |
| US2 | P2 | Review results (bias detail, perspectives, reflection prompt) |
| US3 | P3 | Resume interrupted session by session reference |

### Functional requirements (Core-relevant)

| ID | Requirement | Core involvement |
|----|-------------|------------------|
| FR-001 | Story 50–3000 characters | Validates input at public API; Core receives `story` string |
| FR-002 | Contextual follow-up questions from story | **Core**: question generation |
| FR-003 | Conversational state across Q&A | Public DB; Core stateless per request |
| FR-004 | Detect biases + analysis | **Core**: assessment generation |
| FR-005 | Display biases, connections, perspectives, reflection prompt | **Core** output shape; public UI |
| FR-006 | First question within 5s of story submit | **Core** called **synchronously** on story (batch questions) per plan |
| FR-007 | AI retry 3× exponential backoff | Documented in architecture/constants; ownership TBD (see §8) |
| FR-008 | Structured JSON + schema validation | **Core** returns JSON; public validates with Zod |
| FR-009 | Anonymous sessions | Public only |
| FR-010 | No clinical/therapy claims | **Prompt/guardrail** responsibility in Core |

### Success criteria (Core-relevant)

| ID | Criterion |
|----|-----------|
| SC-002 | >99% valid structured JSON parse success |
| SC-003 | First AI question within 5s of story submission (via sync batch per plan) |
| SC-005 | Outputs reference specific user story details |
| SC-006 | Graceful AI failures with retries, no data loss |

### Edge cases (from spec.md — not all assigned to Core in docs)

- AI provider failure → retry + friendly error (FR-007)
- Offensive content → content filtering before AI (no owner named in plan)
- Blank answers → cap retries, allow skip (`MAX_BLANK_ANSWERS` in public constants)

### Assumptions (from spec.md)

- English primary for MVP
- Provider choice and rate limits defined in **biassemble-core** (spec assumption, line 104)
- Bias taxonomy refined iteratively

---

## 2. System architecture (documented)

### Repository split

From [architecture.md](architecture.md), [plan.md](plan.md), [System Design Document public.md](../../System Design Document%20public.md), private SDD §7:

```text
Frontend (Vite SPA)
    → Public Backend (Next.js API, Supabase, Inngest)
        → Private AI Core (HTTP)
            → LLM provider APIs
```

| Repo | Visibility | Owns |
|------|------------|------|
| `biassemble` | Public | `frontend/`, `backend/`, `specs/`, product API, sessions DB, Inngest jobs |
| `biassemble-core` | Private | Prompts, provider keys, model routing, evaluation assets, persuasion logic (future) |

### Public backend layers (from architecture.md)

| Layer | Path | Role |
|-------|------|------|
| HTTP API | `backend/src/app/api/*` | Thin routes |
| Services | `backend/src/services/*` | Orchestration, DB, `getAiClient()` |
| Jobs | `backend/src/lib/jobs/runJob()` | Inngest handlers exist; **MVP assessment path does not use them** (see §3.2) |
| Workflow | `backend/src/lib/workflow/` | `workflow.enqueue()` available; not used for MVP assessment |
| AI boundary | `backend/src/lib/ai/` | `core-client` or `dev-mock`; **no prompts** |
| DB | `backend/src/drizzle/` | `sessions` + `session_data` |

### Private Core modules (from private SDD §3)

- Prompt Registry (versioned)
- Evaluation Engine (golden datasets, regression)
- Confidence Engine
- Persuasion Engine (future commercial)
- Provider Orchestrator

### Proprietary assets (private SDD §6)

Prompts, datasets, evaluation corpora, scoring logic, persuasion taxonomies, confidence heuristics.

### Provider strategy (private SDD §4)

| Provider | Documented role |
|----------|-----------------|
| Claude Sonnet | reasoning |
| Claude Haiku | cheap generation |
| Gemini Flash | low-cost scale |
| GPT-5 Mini | fallback/general |
| DeepSeek | experimentation |

Public plan Phase 5 defers concrete MVP provider choice to Core implementation; public repo uses `dev-mock` until Core is deployed.

---

## 3. End-to-end flows (from plan.md + architecture.md)

### 3.1 Question batch (synchronous on story submit)

From [plan.md](plan.md) § Design Decisions — Questions:

1. User submits story → public `POST /api/story`
2. Public `session.service` calls `getAiClient().generateQuestion()` **inline** (not Inngest)
3. AI returns **2–5 questions** as array + `isComplete` flag
4. Public persists `session_data.questions`, returns `{ sessionId, questions[] }`
5. Frontend shows all questions at once

Constants: `QUESTIONS_MIN=2`, `QUESTIONS_MAX=5` (`backend/src/lib/constants.ts`).

### 3.2 Answers and assessment

**Current codebase** (`backend/src/services/question.service.ts`, `assessment.service.ts`) — overrides older plan.md / architecture.md wording on this path:

1. User submits **all answers in one request** → `POST /api/answers` with `{ sessionId, answers: string[] }`
2. Public persists full `answers` array, returns `{ done: true, total, assessmentPending: true }` immediately
3. Assessment runs via `setImmediate(() => handleAssessmentGeneration(sessionId))` — **not** `workflow.enqueue("generate-assessment")` in the MVP flow (Phase 4 deploy path; no Inngest dependency for assessment here)
4. `handleAssessmentGeneration` calls `getAiClient().generateAssessment()` → Core `POST /v1/reflection/assessment` when `AI_CLIENT_MODE=core`
5. Frontend polls `GET /api/session/[id]` until `assessmentReady`, then `GET /api/result/[id]`

**Older docs** ([plan.md](plan.md), [architecture.md](architecture.md)) still describe per-answer `POST /api/answers` with `{ done, total }` and Inngest for assessment — reconcile those files separately; this init doc follows the codebase for integration.

Session statuses (architecture.md): `created` → `questioning` → `assessing` → `completed` | `error` (public `assessment.service` sets `completed` after save).

### 3.3 What Core is called for (from public `AiClient`)

From `backend/src/lib/ai/client.ts` and `core-client.ts`:

| Method | When (public) | Core path |
|--------|---------------|-----------|
| `generateQuestion` | Sync on story create | `POST /v1/reflection/question` |
| `generateAssessment` | After batch answers: `setImmediate` → `handleAssessmentGeneration` (not Inngest in MVP path) | `POST /v1/reflection/assessment` |

`runGenerateQuestions` / Inngest `generate-assessment` job code remains in the repo but the **live MVP path** uses sync questions on story (§3.1) and `setImmediate` for assessment (§3.2).

---

## 4. HTTP contracts

### 4.1 Private Core API (biassemble-core/API.md)

**Auth**: `Authorization: Bearer <AI_CORE_API_KEY>`

#### POST /v1/reflection/question

**Request** (API.md):

```json
{
  "sessionId": "uuid",
  "story": "string (50-3000 chars)",
  "previousQuestions": ["optional"],
  "previousAnswers": ["optional"]
}
```

**Response** (API.md):

```json
{
  "question": "string",
  "isComplete": false
}
```

#### POST /v1/reflection/assessment

**Request** (API.md):

```json
{
  "sessionId": "uuid",
  "story": "string",
  "questions": ["string"],
  "answers": ["string"]
}
```

**Response** (API.md):

```json
{
  "biases": [{ "name", "explanation", "storyConnection", "alternativePerspective" }],
  "reflectionPrompt": "string"
}
```

API.md states: **exactly 2** biases.

**Errors** (API.md): 400, 401, 502.

---

### 4.2 Public backend expectation (contracts.ts + core-client.ts)

Public `backend/src/lib/ai/contracts.ts` defines Zod schemas used to validate Core responses:

#### Question output (public contracts)

```ts
questions: string[]  // min QUESTIONS_MIN (2), max QUESTIONS_MAX (5)
isComplete: boolean
```

#### Assessment output (public contracts)

```ts
biases: BiasItem[]  // min 1, no upper bound
reflectionPrompt: string  // min 10 chars
```

`BiasItem`: `name`, `explanation`, `storyConnection`, `alternativePerspective` (each with min lengths per schema).

#### Core request types (public contracts)

```ts
GenerateQuestionRequest: { sessionId, story }
GenerateAssessmentRequest: { sessionId, story, questions[], answers[] }
```

Public `core-client.ts` POSTs `GenerateQuestionRequest` only (no `previousQuestions` / `previousAnswers` in current client).

---

### 4.3 Documented contract inconsistencies (must reconcile in Core)

| Topic | biassemble-core/API.md | plan.md / architecture.md / public contracts.ts |
|-------|------------------------|--------------------------------------------------|
| Question response | Single `question` string | `questions` array (2–5) |
| Question request | Optional `previousQuestions`, `previousAnswers` | `GenerateQuestionRequest` only `sessionId` + `story` |
| Assessment biases | Exactly **2** | **min 1**, no max (plan § Biases) |
| Answers API | Not specified | Public product API; not Core surface |

**Init implication**: Core implementation must align with **public `contracts.ts` + `core-client.ts`** for integration to work, unless API.md is updated first. This document records both sources; it does not pick a winner.

---

## 5. Public product API (context for Core — not implemented in Core)

Core does **not** expose these; public backend does. Included so Core inputs/outputs map to the product flow.

| Route | Role (current codebase) |
|-------|-------------------------|
| `POST /api/story` | Create session, sync AI questions, return `{ sessionId, questions[] }` |
| `POST /api/answers` | Accept `{ sessionId, answers: string[] }`; save all answers; return `{ done: true, total, assessmentPending: true }`; start assessment via `setImmediate` |
| `GET /api/session/[id]` | Poll; `assessmentReady` when `biases` + `reflectionPrompt` set on `session_data` |
| `GET /api/result/[id]` | Return assessment for UI |

Frontend (`frontend/src/types/api.ts`): `SubmitAnswersResponse` matches the batch response above.

### Public DB model (plan.md + drizzle schema)

**Table `sessions`**: `id`, `status`, timestamps.

**Table `session_data`**: `sessionId`, `story`, `questions` (jsonb string[]), `answers` (jsonb string[]), `biases`, `reflectionPrompt`.

### Public validation layers (architecture.md § Schema layers)

| Layer | File | Role |
|-------|------|------|
| AI response shape | `lib/ai/contracts.ts` | Core response DTOs |
| DB/API record | `lib/validation/assessment.ts` | Adds `sessionId`; imports `biasItemSchema` |
| API input | `lib/validation/story.ts`, `answer.ts` | Request bodies for public routes |
| Frontend types | `frontend/src/types/api.ts` | Manual mirror of contracts (plan Phase 6 notes codegen) |

Flow (architecture.md): Core output → validate `contracts.ts` → map to DB record → persist → serve via API.

---

## 6. Constants and retry behavior (public repo — FR-007)

From `backend/src/lib/constants.ts` and architecture.md:

| Constant | Value | Source |
|----------|-------|--------|
| `QUESTIONS_MIN` | 2 | constants.ts, plan.md |
| `QUESTIONS_MAX` | 5 | constants.ts, plan.md |
| `MAX_BLANK_ANSWERS` | 2 | constants.ts, tasks Phase 6 |
| `AI_MAX_RETRIES` | 3 | constants.ts, FR-007 |
| `AI_RETRY_BASE_DELAY_MS` | 1000 | constants.ts; architecture cites 1s → 2s → 4s backoff |

architecture.md: FR-007 retries; AI failures on story submit set session `"error"`.

tasks.md Phase 5: T026-core mentions retry in Core; Phase 6 T018 retry tests. **Documents do not uniquely assign** retry implementation to Core vs public client for all call paths.

---

## 7. Environment and integration (public backend)

From `backend/.env.example` and architecture.md:

| Variable | Purpose |
|----------|---------|
| `AI_CLIENT_MODE` | `dev-mock` (local) or `core` (HTTP to Core) |
| `AI_CORE_BASE_URL` | Core service base URL |
| `AI_CORE_API_KEY` | Bearer token for Core |

Public repo: no `GOOGLE_*` or provider keys in public env (`.env.example` comment).

---

## 8. Type ownership and generation (analysis — no Core task plan)

### What documents already say

- plan.md Phase 6 (future): consider codegen for `frontend/src/types/api.ts` from `backend/src/lib/ai/contracts.ts`
- plan.md § Schema: `contracts.ts` labeled **AI Core contract** but file currently lives in **public** repo
- Bootstrap prompt: private repo includes `contracts/` folder
- AGENTS.md: never add prompts/API keys to public repo; validate AI outputs with Zod

### Reasonable type boundaries (derived from documents only)

| Type category | Owner | Examples |
|---------------|-------|----------|
| Core HTTP request/response for `/v1/reflection/*` | **biassemble-core** | Question batch output, assessment output, bias item fields |
| Public product API request/response | **biassemble** (public) | `POST /api/story`, session status, result payload for frontend |
| DB row shapes | **biassemble** (public) | `sessions`, `session_data` |
| Persistence record | **biassemble** (public) | `assessmentRecordSchema` adds `sessionId` to bias data |

### Is “Core generates types; public BE fetches them; each repo also generates its own” reasonable?

**Yes, with one-way dependency**, matching architecture:

1. **Core publishes** the canonical schemas for its HTTP API (Zod or OpenAPI) from the private `contracts/` module (bootstrap prompt folder structure).
2. **Public backend consumes** those types (or validates against the same Zod schemas via package import or published artifact) in `core-client.ts` / `contracts.ts`.
3. **Public backend generates** its own types for product API and DB — not duplicated in Core.
4. **Frontend** today manually mirrors public contracts (`types/api.ts`, plan T040b); plan Phase 6 mentions automating from public `contracts.ts`.

### Can Core depend on current public backend types?

**Documents imply no.** Dependency direction is fixed:

```text
Public App → Public API → Private AI Core → LLM APIs
```

Core should not import `biassemble` backend DB types or Next.js route types. Public sends plain JSON (`story`, `questions`, `answers`, `sessionId`); Core does not need Drizzle or session table types.

**If types are shared**: share only the **HTTP contract** package (request/response DTOs for `/v1/reflection/*`), owned by Core and consumed by public — not the whole public backend codebase.

### Current state (factual)

- Contract Zod schemas live in **public** repo at `backend/src/lib/ai/contracts.ts` with comment “shapes returned by Biassemble AI Core”.
- `biassemble-core/API.md` differs from those schemas (see §4.3).
- plan.md labels `contracts.ts` as “AI Core contract” — init work includes deciding **physical location** (private `contracts/` as source of truth vs shared package) without assuming a migration path here.

---

## 9. Suggested private repo layout (from bootstrap prompt only)

From [AI Core — Private Repository Bootstrap Prompt.md](../../../biassemble-core/AI%20Core%20%E2%80%94%20Private%20Repository%20Bootstrap%20Prompt.md):

```text
biassemble-ai-core/   # prompt uses this name; workspace folder is biassemble-core/
├── prompts/
├── providers/
├── orchestrators/
├── evaluations/
├── datasets/
├── scoring/
├── parsers/
├── contracts/
├── tests/
├── scripts/
└── docs/
```

Bootstrap constraints:

- **DO NOT** (yet): fine-tuning, vector DB, RAG, distributed systems, over-engineering
- **DO**: modular architecture, proprietary isolation, evaluation-first, future monetization

Bootstrap deliverables listed: architecture draft, provider abstraction, prompt registry, evaluation framework, scoring module, roadmap, ADR structure, README, env.example.

---

## 10. Core capabilities vs MVP reflection flow

### In scope for MVP reflection (from tasks Phase 5 labels + API.md + public client)

| Capability | Evidence |
|------------|----------|
| `POST /v1/reflection/question` | API.md, core-client.ts |
| `POST /v1/reflection/assessment` | API.md, core-client.ts |
| Prompt registry | tasks T025-core, private SDD, bootstrap |
| Provider integration | bootstrap, private SDD §4 |
| Structured JSON output | FR-008, bootstrap |
| Retry/backoff | FR-007, T026-core, constants (ownership shared in docs) |

### Documented as future (private SDD / bootstrap / tasks Phase 6)

- Persuasion analyzer, rewrite engine (private SDD §5)
- RAG, embeddings, fine-tuning (private SDD open questions; bootstrap DO NOT)
- Content filter stub (tasks T044)
- Evaluation dashboards, dynamic routing (internal questions)

---

## 11. Phase status (public repo — context only)

From [plan.md](plan.md) / [tasks.md](tasks.md):

| Phase | Status | Relation to Core |
|-------|--------|------------------|
| 1 Landing | ✅ | No Core |
| 2 Backend foundation | ✅ | `core-client`, `dev-mock`, contracts stub |
| 3 Product API + jobs | ✅ | Consumes AI via `getAiClient()` |
| 4 Frontend flow | ✅ Deployed (Vercel, `phase4` branch) | End-to-end with `dev-mock`; batch Q&A submit; polls for sync assessment (§3.2) |
| 5 Private AI Core + tests | Not done | T024-core–T026-core, T014, T016 |
| 6 Polish / US2 / US3 | Future | — |

tasks.md note: `AI_CLIENT_MODE=dev-mock` unblocks public E2E until Core is deployed.

---

## 12. Open questions (from existing docs only)

### biassemble-core/Biassemble AI Core — Internal Questions.md

- Behavioral: official bias taxonomy, persuasion frameworks, emotional-state modeling, uncertainty in outputs
- Commercial: paid feature priority, API vs app monetization, ethics, team plans
- AI architecture: RAG, embeddings, vector DB, fine-tuning, eval dashboards
- Engineering: internal API vs private package, prompts in DB vs filesystem, dynamic routing, per-provider workflows
- Evaluation: hallucination measurement, provider benchmarks, persuasion eval

### private SDD §9

- Embeddings later? (medium)
- Dynamic provider routing? (medium)
- Fine-tuning? (low)
- Canonical persuasion taxonomy? (high)

---

## 13. Correlation matrix: spec → plan → architecture → Core

| spec.md | plan.md / architecture.md | Core responsibility |
|---------|---------------------------|-------------------|
| FR-002 questions | Batch sync on story | `generateQuestion` |
| FR-004/005 assessment | Async after Q&A | `generateAssessment` |
| FR-006 5s first question | Sync batch on `POST /api/story` | Same call |
| FR-007 retry | constants + T026-core | Implement per reconciliation |
| FR-008 JSON validation | contracts.ts + parsers | Valid JSON from LLM |
| FR-010 non-clinical | — | Prompt guardrails |
| SC-005 story-specific | — | Prompt quality |
| US1 acceptance | Full flow in plan Phase 3–4 | Both endpoints |
| US2/US3 | Phase 6 / future | Not in API.md MVP |

---

## 14. AGENTS.md rules affecting Core

- Never commit prompts, model IDs, or LLM API keys to **public** repo
- Validate AI outputs with Zod at boundaries
- AI Rules: structured JSON only; prompts centralized (in Core for production)
- Spec-kit: update `spec.md` / `plan.md` / `tasks.md` / `architecture.md` when contracts or flows change

---

## 15. Init checklist for biassemble-core (information only — not tasks)

Use this as a readiness list when starting the private repo. Items are **derived from documents above**, not new requirements.

- [ ] Resolve §4.3 contract differences between `API.md` and public `contracts.ts`
- [ ] Implement `/v1/reflection/question` and `/v1/reflection/assessment` matching **integrated** contract
- [ ] Bearer auth compatible with public `AI_CORE_API_KEY`
- [ ] Return JSON parseable by public `parseJsonFromAi` + Zod schemas
- [ ] Respect `QUESTIONS_MIN` / `QUESTIONS_MAX` for question batch
- [ ] Respect assessment bias shape (`biasItemSchema` fields and mins)
- [ ] Store prompts and provider keys only in private repo
- [ ] Define `contracts/` as canonical type source; decide publish/consume mechanism with public repo
- [ ] Align with FR-007 retry expectations (document where retries run)
- [ ] FR-010 / SC-005: prompt design for non-clinical, story-specific copy
- [ ] Provider choice per private SDD §4 (not fixed in MVP spec)

---

*This file is the initial spec for biassemble-core. Update it when `spec.md`, `plan.md`, `architecture.md`, `API.md`, or public `contracts.ts` change.*
