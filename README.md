> A TypeScript reasoning engine that forces LLM outputs to be evidence-bound,
> auditable, and testable. Built for #LLMOps, #AIObservability, and
> evaluation-first workflows.

# Biassemble AI Core

LLM-powered reasoning engine for cognitive bias detection. Structured, evaluable, provider-agnostic.

🔗 **Live**: [frontend-topaz-eight-10.vercel.app](https://frontend-topaz-eight-10.vercel.app/)
📦 **Main repo**: [github.com/lemind/biassemble](https://github.com/lemind/biassemble)

## What It Does

Six endpoints. Structured output. Auditable reasoning.

| Endpoint | Trigger | Output |
|----------|---------|--------|
| `POST /v1/reflection/question` | User submits story | 2–5 contextual follow-up questions |
| `POST /v1/reflection/assessment` | User answers questions | Bias assessment + reflection prompt |
| `POST /audit` | Submit an AI-generated text + its source documents | `202` + `audit_id` (async job) |
| `GET /audit/:audit_id` | Poll for the result | Per-claim verdicts + groundedness scores |
| `POST /extract` | Submit any text (no source documents required) | `202` + `id` (async job) |
| `GET /status/:id` | Poll for the result | Per-claim fact-check verdicts, sourced from the open web |

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

All 40 tasks across 7 phases complete. See `specs/002-reasoning-infrastructure/` for full spec.

## RAG Integration — Stage 005 + D017

`biassemble-engine` (a separate FastAPI sidecar — vector search + a local LLM over the bias catalog) augments assessments with retrieved evidence. Retrieval is **async, no wait budget**: fired as a background Inngest job (`rag/retrieve.requested`) at story-submission time; the full assessment reads whatever's landed in `runs.rag_result` as a one-time snapshot and proceeds regardless — a slow/unavailable engine never blocks or fails a user-facing response (see `docs/decisions/014-tiered-context-retrieval.md`).

Every assessment records provenance to `core.retrieval_comparisons` — which signal (engine vector search, engine's own LLM, or the assessment LLM alone) surfaced each bias, via an open-ended `source_breakdown` map (never a fixed "both" column — see `docs/decisions/017-engine-provenance-tracking.md`). `rag_status` distinguishes `retrieved` (RAG was available live, in time to inform the output) from `backfilled` (RAG arrived after the fact; a background job patches the analytics-only fields in for retrospective comparison, but it did not shape what the user saw).

## B2B Audit Mode — Stage 008

`POST /audit` checks someone else's AI-generated output (e.g. a financial research tool's summary) against the source documents it claims to be drawn from — built to answer "can I trust what this AI just told me?" for a buyer, not a builder.

- **Claim pipeline**: EXTRACT (pull individual factual claims out of the submitted text) → RETRIEVE (find matching passages in the submitted sources) → VERIFY (compare each claim against its evidence) → GATE (compute business-facing scores)
- **Verdicts**: `supported`, `partially_supported`, `contradicted`, `unsupported`, `unverifiable` — the last is the "could not be decided" verdict, reached three ways: low-confidence gating below the threshold (FR-011), retrieval infrastructure failures (so they never contaminate the contradiction/unsupported rates), and VERIFY batch degradation when a response can't be parsed after retries (D018 §5.10)
- **Numeric reconciliation**: a deterministic code-side check (not another LLM call) catches cases where a model's own arithmetic is right but its stated conclusion is wrong — e.g. "$111,184M vs $95,359M is more than doubling" (it's 1.17×, not ≥2×) — and cases of scale/unit mismatches ($640M claimed vs $64M cited)
- **Reference-drift guard**: a deterministic check in EXTRACT catches the model paraphrasing away a sub-reference its own excerpt cites (e.g. "Article 19-2" collapsed to "Article 19") — found via a real audit run against app.gc.ai, where the mangled claim was then correctly rejected by VERIFY, producing a false "the audited output got this wrong" reading of a claim it actually stated correctly
- **Inference-tolerance policy**: VERIFY's prompt explicitly ranks how far a verdict may reason beyond literal wording — direct restatement, logically-necessary entailment (a negative claim ruled out by an explicit exclusive fact = supported), or plausible-but-unstated inference (an adjacent but non-equivalent fact = `partially_supported`, never rounded up) — added after the same app.gc.ai run surfaced both failure directions at once
- **Async by design**: submitting an audit returns immediately with `{ audit_id, status: "running" }`; poll `GET /audit/:audit_id` for the finished result (`Retry-After: 5` while running)
- **Immutable results**: a completed or failed audit is never recomputed — `GET` always returns exactly what was persisted
- **Golden sets**: 12 EXTRACT cases + 41 VERIFY cases + 20 numeric-normalization cases in `evaluations/golden/audit/`, each one hand-labeled before the prompt it tests existed to run against it; several were added directly from real production/audit incidents, not hypotheticals, including verbatim repros of three real target-run failures across two companies
- **Deterministic model calls**: EXTRACT and VERIFY pass `temperature: 0` explicitly — found necessary after a real audit re-run on identical input produced three different claim sets and score patterns, making any fix unverifiable by re-running the live pipeline

See `specs/008-b2b/quickstart.md` for example `curl` commands and `docs/decisions/018-audit-mode-flag.md` for the full design rationale. Out of scope for this stage: real document corpus ingestion (still a lexical stub retriever), the bias-module cross-check, and a review UI.

## Grounnel — Stage 009

`POST /extract` fact-checks arbitrary text against the open web — no source documents required, unlike B2B Audit Mode above. Built to answer "is this actually true?" for any claim-bearing article, not just an AI's own output.

- **Claim pipeline**: EXTRACT (pull atomic, checkable factual claims) → SEARCH (Gemini `google_search` grounding for URL discovery only, DIY fetch, Tavily fallback) → semantic reranking → VERIFY (an LLM classifies each claim against its retrieved passages) → a 6-gate deterministic verdict-correction chain → adaptive escalation (3→5→8 sources) for claims still unresolved
- **Verdicts**: `supported`, `partially_supported`, `contradicted`, `unsupported`, `unverifiable` (low-confidence downgrade)
- **Grounded by construction**: passages are split into numbered sentences in code; VERIFY cites sentence numbers, never generates quote text — evidence can't be fabricated
- **Deterministic gate chain**: reason/verdict consistency, evidence-groundedness, numeric threshold/equality comparison, temporal-scope comparability, implicit-negation detection, cross-claim contamination — each backed by real production incidents, see `docs/decisions/026-verify-retrieval-first-grounding.md`
- **Recent reliability fixes** (self-review, 2026-08-11): a `contradicted` verdict landing straight off VERIFY's ordinary first pass now gets the same reason-consistency scrutiny previously only given to retries and escalation rounds, closing a false-positive gap on the pipeline's most common path; the numeric threshold gate no longer treats an exact-equality value as satisfying a strict "exceeded/surpassed" claim; adaptive search escalation now actually widens the candidate pool under the Tavily-forced search flow instead of silently re-issuing the identical call every tier

See `specs/009-grounnel/` for the full spec and `docs/decisions/026-verify-retrieval-first-grounding.md` for the design history (22+ addenda, each a real traced production or live-test finding).

## Evaluation

- **Golden set**: 5 curated stories in `evaluations/golden/reflection/` (work-conflict, relationship-decision, financial-regret, health-uncertainty, creative-block)
- **Eval script**: `scripts/eval-reflection.ts` — runs stories through real orchestrators + mock provider, computes metrics
- **Metrics**: `computeEvaluationMetrics()` + `computeSystemMetrics()` — evidence grounding, false positives, parse rates, repair rates

## Architecture

```
Public App → Public API (Next.js) → AI Core (Fastify) → LLM Provider
                     ↑              ↑      ↓
               session state     prompts   biassemble-engine (RAG sidecar)
               Inngest jobs      provider   — async, no wait budget —
                                 keys        vector search + local LLM
                                 reasoning
                                 traces (Postgres)
```

## Tech Stack

- **Runtime**: Node 22 LTS, TypeScript 5.x strict
- **Framework**: Fastify 5
- **LLM**: Provider-agnostic adapter (currently Gemini Flash)
- **Validation**: Zod 4
- **DB**: Drizzle ORM + PostgreSQL (reasoning traces, eval results, RAG provenance)
- **Background jobs**: Inngest (eval runs + async RAG retrieval)
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
# → all tests passing (1002 as of this writing — grows with each feature)
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
├── contracts/       # Zod schemas (reasoning + reflection + grounnel)
├── orchestrators/   # Question/assessment services, audit VERIFY, grounnel/ (extract + pipeline + gates)
├── prompts/         # JSON/Markdown-based prompt templates, incl. prompts/grounnel/
├── providers/       # LLM adapter interface + providers/search/ (Gemini discovery, DIY fetch, Tavily)
├── parsers/         # JSON extraction + repair pipeline
├── catalog/         # Bias taxonomy + normalization
├── evaluation/      # Metrics functions
├── rag/             # biassemble-engine client + workspace builder (RAG integration)
├── observability/   # Structured logging + retrieval_comparisons provenance recorder
├── persistence/     # Grounnel durable-write stores (runs, claims, LLM calls, search calls, gate events)
├── db/              # Drizzle schema + queries
├── jobs/            # Inngest jobs (eval runs, async RAG retrieval)
└── routes/          # Fastify HTTP routes

evaluations/
└── golden/reflection/   # 5 curated test stories

tests/
├── unit/            # Parsers, schemas, metrics, catalog
└── integration/     # Full pipeline with mock provider