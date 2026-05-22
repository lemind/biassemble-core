# Research: AI Core Reflection MVP

**Feature**: `specs/001-reflection-core` | **Date**: 2026-05-22

## 1. Bias taxonomy (~200 biases): how to add them without breaking MVP

### Decision

Use a **structured bias catalog on disk** as the long-term source of truth, with **progressive injection** into prompts — not all 200 names in one system message.

| Approach | MVP (now) | Tier 2 | Tier 3 (later) |
|----------|-----------|--------|----------------|
| **Catalog file** | `datasets/biases/taxonomy.v1.json` — id, name, category, definition, signals | Versioned releases; prompt registry references catalog version | Same file + embeddings per row |
| **Subprompt / shortlist** | Inject **category map** (~8–12 families) + **top-N canonical names** (~25–40) in assessment prompt | Add optional **shortlist step**: cheap model picks 5–10 candidate bias IDs from catalog metadata | Full catalog retrieval via RAG |
| **RAG** | Out of scope for MVP | Prototype offline eval only | Embed story+Q&A → retrieve top-k bias definitions → inject into assessment prompt |
| **Own / fine-tuned models** | Out of scope | — | Classifier or ranker trained on golden set |

### Catalog record shape (each of ~200 entries)

```json
{
  "id": "confirmation-bias",
  "name": "Confirmation Bias",
  "category": "information-processing",
  "definition": "Seeking or interpreting information that confirms existing beliefs.",
  "detectionSignals": ["only looked for supporting evidence", "dismissed counterexamples"],
  "relatedIds": ["availability-heuristic"],
  "mvpPriority": "tier-a"
}
```

- **`mvpPriority`**: `tier-a` (common, include in shortlist), `tier-b` (catalog only, model may name if confident), `tier-c` (RAG-only later).
- **Categories** (examples): information-processing, memory, probability, social, decision, motivation, perception.

### MVP assessment flow (single provider call + validation)

```text
story + Q&A
  → build assessment prompt with:
      - guardrails (non-clinical)
      - category cheat-sheet (all families, 1 line each)
      - tier-a bias name list (25–40 items, "prefer these labels when supported")
      - instruction: return ≥1 biases from catalog; may use tier-b name if clearly supported
  → Gemini structured JSON
  → Zod validate output
  → optional: normalize bias `name` to catalog `id` via fuzzy match (Tier 2)
```

**Why not 200 in system prompt**: blows context, dilutes focus, increases hallucinated bias names. Category + tier-a shortlist gives "use something from the library first" without Tier 3 infra.

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
| Retries / fallbacks | `orchestrators/retry.ts` — 3× exponential backoff; 502 on provider failure |
| Provider abstraction | `providers/types.ts` + `providers/gemini.ts` (first); stub `providers/fallback.ts` |
| AI workflows | `orchestrators/reflection/question.workflow.ts`, `assessment.workflow.ts` |
| Evaluation dataset | `evaluations/golden/reflection/*.json` + `scripts/eval-reflection.ts` |

### Tier 2 — same repo, post-MVP slices

| Capability | Implementation |
|------------|----------------|
| Provider comparison | `evaluations/benchmarks/providers.ts` — same golden set, multiple providers |
| Observability | `pino` + requestId; optional Vercel / OpenTelemetry later |
| Prompt versioning | `prompts/registry.ts` — `question-batch@1.0.0`, `assessment@1.0.0` |
| Confidence scoring | `scoring/confidence.ts` — heuristic on parse retries, output length, catalog match |
| Benchmark scripts | `scripts/benchmark-providers.ts`, `scripts/eval-reflection.ts` |

### Tier 3 — separate features (constitution IV)

RAG, embeddings, semantic retrieval, fine-tuned models — require constitution amendment + new spec when started.

---

## 3. Type sharing (Core ↔ public Next)

### Decision

**Zod in `biassemble-core/contracts/` is source of truth**; generate **`openapi/reflection-api.yaml`** via `zod-to-openapi` for docs and optional public codegen.

Public `biassemble` backend:

- **Phase A (MVP)**: Keep `lib/ai/contracts.ts` in sync manually (already aligned).
- **Phase B**: Publish `@biassemble/ai-contracts` private package OR CI regen from OpenAPI artifact.

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
  → Core: question workflow → { questions[2-5], isComplete }
  → User answers all questions in UI
  → POST /api/answers { sessionId, answers[] }
  → Public: persist + async assessment trigger
  → POST /v1/reflection/assessment { story, questions, answers }
  → Core: assessment workflow (bias catalog shortlist) → { biases[], reflectionPrompt }
  → User views ResultsView; future "play in AI chat" uses same assessment payload client-side
```

Core is **stateless**; "whole picture" = story + full Q&A arrays in one assessment request.

---

## Alternatives considered

| Topic | Rejected | Why |
|-------|----------|-----|
| NestJS | Heavier framework | Two routes; Fastify + modules sufficient |
| All 200 biases in prompt | Context noise | Catalog + shortlist + future RAG |
| YAML-first contracts | Drift from runtime | Zod validates at runtime; OpenAPI generated |
| RAG in MVP | Constitution YAGNI | Tier 3; catalog file seeds future embeddings |
