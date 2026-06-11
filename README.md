> A TypeScript reasoning engine that forces LLM outputs to be evidence-bound,
> auditable, and testable. Built for #LLMOps, #AIObservability, and
> evaluation-first workflows.

# Biassemble AI Core

LLM-powered reasoning engine for cognitive bias detection. Structured, evaluable, provider-agnostic.

🔗 **Live**: [frontend-topaz-eight-10.vercel.app](https://frontend-topaz-eight-10.vercel.app/)
📦 **Main repo**: [github.com/lemind/biassemble](https://github.com/lemind/biassemble)

## What It Does

Two endpoints. Structured output. Auditable reasoning.

| Endpoint | Trigger | Output |
|----------|---------|--------|
| `POST /v1/reflection/question` | User submits story | 2–5 contextual follow-up questions |
| `POST /v1/reflection/assessment` | User answers questions | Bias assessment + reflection prompt |

Every response is validated through Zod → JSON, stamped with `prompt_version` + `schema_version`, and goes through a 3-stage repair pipeline (parse → validate → fallback model call).

## Bias Detection

~30 curated Tier-A cognitive biases — confirmation bias, anchoring, availability heuristic, sunk cost, and more. Names normalized against a taxonomy (`datasets/biases/taxonomy.v1.json`). Expand only when evaluations justify it.

## Reliability

- **Retry + repair pipeline** — malformed LLM output → structural extraction → repair → revalidate → fallback model call → 3× exponential backoff
- **Structured JSON output** — all LLM responses constrained to typed Zod schemas
- **Prompt versioning** — every output stamped with `prompt_version` for traceability
- **x-request-id tracing** — every request logged with correlation ID
- **Provider-agnostic** — adapter interface, swap models without touching orchestrators

## Stage 002 — Reasoning Infrastructure ✅

Auditable reasoning engine with structured traces, evidence binding, and evaluation infrastructure.

- **Reasoning traces** — structured intermediate steps (story analysis → interpretations → bias hypotheses → evidence mapping) alongside every assessment
- **Evidence binding** — each bias claim references verbatim excerpts from the user's story
- **Two-phase assessment** — story-only assessment first, then a richer post-questions analysis showing how answers shifted the analysis
- **Quality metrics** — `evidence_grounded_rate`, `false_positive_rate`, `schema_parse_rate`, `repair_rate`
- **Adversarial testing** — 13 neutral stories in `evaluations/no_bias/` to catch false positives
- **CI evaluation gate** — automated prompt quality checks on every change via `.github/workflows/prompt-eval.yml`
- **Inngest eval job** — `src/jobs/eval-assessment.ts` runs golden + no_bias datasets, persists results, checks determinism

All 40 tasks across 7 phases complete. 224/225 tests pass. See `specs/002-reasoning-infrastructure/` for full spec.

## Evaluation

- **Golden set**: 5 curated stories in `evaluations/golden/reflection/` (work-conflict, relationship-decision, financial-regret, health-uncertainty, creative-block)
- **Eval script**: `scripts/eval-reflection.ts` — runs stories through real orchestrators + mock provider, computes metrics
- **Metrics**: `computeEvaluationMetrics()` + `computeSystemMetrics()` — evidence grounding, false positives, parse rates, repair rates

## Architecture

```
Public App → Public API (Next.js) → AI Core (Fastify) → LLM Provider
                     ↑              ↑
               session state     prompts, provider keys,
               Inngest jobs      reasoning traces (Postgres)
```

## Tech Stack

- **Runtime**: Node 22 LTS, TypeScript 5.x strict
- **Framework**: Fastify 5
- **LLM**: Provider-agnostic adapter (currently Gemini Flash)
- **Validation**: Zod 4
- **DB**: Drizzle ORM + PostgreSQL (reasoning traces, eval results)
- **Logging**: Pino
- **Testing**: Vitest (unit + integration)
- **Deploy**: Vercel Functions

## Quick Start

```bash
pnpm install
cp .env.example .env
# edit .env with your API keys
pnpm dev

# verify
curl http://localhost:3001/health
# → {"status":"ok"}

# run tests
pnpm test
# → 122 tests passing
```

### Local Dev vs Vercel Deployment

- **Local dev** (`pnpm dev`): runs `src/dev.ts` which starts a long-lived Fastify server on `localhost:3001` via `tsx --watch` (auto-restarts on file changes). Best for development.
- **Vercel** (`pnpm deploy`): uses `api/index.ts` which exports the Fastify app as a serverless function. Each request is a cold-start Lambda with a 30s timeout. The `/v1/reflection/assessment` endpoint may hit this timeout on Vercel's free plan — consider upgrading to Pro (60s timeout) or running assessment as an async Inngest job for longer-running evaluations.

### Vercel Logs

```bash
# Install Vercel CLI and link the project
vercel link

# Tail recent logs
vercel logs biassemble-core.vercel.app

# Follow live
vercel logs biassemble-core.vercel.app --follow
```

Or view logs in the [Vercel Dashboard](https://vercel.com) → biassemble-core project → "Logs" tab.

## Project Structure

```
src/
├── contracts/       # Zod schemas (reasoning + reflection)
├── orchestrators/   # Question + assessment services
├── prompts/         # Markdown-based prompt templates
├── providers/       # LLM adapter interface
├── parsers/         # JSON extraction + repair pipeline
├── catalog/         # Bias taxonomy + normalization
├── evaluation/      # Metrics functions
├── db/              # Drizzle schema + queries
├── jobs/            # Inngest eval job
└── routes/          # Fastify HTTP routes

evaluations/
└── golden/reflection/   # 5 curated test stories

tests/
├── unit/            # Parsers, schemas, metrics, catalog
└── integration/     # Full pipeline with mock provider