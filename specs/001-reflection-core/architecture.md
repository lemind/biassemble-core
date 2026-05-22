# Architecture: Biassemble AI Core (private)

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)

## System context

```text
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│ Vite frontend   │────▶│ biassemble/backend   │────▶│ biassemble-core │
│ (public)        │     │ Next.js API          │     │ Fastify (Vercel)│
└─────────────────┘     │ sessions DB          │     │ prompts/catalog │
                        │ core-client / mock   │     │ Gemini API      │
                        └──────────────────────┘     └─────────────────┘
```

- **Dependency rule**: Public → Core → LLM. Never Core → public DB/types.
- **Secrets**: Provider keys and prompts only in Core.

## Repository layout (MVP)

```text
biassemble-core/
├── src/
│   ├── server.ts                 # Fastify entry (Vercel)
│   ├── routes/
│   │   └── reflection.ts         # POST /v1/reflection/*
│   ├── orchestrators/
│   │   ├── retry.ts
│   │   └── reflection/
│   │       ├── question.workflow.ts
│   │       └── assessment.workflow.ts
│   ├── providers/
│   │   ├── types.ts
│   │   └── gemini.ts
│   ├── prompts/
│   │   ├── registry.ts
│   │   ├── guardrails.md
│   │   └── reflection/
│   │       ├── question-batch.v1.md
│   │       └── assessment.v1.md
│   ├── parsers/
│   │   └── json-from-llm.ts
│   ├── contracts/
│   │   └── reflection.schemas.ts
│   ├── catalog/
│   │   └── bias-catalog.ts       # loads datasets/biases/taxonomy.v1.json
│   └── lib/
│       ├── auth.ts               # Bearer AI_CORE_API_KEY
│       └── env.ts
├── datasets/
│   └── biases/
│       └── taxonomy.v1.json      # ~200 entries (seed; tier-a/b/c)
├── evaluations/
│   └── golden/reflection/
├── openapi/
│   └── reflection-api.yaml       # generated from Zod
├── contracts/                    # spec-kit contract docs (see specs/.../contracts/)
├── tests/
│   ├── unit/
│   ├── integration/
│   └── contract/
├── scripts/
│   ├── generate-openapi.ts
│   └── eval-reflection.ts
└── specs/001-reflection-core/
```

## AI workflows

### Question workflow

```text
POST /v1/reflection/question
  → auth middleware
  → Zod parse body
  → question.workflow.run()
       → promptRegistry.render("question-batch@1.0.0", { story })
       → provider.completeJson(schema: QuestionOutput)
       → parsers.extractJson + Zod safeParse
       → retry up to 3 on parse/provider errors
  → 200 | 400 | 401 | 502
```

### Assessment workflow

```text
POST /v1/reflection/assessment
  → auth + Zod
  → assert questions.length === answers.length
  → assessment.workflow.run()
       → biasCatalog.getShortlistForPrompt()  # tier-a + categories
       → promptRegistry.render("assessment@1.0.0", { story, qaPairs, biasShortlist, biasCategories })
       → provider.completeJson(schema: AssessmentOutput)
       → parse + Zod + optional name normalization (Tier 2)
  → 200 | 400 | 401 | 502
```

## Bias catalog strategy (200 biases)

```text
taxonomy.v1.json (200 rows)
        │
        ├─► MVP prompt: categories + tier-a shortlist (~25–40 names)
        │
        ├─► Tier 2: fuzzy normalize output name → catalog id
        │
        └─► Tier 3: embed definitions → RAG top-k → inject into assessment prompt
```

## Contract & types

| Artifact | Role |
|----------|------|
| `src/contracts/reflection.schemas.ts` | Runtime Zod (source of truth) |
| `openapi/reflection-api.yaml` | Generated Swagger for humans / public CI |
| Public `biassemble/backend/.../contracts.ts` | Consumer copy until `@biassemble/ai-contracts` package |

## Deployment

| Component | Target |
|-----------|--------|
| biassemble-core | Vercel project B — Fastify `src/server.ts` |
| biassemble backend | Vercel project A — existing Next |
| Env | `AI_CORE_BASE_URL` points A → B |

## Tier roadmap (in-repo)

| Tier | When | Adds |
|------|------|------|
| 1 | This feature | Workflows, Zod, Gemini, golden eval, catalog file |
| 2 | Follow-up tasks | Provider bench, prompt versions, confidence, pino dashboards |
| 3 | New spec | RAG, embeddings, fine-tune |
