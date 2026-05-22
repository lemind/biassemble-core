# Implementation Plan: AI Core Reflection MVP

**Date**: 2026-05-22 | **Spec**: [spec.md](spec.md) | **Architecture**: [architecture.md](architecture.md)

**Input**: Feature specification from `specs/001-reflection-core/spec.md`

## Summary

Deliver a **private Fastify service** that powers the public reflection journey: **story → 2–5 questions → full Q&A → bias assessment + reflection prompt**. MVP uses **Gemini Flash**, **Zod contracts**, **retrying AI orchestrators**, and a **curated ~30 Tier-A bias catalog** injected via prompt (no RAG yet). Deploy Core on **Vercel** (separate project); public Next backend keeps orchestration and session DB.

**User outcome**: Public app shows results; user can reuse assessment payload in future AI chat UIs (client-side; Core remains stateless).

## Technical Context

**Language/Version**: TypeScript 5.x strict, Node 22 LTS

**Primary Dependencies**: Fastify 5, Zod 4, `@google/generative-ai`, pino, vitest

**Storage**: None in Core (stateless). Bias catalog + prompts + golden sets on filesystem (`datasets/`, `prompts/`, `evaluations/`).

**Testing**: Vitest — unit (parsers, catalog, orchestrators), integration (HTTP + mocked Gemini)

**Target Platform**: Vercel Functions (Fastify entry `src/server.ts`); local Node for dev

**Performance Goals**: Question batch p95 < 7s (public FR-006: first question < 5s); JSON parse success > 99% on golden set

**Constraints**: No prompts/keys in public repo; min 1 bias / max none; 2–5 questions; constitution forbids RAG/fine-tune in this feature

**Scale/Scope**: MVP traffic on Gemini free/starter tier; ~30 curated Tier-A biases; 2 HTTP endpoints

## Constitution Check

*GATE: Pass (pre-design and post-design)*

| Principle | Plan compliance |
|-----------|-----------------|
| I Proprietary isolation | Prompts, catalog, `GEMINI_API_KEY` only in Core |
| II Contract-first | Zod; aligned with public `contracts.ts` |
| III Evaluation-first | Golden set + `eval-reflection` before prompt promotion |
| IV Modular simplicity | Monolith modules; Tier 3 RAG/embeddings deferred |
| V Structured outputs | JSON + Zod + retries + repair pipeline |
| VI Non-clinical | `guardrails.md` in every assessment/question prompt |

No complexity tracking violations.

## Capability tiers (delivery map)

### Tier 1 — in this plan (MVP Core)

- Structured JSON outputs (Gemini + schema instruction)
- Zod request/response validation
- Retries (3×, 1s base exponential, configurable timeout) + 502 on provider failure
- **Repair pipeline**: invalid JSON → repair attempt → revalidate → fallback model → fail
- Provider abstraction (`providers/types.ts` with `CompletionOptions`, Gemini first)
- **x-request-id** tracing through every request and log line
- **Observability early**: pino structured logs with latency, model used, retry count, parse failure count
- AI orchestrators (`question.service.ts`, `assessment.service.ts`)
- Evaluation dataset (`evaluations/golden/reflection/`)
- Bias catalog (~30 Tier-A entries) + shortlist injection in prompt

### Tier 2 — follow-up tasks (post-MVP, same repo)

- Provider comparison benchmarks
- Prompt versioning in registry (`@1.0.0` tags)
- Confidence scoring heuristics
- Benchmark scripts

### Tier 3 — future specs

- RAG over bias definitions
- Embeddings + semantic retrieval
- Fine-tuned classifier/ranker

## Bias catalog (~30 curated Tier-A): MVP approach

| Mechanism | What |
|-----------|------|
| `datasets/biases/taxonomy.v1.json` | ~30 high-quality biases with `id`, `name`, `category`, `definition`, `detectionSignals` |
| Curated list in prompt | All 30 names + one-line definitions injected into assessment prompt |
| No expansion until evaluation justifies it | Only add more biases when: retrieval exists, confidence scoring exists, evaluations prove need |

**Chosen biases (MVP seed)**:
confirmation bias, anchoring, sunk cost fallacy, survivorship bias, availability heuristic, halo effect, negativity bias, self-serving bias, optimism bias, hindsight bias, dunning-kruger effect, fundamental attribution error, bandwagon effect, confirmation bias (repetition reinforced), cherry-picking, framing effect, gambler's fallacy, just-world hypothesis, moral licensing, overconfidence effect, placebo effect, reactance, selection bias, spotlight effect, status quo bias, stereotyping, temporal discounting, third-person effect, ultimate attribution error, zero-risk bias

See [research.md](research.md) for rationale.

## Design decisions

### HTTP & types

- **Fastify** standalone (not Nest).
- **Zod** in `src/contracts/reflection.schemas.ts` is runtime SSOT.
- Public backend: manual sync MVP → private npm package later.
- **No OpenAPI generation in MVP** — Zod contracts are sufficient.

### Provider

- **Gemini Flash** only for MVP (`GEMINI_MODEL` env).
- `Provider` interface: `completeJson({ system, user, responseSchema, options? })`.
- `CompletionOptions`: `{ temperature?, maxTokens?, timeoutMs? }`.

### Orchestrators (not raw route handlers, not "workflows")

Routes delegate to orchestrators; orchestrators own retry + parse + repair + validate.

Naming: `question.service.ts`, `assessment.service.ts` (not `*.workflow.ts` — avoids confusion with Inngest durable workflows).

### Repair pipeline (CRITICAL)

All LLM output goes through:

```
invalid JSON
  ↓
repair attempt (regex/structural fix)
  ↓
revalidate with Zod
  ↓
fallback model call (if repair fails)
  ↓
fail → 502
```

This is real AI engineering, not just schema validation.

### x-request-id (NOW, not later)

Every request generates an `x-request-id` that flows through:
- Public backend → Core HTTP header
- Every Core log line
- Error responses

Tracing AI systems is critical from day one.

### Observability (early, not Phase 5)

At minimum via pino structured logs:
- Request duration (latency)
- Model used
- Retry count
- Parse success/failure count
- `AI_TIMEOUT_MS` env var prevents Vercel cold start amplification

### Prompts: directory structure (not flat files)

Each prompt version becomes a directory with separated concerns:

```
prompts/reflection/question-batch/
  system.md
  examples.md
  schema.md
```

This matches how serious AI teams version and experiment with prompts.

### Assessment "whole picture"

Single assessment call receives `story`, `questions[]`, `answers[]` (equal length). No partial Q&A in MVP.

### Deployment

- **Vercel project B** for `biassemble-core`.
- **Vercel project A** for existing Next + Vite.
- Public env: `AI_CORE_BASE_URL`, `AI_CORE_API_KEY`, `AI_CLIENT_MODE=core`.

## Project Structure

### Documentation (this feature)

```text
specs/001-reflection-core/
├── spec.md
├── plan.md              # this file
├── research.md
├── data-model.md
├── architecture.md
├── quickstart.md
├── contracts/
│   ├── reflection-api.openapi.yaml
│   └── README.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root — to be created)

```text
biassemble-core/
├── src/
│   ├── server.ts
│   ├── routes/reflection.ts
│   ├── orchestrators/retry.ts
│   ├── orchestrators/reflection/
│   │   ├── question.service.ts
│   │   └── assessment.service.ts
│   ├── providers/{types,gemini}.ts
│   ├── prompts/{registry.ts, guardrails.md, reflection/}
│   │   └── reflection/
│   │       ├── question-batch/
│   │       │   ├── system.md
│   │       │   ├── examples.md
│   │       │   └── schema.md
│   │       └── assessment/
│   │           ├── system.md
│   │           ├── examples.md
│   │           └── schema.md
│   ├── parsers/json-from-llm.ts
│   ├── parsers/repair.ts
│   ├── contracts/reflection.schemas.ts
│   ├── catalog/bias-catalog.ts
│   ├── lib/{auth,env,request-id}.ts
│   └── observability/logger.ts
├── datasets/biases/taxonomy.v1.json
├── evaluations/golden/reflection/
├── tests/{unit,integration,contract}/
├── scripts/{eval-reflection}.ts
├── package.json
├── .env.example
└── vercel.json (if needed)
```

**Structure decision**: Single private service repo; no monorepo merge with public `biassemble` required for MVP.

## Implementation Phases

### Phase 0: Scaffold & contracts ✅ (planning)

- Spec-kit plan artifacts (this directory)
- Root `API.md` aligned (2–5 questions; min 1 bias)

### Phase 1: Project scaffold + catalog seed

- `package.json`, tsconfig, Fastify `src/server.ts`, health route
- `src/lib/request-id.ts` — generate and attach `x-request-id` to every request + log
- `src/observability/logger.ts` — pino structured logger with request-id, latency tracking
- Zod schemas mirroring OpenAPI
- `datasets/biases/taxonomy.v1.json` — **~30 curated Tier-A biases** only
- `BiasCatalogService`: load JSON, `getShortlist()`, `getCategories()`
- `.env.example`, README
- `AI_TIMEOUT_MS` in env config

### Phase 2: Tier 1 — orchestrators + Gemini

- `providers/gemini.ts` + mock provider for tests
- `providers/types.ts` with `CompletionOptions` (temperature, maxTokens, timeoutMs)
- Prompt registry + directory-based prompts (`question-batch/system.md`, `assessment/system.md`, `guardrails.md`)
- `question.service.ts` + `assessment.service.ts` with retries + repair pipeline
- `parsers/repair.ts` — invalid JSON → repair → revalidate → fallback → fail
- Routes: `POST /v1/reflection/question`, `POST /v1/reflection/assessment`
- Bearer auth middleware
- Integration tests (mocked provider)

### Phase 3: Evaluation + deploy

- `evaluations/golden/reflection/` (≥5 stories with expected shape checks)
- `scripts/eval-reflection.ts` — parse rate, story-reference heuristic
- Vercel deploy + document `AI_CORE_BASE_URL` for public backend
- Smoke E2E: public `AI_CLIENT_MODE=core` → full reflection flow

### Phase 4: Public integration hardening

- Verify public `core-client.ts` against live Core
- Document contract publish path (`@biassemble/ai-contracts` or OpenAPI CI)
- Optional: normalize bias names to catalog ids (Tier 2 starter)

### Phase 5: Tier 2 slices (separate task batch)

- Provider benchmark script (Gemini vs second provider)
- Prompt version bump process
- `scoring/confidence.ts` on assessment outputs
- Evaluation expansion: adversarial, regression, provider-specific datasets

## Integration with public `biassemble`

| Public step | Core endpoint |
|-------------|---------------|
| `POST /api/story` | `POST /v1/reflection/question` |
| After batch `POST /api/answers` | `POST /v1/reflection/assessment` |
| Results / future AI chat | Uses persisted assessment JSON from public DB |

Public keeps: `dev-mock`, session status, `setImmediate` assessment trigger, polling.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| ~30 biases may miss edge cases | Enough for MVP; evaluations will justify expansion |
| Hallucinated bias names | All 30 names injected into prompt + Tier 2 normalization |
| Gemini rate limits | Retries, flash model, configurable timeout, monitor RPD |
| Vercel cold start > 5s | Fluid compute; `AI_TIMEOUT_MS` prevents amplification |
| Contract drift | Zod SSOT + contract tests |
| Malformed LLM output | Repair pipeline (repair → revalidate → fallback → fail) |

## Phase mapping (next: tasks.md)

| Phase | Outcome |
|-------|---------|
| 1 | Runnable empty Core + catalog file + request-id + logger |
| 2 | Both endpoints live with Gemini + repair pipeline |
| 3 | Eval green + Vercel deployed |
| 4 | Public E2E on `core` mode |
| 5 | Tier 2 enhancements |

---

**Next command**: `/speckit-tasks` to generate `tasks.md` with file-level checkpoints.