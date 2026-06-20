# LLM Pipeline Skill

Load this when working with LLM provider calls, recording, or repair logic.

## Provider Interface

All LLM calls go through `src/providers/types.ts` Provider interface:

```typescript
interface Provider {
  completeJson<T>(input: { system: string; user: string }): Promise<ProviderResponse<T>>;
}

interface ProviderResponse<T> {
  result: T;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}
```

## Recording LLM Calls

Every provider call MUST call `recordLlmCall()`:

- **Primary calls**: `call_type="primary"`
- **Fallback calls**: `call_type="fallback"`
- **Fire-and-forget**: Wrap in try/catch, never propagate errors
- **Token usage**: Captured from `response.usage` (Gemini provides `usageMetadata`)

## Prompt Version

- `prompt_version` is stamped AFTER parsing by the orchestrator
- LLM does NOT produce it
- Throw (not warn) if `prompt_version` missing on any reasoning trace step

## Repair Pipeline

`src/parsers/repair.ts` handles JSON repair:

- **JSON manipulation only** — not an LLM call unless fallback fires
- **Fallback provider**: Only called if repair fails
- **Fallback is a separate LLM call** — gets its own `recordLlmCall()` row with `call_type="fallback"`

## Current Call Sites

See `docs/integration-map.md` for the full mapping.

**Summary:**
- `assessment.service.ts` — 2 calls (primary + fallback)
- `question.service.ts` — 2 calls (primary + fallback)

## Error Handling

- **TimeoutError**: Mapped to `status="timeout"`, `failureType="timeout"`
- **Other errors**: Mapped to `status="error"`, `failureType="provider_error"`
- **Recording failures**: Must not break the main flow (fire-and-forget guarantee)
