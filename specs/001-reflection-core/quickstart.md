# Quickstart: biassemble-core (local dev)

**Feature**: `001-reflection-core` | **Branch**: `001-reflection-core`

## Prerequisites

- Node.js 22+
- pnpm (recommended)
- Google AI Studio API key (`GEMINI_API_KEY`)
- Shared secret for public backend (`AI_CORE_API_KEY`)

## Environment

Create `.env` in repo root (see `.env.example` after scaffold):

```bash
AI_CORE_API_KEY=dev-secret-change-me
GEMINI_API_KEY=your-google-ai-studio-key
GEMINI_MODEL=gemini-2.0-flash
PORT=3001
LOG_LEVEL=info
AI_TIMEOUT_MS=10000
AI_MAX_RETRIES=3
```

## Run Core locally

```bash
pnpm install
pnpm dev          # Fastify on PORT (default 3001)
```

## Smoke test (question batch)

```bash
curl -s -X POST http://localhost:3001/v1/reflection/question \
  -H "Authorization: Bearer dev-secret-change-me" \
  -H "Content-Type: application/json" \
  -H "x-request-id: test-001" \
  -d '{
    "sessionId": "00000000-0000-4000-8000-000000000001",
    "story": "I argued with my manager about a deadline. I felt they did not listen and I stopped sharing updates because I assumed they would reject any pushback anyway."
  }' | jq .
```

Expect `questions` array length between 2 and 5.

## Smoke test (assessment)

```bash
curl -s -X POST http://localhost:3001/v1/reflection/assessment \
  -H "Authorization: Bearer dev-secret-change-me" \
  -H "Content-Type: application/json" \
  -H "x-request-id: test-002" \
  -d '{
    "sessionId": "00000000-0000-4000-8000-000000000001",
    "story": "I argued with my manager about a deadline...",
    "questions": ["What did you assume?", "What evidence did you ignore?"],
    "answers": ["That they would reject me.", "I did not ask what constraints they had."]
  }' | jq .
```

Expect `biases` length ≥ 1 and `reflectionPrompt` string.

## Wire public backend

In `biassemble/backend/.env`:

```bash
AI_CLIENT_MODE=core
AI_CORE_BASE_URL=http://localhost:3001
AI_CORE_API_KEY=dev-secret-change-me
```

Run public backend + frontend; complete story → Q&A → results.

## Evaluation

```bash
pnpm eval:reflection    # after scripts/eval-reflection.ts exists
```

Golden cases live in `evaluations/golden/reflection/`.

## Deploy (Vercel)

Separate Vercel project linked to `biassemble-core` repo; set env vars in dashboard; point public `AI_CORE_BASE_URL` to deployment URL.