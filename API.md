# Biassemble AI Core — HTTP API (private)

Implemented in the **biassemble-core** private repository. Consumed by the public `biassemble` backend when `AI_CLIENT_MODE=core`.

## Authentication

```http
Authorization: Bearer <AI_CORE_API_KEY>
```

## POST /v1/reflection/question

Generate a batch of contextual follow-up questions from the user's story (returned all at once).

**Request body**

```json
{
  "sessionId": "uuid",
  "story": "string (50-3000 chars)"
}
```

**Response** (`200`, JSON)

```json
{
  "questions": ["string", "string"],
  "isComplete": false
}
```

Must return **2–5** questions (`questions` array length inclusive). Matches public `questionOutputSchema` (`QUESTIONS_MIN=2`, `QUESTIONS_MAX=5`).

## POST /v1/reflection/assessment

Generate cognitive bias analysis plus reflection prompt.

**Request body**

```json
{
  "sessionId": "uuid",
  "story": "string",
  "questions": ["string"],
  "answers": ["string"]
}
```

**Response** (`200`, JSON)

```json
{
  "biases": [
    {
      "name": "string",
      "explanation": "string",
      "storyConnection": "string",
      "alternativePerspective": "string"
    }
  ],
  "reflectionPrompt": "string"
}
```

Must return **at least 1** bias; no upper limit (model decides how many are relevant). Matches public `assessmentOutputSchema`.

## Errors

| Status | Meaning |
|--------|---------|
| 400 | Invalid input |
| 401 | Bad API key |
| 502 | Provider failure (public backend may retry per FR-007) |

## Implementation notes (private repo only)

- Prompt registry, model choice (Gemini Flash, Claude, etc.), and provider keys live here.
- Public repo validates responses with Zod; do not duplicate prompt text in public code.
