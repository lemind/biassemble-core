# Research: AI Core Reflection MVP

**Feature**: `specs/001-reflection-core` | **Date**: 2026-05-22

## 1. Bias taxonomy (~30 curated Tier-A biases): how to add them without breaking MVP

### Decision

Use a **structured bias catalog on disk** with **progressive injection** into prompts — all 30 names + one-line definitions in the assessment prompt.

| Approach | MVP (now) | Tier 2 | Tier 3 (later) |
|----------|-----------|--------|----------------|
| **Catalog file** | `datasets/biases/taxonomy.v1.json` — id, name, category, definition, detectionSignals. **~30 Tier-A entries only.** | Versioned releases; prompt registry references catalog version | Same file + embeddings per row |
| **Prompt injection** | Inject all 30 names + one-line definitions in assessment prompt | Add optional **shortlist step**: cheap model picks 5–10 candidate bias IDs from catalog metadata | Full catalog retrieval via RAG |
| **RAG** | Out of scope for MVP | Prototype offline eval only | Embed story+Q&A → retrieve top-k bias definitions → inject into assessment prompt |
| **Own / fine-tuned models** | Out of scope | — | Classifier or ranker trained on golden set |

### Catalog record shape (each of ~30 entries)

```json
{
  "id": "confirmation-bias",
  "name": "Confirmation Bias",
  "category": "information-processing",
  "definition": "Seeking or interpreting information that confirms existing beliefs.",
  "detectionSignals": ["only looked for supporting evidence", "dismissed counterexamples"]
}
```

- **No tier-b/c for MVP.** Do not expand until evaluations justify it, retrieval exists, and confidence scoring is implemented.
- **Categories** (examples): information-processing, memory, probability, social, decision, motivation, perception.

### MVP assessment flow (single provider call + validation)

```text
story + Q&A
  → build assessment prompt with:
      - guardrails (non-clinical)
      - all 30 bias names + one-line definitions
      - instruction: return ≥1 biases from the list when supported
  → Gemini structured JSON
  → Zod validate output
  → repair pipeline on invalid JSON
  → optional: normalize bias `name` to catalog `id` via fuzzy match (Tier 2)
```

### What to build now so Tier 3 is easy later

1. Stable `id` per bias (never rename; deprecate with `replacedBy`).
2. Store definitions in JSON, not hardcoded in `.md` prompts.
3. Prompt templates reference `{{biasShortlist}}` / `{{biasCategories}}` filled by `BiasCatalogService`.
4. Golden eval cases name expected `id`s, not free-text strings.

---

## 2. Capability tiers (your list → delivery mapping)

### Tier 1 — MVP Core (this feature)

| Capability | Implementation |
|------------|----------------|
| Structured outputs | Gemini JSON mode + strict response schema in prompt |
| Zod validation | `contracts/reflection.schemas.ts`; validate request + response |
| Retries + repair pipeline | `orchestrators/retry.ts` — 3× exponential backoff + `parsers/repair.ts` — invalid JSON → repair → revalidate → fallback → fail |
| Provider abstraction | `providers/types.ts` with `CompletionOptions` + `providers/gemini.ts` |
| AI orchestrators | `orchestrators/reflection/question.service.ts`, `assessment.service.ts` |
| x-request-id tracing | `lib/request-id.ts` — every request + log line |
| Observability | `observability/logger.ts` — pino structured logs with latency, model, retries, parse failures |
| Evaluation dataset | `evaluations/golden/reflection/*.json` + `scripts/eval-reflection.ts` |

### Tier 2 — same repo, post-MVP slices

| Capability | Implementation |
|------------|----------------|
| Provider comparison | `evaluations/benchmarks/providers.ts` — same golden set, multiple providers |
| Prompt versioning | `prompts/registry.ts` — `question-batch@1.0.0`, `assessment@1.0.0` |
| Confidence scoring | `scoring/confidence.ts` — heuristic on parse retries, output length, catalog match |
| Benchmark scripts | `scripts/benchmark-providers.ts`, `scripts/eval-reflection.ts` |

### Tier 3 — separate features (constitution IV)

RAG, embeddings, semantic retrieval, fine-tuned models — require constitution amendment + new spec when started.

---

## 3. Type sharing (Core ↔ public Next)

### Decision

**Zod in `src/contracts/reflection.schemas.ts` is source of truth** — no OpenAPI generation in MVP.

Public `biassemble` backend:

- **Phase A (MVP)**: Keep `lib/ai/contracts.ts` in sync manually (already aligned).
- **Phase B**: Publish `@biassemble/ai-contracts` private package.

Core MUST NOT import Next/Drizzle types.

---

## 4. HTTP stack & deployment

### Decision

- **Fastify** + TypeScript on Node 22.
- **Deploy**: Vercel separate project (Fluid compute); entry `src/server.ts`.
- **Secrets**: `GEMINI_API_KEY`, `AI_CORE_API_KEY` on Core project only.
- Public sets `AI_CORE_BASE_URL` + `AI_CLIENT_MODE=core`.

**Alternative** if cold starts break FR-006: Railway/Render always-on — document in ops, not MVP blocker.

---

## 5. Provider: Gemini first

### Decision

- Model: **`gemini-2.0-flash`** or **`gemini-2.5-flash`** (config via `GEMINI_MODEL`).
- SDK: `@google/generative-ai`.
- Free tier via Google AI Studio for dev; plan paid tier before production scale.
- Fallback provider interface ready; no second provider required for MVP ship.

---

## 6. End-to-end product flow (MVP)

```text
User (public frontend)
  → POST /api/story { story }
  → Public Next: session create + sync POST /v1/reflection/question
  → Core: question orchestration → { questions[2-5], isComplete }
  → User answers all questions in UI
  → POST /api/answers { sessionId, answers[] }
  → Public: persist + async assessment trigger
  → POST /v1/reflection/assessment { story, questions, answers }
  → Core: assessment orchestration (30-bias shortlist) → { biases[], reflectionPrompt }
  → User views ResultsView; future "play in AI chat" uses same assessment payload client-side
```

Core is **stateless**; "whole picture" = story + full Q&A arrays in one assessment request.

---

## Alternatives considered

| Topic | Rejected | Why |
|-------|----------|-----|
| NestJS | Heavier framework | Two routes; Fastify + modules sufficient |
| All 200 biases in prompt | Context noise | 30 curated biases is enough for MVP |
| YAML-first contracts | Drift from runtime | Zod validates at runtime; no OpenAPI needed for MVP |
| RAG in MVP | Constitution YAGNI | Tier 3; catalog file seeds future embeddings |