# System State — biassemble-core

**Last updated**: 2026-06-04

## Repo

- **GitHub**: `lemind/biassemble-core` (private)
- **Branch**: `phase-3` (current active branch)
- **Remote**: `origin/phase-3` pushed

## What's built (Phase 1-3 complete)

### Source code (`src/`)
- `server.ts` — Fastify server with health route + reflection endpoints
- `routes/reflection.ts` — `POST /v1/reflection/question`, `POST /v1/reflection/assessment`
- `orchestrators/reflection/question.service.ts` — Question generation with retry + repair pipeline
- `orchestrators/reflection/assessment.service.ts` — Bias assessment with retry + repair pipeline
- `orchestrators/retry.ts` — Exponential backoff retry (3 attempts, 1s base)
- `providers/gemini.ts` — Gemini Flash provider
- `providers/types.ts` — Provider interface
- `parsers/repair.ts` — `tryRepairJson` + `repairWithFallback` (extractJson → parse → validate → fallback model call)
- `parsers/json-from-llm.ts` — Structural JSON extraction from LLM prose output
- `contracts/reflection.schemas.ts` — Zod schemas (SSOT)
- `catalog/bias-catalog.ts` — ~30 Tier-A bias catalog
- `prompts/registry.ts` — Prompt rendering from markdown files
- `prompts/reflection/question-batch/` — system.md, examples.md, schema.md
- `prompts/reflection/assessment/` — system.md, examples.md, schema.md
- `prompts/guardrails.md` — Non-clinical constitution guardrails
- `lib/auth.ts` — Bearer token auth
- `lib/env.ts` — Zod env validation
- `lib/request-id.ts` — x-request-id tracing
- `observability/logger.ts` — Pino structured logger

### Tests
- **Unit tests**: `tests/unit/` — parsers, contracts, catalog, request-id (all passing)
- **Integration tests**: `tests/integration/` — question, assessment, auth, repair-pipeline (all passing)
- **Mock provider**: `tests/mocks/mock-provider.ts` — deterministic AI responses for testing

### Evaluation
- `scripts/eval-reflection.ts` — Runs golden stories through real orchestrators + MockProvider
- `evaluations/golden/reflection/` — 5 golden stories (creative-block, financial-regret, health-uncertainty, relationship-decision, work-conflict)

### Config
- `vercel.json` — Vercel Functions config (512MB, 30s timeout)
- `package.json` — build: tsc, dev: tsx watch, test: vitest
- `.env.example` — All required env vars documented

## Vercel

- **Account**: `dmitrys-projects-0d7e8a27`
- **Existing projects**: `biassemble-backend` (public Next.js), `frontend` (Vite), `chronacc-f`, `next-dashboard`
- **Core project**: NOT YET CREATED — needs `vercel link` + `vercel deploy`

### Env vars needed in Vercel dashboard:
| Variable | Source |
|----------|--------|
| `GEMINI_API_KEY` | Google AI Studio |
| `GEMINI_MODEL` | `gemini-2.0-flash` |
| `AI_CORE_API_KEY` | Generate a secure random key |
| `LOG_LEVEL` | `info` |

## Public backend (`biassemble/backend`)

- Deployed at `https://biassemble-backend.vercel.app`
- Has `AI_CLIENT_MODE=core` support in `src/lib/ai/core-client.ts`
- Needs `AI_CORE_BASE_URL` and `AI_CORE_API_KEY` env vars to connect to Core

## What's NOT done (Phase 3 gaps)

- [ ] Deploy Core to Vercel (project not created yet)
- [ ] Set `AI_CORE_BASE_URL` + `AI_CORE_API_KEY` in public backend env
- [ ] Smoke E2E test: public → Core full reflection flow

## Stage 002 — Reasoning Infrastructure (partial)

- [x] `src/persistence/types.ts` — Record types for Session, Run, Trace, EvalResult (with `provider` field)
- [x] `src/persistence/ports.ts` — Persistence interfaces (SessionStore, RunStore, TraceStore, EvalResultStore)
- [x] `src/evaluation/compute-evaluation-metrics.ts` — `evidence_grounded_rate`, `false_positive_rate` (from 001-core)
- [x] `src/evaluation/compute-system-metrics.ts` — `schema_parse_rate`, `repair_rate` (from 001-core)
- [x] `backend/src/drizzle/schema.ts` — Drizzle tables: runs, reasoning_traces, eval_results (provider added, trace_type removed)
- [x] `backend/src/lib/db/queries.ts` — Query functions: createRun, getRunsBySession, persistTrace, getTrace, persistEvalResult, getEvalResultByHash, getLatestEvalResults
- [ ] Orchestrator upgrade (two-phase assessment with reasoning traces)
- [ ] Evidence binding + validator
- [ ] no_bias dataset
- [ ] CI eval gate (Inngest + GitHub Actions)

## Next steps

1. `vercel link` in `biassemble-core/` to create project
2. Set env vars in Vercel dashboard
3. `vercel deploy` to deploy Core
4. Copy Core URL to public backend's `AI_CORE_BASE_URL`
5. Test E2E: story → questions → answers → assessment
6. Continue Stage 002: orchestrator upgrade, evidence binding, no_bias dataset, CI gate
</｜｜DSML｜｜parameter>
</｜｜DSML｜｜invoke>
</｜｜DSML｜｜tool_calls>