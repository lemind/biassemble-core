# Tasks: AI Core Reflection MVP

**Input**: Design documents from `/specs/001-reflection-core/`

**Prerequisites**: plan.md, spec.md, data-model.md, API.md

**Path convention**: `src/...` at repository root (`biassemble-core/`)

**Tests**: Not explicitly requested in spec — only include if critical for validation.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup — Project scaffold + curated catalog ✅

**Purpose**: TypeScript project, Fastify server, Zod contracts, ~30 Tier-A bias catalog, health route, auth skeleton, request-id tracing, logger.

- [x] T001 Initialize `package.json`, `tsconfig.json` (strict), install Fastify 5, Zod, `@google/generative-ai`, pino, vitest (no `zod-to-openapi` — Zod contracts are sufficient)
- [x] T002 Create `src/server.ts` — Fastify bootstrap with health `GET /health` route
- [x] T003 Create Zod schemas mirroring API contract in `src/contracts/reflection.schemas.ts`:
  - `GenerateQuestionRequest` (sessionId uuid, story 50–3000 chars)
  - `QuestionOutput` (questions string[] length 2–5, isComplete boolean)
  - `GenerateAssessmentRequest` (sessionId, story, questions, answers)
  - `AssessmentOutput` (biases BiasItem[] min 1, reflectionPrompt min 10)
  - `BiasItem` (name, explanation min 10, storyConnection min 10, alternativePerspective min 10)
- [x] T004 [P] Create `src/lib/request-id.ts` — generate `x-request-id` (uuid), Fastify hook to attach to every request + response header
- [x] T005 [P] Create `src/observability/logger.ts` — pino structured logger with request-id, latency tracking helpers
- [x] T006 [P] Create `datasets/biases/taxonomy.v1.json` — **~30 curated Tier-A biases** only (confirmation bias, anchoring, sunk cost, survivorship, availability, halo, negativity, self-serving, optimism, hindsight, dunning-kruger, fundamental attribution error, bandwagon, cherry-picking, framing, gambler's fallacy, just-world hypothesis, moral licensing, overconfidence, placebo, reactance, selection bias, spotlight, status quo, stereotyping, temporal discounting, third-person effect, ultimate attribution error, zero-risk bias)
- [x] T007 [P] Implement `src/catalog/bias-catalog.ts` — `BiasCatalogService`: load JSON, `getShortlist()`, `getCategories()`
- [x] T008 Create `src/lib/auth.ts` — bearer token middleware; validate against `AI_CORE_API_KEY` env var
- [x] T009 Create `src/lib/env.ts` — env loader with Zod validation for `GEMINI_API_KEY`, `GEMINI_MODEL`, `AI_CORE_API_KEY`, `PORT`, `AI_TIMEOUT_MS`, `AI_MAX_RETRIES`
- [x] T010 Create `.env.example`, update `.gitignore`

**Checkpoint**: Runnable empty Core with health endpoint, contracts, ~30-bias catalog, auth stub, request-id tracing, structured logger. ✅

---

## Phase 2: Tier 1 — orchestrators + Gemini

**Purpose**: Provider abstraction with `CompletionOptions`, prompt registry (directory-based), question/assessment orchestrators with retries + repair pipeline, HTTP routes.

### User Story 1 — Question batch for a story (P1)

**Goal**: Public app submits a story and receives 2–5 contextual follow-up questions synchronously.

**Independent Test**: `POST /v1/reflection/question` with valid story returns `{ questions: string[], isComplete: boolean }` where questions length is 2–5.

- [x] T011 [P] [US1] Implement provider abstraction in `src/providers/types.ts` — `Provider` interface with `completeJson({ system, user, responseSchema, options? })` and `CompletionOptions` type: `{ temperature?, maxTokens?, timeoutMs? }`
- [x] T012 [P] [US1] Implement Gemini provider in `src/providers/gemini.ts` — wraps `@google/generative-ai`, uses `GEMINI_MODEL` env, accepts `CompletionOptions`, returns structured JSON
- [x] T013 [P] [US1] Create prompt registry in `src/prompts/registry.ts` — load prompt files from directory structure, inject variables, guardrails
- [x] T014 [P] [US1] Write prompt directory `src/prompts/reflection/question-batch/`:
  - `system.md` — system prompt for question generation with 30-bias category shortlist, guardrails, JSON output instructions
  - `examples.md` — few-shot question generation examples
  - `schema.md` — output JSON schema for structured generation
- [x] T015 [P] [US1] Write `src/prompts/guardrails.md` — non-clinical framing instructions shared by all prompts
- [x] T016 [US1] Implement retry orchestrator in `src/orchestrators/retry.ts` — 3× exponential backoff (configurable via `AI_TIMEOUT_MS`), 502 on final failure, uses provider
- [x] T017 [US1] Implement `src/parsers/repair.ts` — repair pipeline:
  - Attempt regex/structural fix on invalid JSON
  - Revalidate with Zod
  - If repair fails, attempt fallback model call
  - If fallback fails, return structured error for 502
- [x] T018 [US1] Implement `src/orchestrators/reflection/question.service.ts` — call provider with question prompt + schema, retry, parse, repair, validate with Zod, return `QuestionOutput`
- [x] T019 [US1] Implement `src/routes/reflection.ts` — `POST /v1/reflection/question` route:
  - Validate request body with Zod
  - Attach `x-request-id` to logs
  - Call `question.service`
  - Return `QuestionOutput` JSON
  - Wire bearer auth middleware
  - Return 400 on invalid input, 401 on bad auth, 502 on provider failure

**Checkpoint**: `POST /v1/reflection/question` live with repair pipeline and tracing.

### User Story 2 — Bias assessment after Q&A (P1)

**Goal**: After user answers all questions, public app submits story + Q&A and receives bias assessment + reflection prompt.

**Independent Test**: `POST /v1/reflection/assessment` with story, questions[], answers[] returns `{ biases: BiasItem[], reflectionPrompt: string }` with at least 1 bias.

- [x] T020 [P] [US2] Write prompt directory `src/prompts/reflection/assessment/`:
  - `system.md` — system prompt for assessment: category cheat-sheet (8–12 families), all 30 bias names + one-line definitions, guardrails, JSON output instructions
  - `examples.md` — few-shot assessment examples
  - `schema.md` — output JSON schema
- [x] T021 [US2] Implement `src/orchestrators/reflection/assessment.service.ts`:
  - Call provider with assessment prompt + story + Q&A + `BiasCatalogService.getShortlist()`
  - Use retry orchestrator + repair pipeline
  - Parse, validate with Zod (`assessmentOutputSchema`)
  - Return `AssessmentOutput`
- [x] T022 [US2] Add `POST /v1/reflection/assessment` route in `src/routes/reflection.ts`:
  - Validate request body (check questions[] and answers[] same length)
  - Attach `x-request-id` to logs
  - Call `assessment.service`
  - Return `AssessmentOutput` JSON

**Checkpoint**: `POST /v1/reflection/assessment` live with repair pipeline and tracing. ✅

### User Story 3 — Secure service access (P2)

**Goal**: Only authorized callers may use Core endpoints.

**Independent Test**: Requests without valid bearer token are rejected with 401; valid credentials allow both endpoints.

- [x] T023 [P] [US3] Write integration tests for auth middleware in `tests/integration/auth.test.ts`:
  - No token → 401
  - Wrong token → 401
  - Valid token → pass through to route handler
- [x] T024 [US3] Add auth middleware as Fastify hook on both reflection routes

**Checkpoint**: Auth enforced on all reflection endpoints. ✅

---

## Phase 3: Evaluation + deploy

**Purpose**: Golden test set, eval script, Vercel deploy, smoke test with public backend.

- [ ] T025 [P] Create `evaluations/golden/reflection/` with ≥5 seed stories and expected shape checks (parse rate, bias count, story-reference heuristic)
- [ ] T026 Create `scripts/eval-reflection.ts` — run golden set through both orchestrators, assert parse rate ≥ 99%, story-reference heuristic ≥ 90%
- [ ] T027 Create `vercel.json` if needed for Vercel Functions deployment
- [ ] T028 Write unit tests:
  - `tests/unit/parsers/json-from-llm.test.ts` — structured JSON extraction
  - `tests/unit/parsers/repair.test.ts` — repair pipeline edge cases
  - `tests/unit/catalog/bias-catalog.test.ts` — load, getShortlist, getCategories
  - `tests/unit/contracts/reflection.schemas.test.ts` — Zod validation
  - `tests/unit/lib/request-id.test.ts` — x-request-id generation and propagation
- [ ] T029 Write integration tests:
  - `tests/integration/question.test.ts` — mocked provider, full route
  - `tests/integration/assessment.test.ts` — mocked provider, full route
  - `tests/integration/repair-pipeline.test.ts` — malformed LLM output recovery
- [ ] T030 Deploy to Vercel, document `AI_CORE_BASE_URL`, `AI_CORE_API_KEY` in public backend env

**Checkpoint**: Eval green, Core deployed, public backend ready to connect.

---

## Phase 4: Public integration hardening

**Purpose**: Verify public `core-client.ts` against live Core, document contract, optional bias normalization.

- [ ] T031 Smoke E2E: public `AI_CLIENT_MODE=core` → full reflection flow (story → questions → answers → assessment) via deployed Core
- [ ] T032 Document contract publish path: `@biassemble/ai-contracts` or OpenAPI CI in `contracts/README.md`
- [ ] T033 [P] Add fuzzy bias name → catalog id normalization in `src/catalog/bias-catalog.ts` (Tier 2 starter)

**Checkpoint**: Public E2E green on `core` mode.

---

## Phase 5: Tier 2 slices (separate task batch — post-MVP)

**Purpose**: Provider benchmarking, prompt versioning, confidence scoring, evaluation expansion.

- [ ] T034 [P] Create provider benchmark script in `scripts/bench-providers.ts` (Gemini vs second provider)
- [ ] T035 [P] Document prompt version bump process in `prompts/registry.ts` with `@1.0.0` tags
- [ ] T036 [P] Implement `src/scoring/confidence.ts` — heuristic confidence scoring on assessment outputs
- [ ] T037 [P] Expand evaluations: `evaluations/adversarial/`, `evaluations/regression/`, `evaluations/providers/`

**Checkpoint**: Tier 2 enhancements ready for separate task batch.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — can start immediately
- **Phase 2 (Orchestrators + Gemini)**: Depends on Phase 1 setup
  - US1 tasks (T011–T019) must complete before US2 (T020–T022)
  - US3 auth (T023–T024) can run in parallel with US1/US2
- **Phase 3 (Evaluation + Deploy)**: Depends on Phase 2 completion
- **Phase 4 (Integration Hardening)**: Depends on Phase 3 deploy
- **Phase 5 (Tier 2)**: Independent of Phase 4 — can run in parallel or deferred

### Parallel Opportunities

- T004, T005, T006, T007, T008, T009 (Phase 1) — can run in parallel
- T011–T015 (Phase 2, provider + prompts + request-id + logger) — can run in parallel
- T020 (assessment prompt) parallel with US1 route work
- T023 (auth tests) parallel with orchestrator implementation
- T025, T027, T028 (Phase 3) — can run in parallel
- Phase 5 tasks (T034–T037) — all parallel

### MVP Scope

Complete Phase 1 → Phase 2 (US1 + US2) → Deploy. US3 (auth) is P2 but essential before production deployment.

---

## Implementation Strategy

### MVP First (US1 + US2, no tests initially)

1. Complete Phase 1: Scaffold, contracts, ~30 biases, request-id, logger
2. Complete Phase 2: Question orchestrator + Assessment orchestrator
3. Complete Phase 2: Repair pipeline + Attach routes + auth
4. Deploy to Vercel, smoke test with public backend
5. Add tests (Phase 3) after MVP is live

### Incremental Delivery

1. Phase 1 → empty Core + 30-bias catalog + request-id + logger (deployable skeleton)
2. Phase 2 US1 → question endpoint live → public can story → question
3. Phase 2 US2 → assessment endpoint live → full flow
4. Phase 3 → eval + deploy → production
5. Phase 4 → public integration hardened
6. Phase 5 → optional enhancements