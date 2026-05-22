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
│   │   ├── retry.ts              # 3× exponential backoff
│   │   └── reflection/
│   │       ├── question.service.ts
│   │       └── assessment.service.ts
│   ├── providers/
│   │   ├── types.ts              # Provider interface + CompletionOptions
│   │   └── gemini.ts
│   ├── prompts/
│   │   ├── registry.ts
│   │   ├── guardrails.md
│   │   └── reflection/
│   │       ├── question-batch/
│   │       │   ├── system.md
│   │       │   ├── examples.md
│   │       │   └── schema.md
│   │       └── assessment/
│   │           ├── system.md
│   │           ├── examples.md
│   │           └── schema.md
│   ├── parsers/
│   │   ├── json-from-llm.ts
│   │   └── repair.ts             # invalid JSON → repair → revalidate → fallback → fail
│   ├── contracts/
│   │   └── reflection.schemas.ts  # Zod source of truth
│   ├── catalog/
│   │   └── bias-catalog.ts       # loads datasets/biases/taxonomy.v1.json
│   ├── lib/
│   │   ├── auth.ts               # Bearer AI_CORE_API_KEY
│   │   ├── env.ts                # Zod-validated env loader
│   │   └── request-id.ts         # x-request-id tracing
│   └── observability/
│       └── logger.ts             # pino structured logs with latency, model, retries
├── datasets/
│   └── biases/
│       └── taxonomy.v1.json      # ~30 Tier-A curated biases
├── evaluations/
│   └── golden/reflection/
├── tests/
│   ├── unit/
│   ├── integration/
│   └── contract/
├── scripts/
│   └── eval-reflection.ts
├── specs/001-reflection-core/
├── .env.example
├── package.json
└── README.md
```

## AI orchestrators

### Question orchestrator

```text
POST /v1/reflection/question
  → request-id middleware
  → auth middleware
  → Zod parse body
  → question.service.run()
       → promptRegistry.render("question-batch", { story })
       → provider.completeJson(schema: QuestionOutput, options: { timeoutMs })
       → parsers.extractJson + Zod safeParse
       → repair pipeline on invalid JSON
       → retry up to 3 on parse/provider errors
  → 200 | 400 | 401 | 502
```

### Assessment orchestrator

```text
POST /v1/reflection/assessment
  → request-id + auth + Zod
  → assert questions.length === answers.length
  → assessment.service.run()
       → biasCatalog.getShortlist()  # all 30 biases
       → promptRegistry.render("assessment", { story, qaPairs, biasShortlist })
       → provider.completeJson(schema: AssessmentOutput)
       → parse + repair + Zod + optional name normalization (Tier 2)
  → 200 | 400 | 401 | 502
```

## Bias catalog strategy (~30 curated Tier-A biases)

```text
taxonomy.v1.json (~30 rows)
        │
        ├─► MVP prompt: inject all 30 names + one-line definitions
        │
        ├─► Tier 2: fuzzy normalize output name → catalog id
        │
        └─► Tier 3: embed definitions → RAG top-k → inject into assessment prompt
```

**No expansion** until evaluations justify it, retrieval exists, and confidence scoring is implemented.

## Contract & types

| Artifact | Role |
|----------|------|
| `src/contracts/reflection.schemas.ts` | Runtime Zod (source of truth) |
| `API.md` (repo root) | Short integration doc for public backend devs |
| Public `biassemble/backend/.../contracts.ts` | Consumer copy until `@biassemble/ai-contracts` package |

**No OpenAPI generation in MVP** — Zod contracts are sufficient.

## Deployment

| Component | Target |
|-----------|--------|
| biassemble-core | Vercel project B — Fastify `src/server.ts` |
| biassemble backend | Vercel project A — existing Next |
| Env | `AI_CORE_BASE_URL` points A → B |

## Tier roadmap (in-repo)

| Tier | When | Adds |
|------|------|------|
| 1 | This feature | Orchestrators, Zod, Gemini, repair pipeline, x-request-id, golden eval, 30-bias catalog |
| 2 | Follow-up tasks | Provider bench, prompt versions, confidence, benchmark scripts |
| 3 | New spec | RAG, embeddings, fine-tune |