# Biassemble AI Core — HTTP API (private)

Implemented in the **biassemble-core** private repository. Consumed by the public `biassemble` backend when `AI_CLIENT_MODE=core`.

## Authentication

```http
Authorization: Bearer <AI_CORE_API_KEY>
```

## POST /v1/reflection/question

Generate the next follow-up question.

**Request body**

```json
{
  "sessionId": "uuid",
  "story": "string (50-3000 chars)",
  "previousQuestions": ["optional"],
  "previousAnswers": ["optional"]
}
```

**Response** (`200`, JSON)

```json
{
  "question": "string",
  "isComplete": false
}
```

## POST /v1/reflection/assessment

Generate exactly two cognitive biases plus reflection prompt.

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

Must return **exactly 2** biases (matches public `assessmentOutputSchema`).

## Errors

| Status | Meaning |
|--------|---------|
| 400 | Invalid input |
| 401 | Bad API key |
| 502 | Provider failure (public backend may retry per FR-007) |

## Implementation notes (private repo only)

- Prompt registry, model choice (Gemini Flash, Claude, etc.), and provider keys live here.
- Public repo validates responses with Zod; do not duplicate prompt text in public code.
