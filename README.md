# Biassemble AI Core

Private AI orchestration service for the Biassemble public app. **Prompts, provider config, and API keys live here** — never in the public repository.

## Architecture

```
Public App → Public API (Next.js) → AI Core (Fastify) → Gemini API
                         ↑              ↑
                   session state     stateless, prompts,
                   Inngest jobs      provider keys
```

## Repositories

| Repo | Purpose |
|------|---------|
| `github.com/lemind/biassemble` | Public: UI (Vite) + orchestration (Next.js) |
| `github.com/lemind/biassemble-core` | Private: AI service (this repo) |

## MVP — Feature 001: Reflection Core

MVP delivers 2 HTTP endpoints consumed by the public backend:

| Endpoint | When | What |
|----------|------|------|
| `POST /v1/reflection/question` | User submits story (sync) | Returns 2–5 contextual follow-up questions |
| `POST /v1/reflection/assessment` | User answers all questions (async) | Returns bias assessment + reflection prompt |

### Key design decisions

- **Stateless** — no DB; session owned by public app
- **Fastify** standalone (not merged into Next.js)
- **~30 curated Tier-A biases** (not 200); expand only when evaluations justify it
- **Repair pipeline** — malformed JSON → repair → revalidate → fallback → fail
- **Provider abstraction** — Gemini Flash for MVP, `CompletionOptions` interface
- **x-request-id** tracing on every request + log line
- **Prompt registry** with directory-based structure (`system.md`, `examples.md`, `schema.md`)
- **No OpenAPI generation** in MVP — Zod contracts are sufficient

## Tech stack

- **Runtime**: Node 22 LTS, TypeScript 5.x strict
- **Framework**: Fastify 5
- **AI**: `@google/generative-ai` (Gemini Flash)
- **Validation**: Zod 4
- **Logging**: Pino
- **Testing**: Vitest

## Quick start

```bash
pnpm install
cp .env.example .env
# edit .env with your GEMINI_API_KEY
pnpm dev
```

Then verify:

```bash
curl http://localhost:3001/health
# → {"status":"ok"}