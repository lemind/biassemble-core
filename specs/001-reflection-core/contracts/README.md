# Reflection API Contracts — Distribution Strategy

## Source of Truth

**`src/contracts/reflection.schemas.ts`** (Zod) is the SSOT for all reflection API schemas.

## Distribution — Runtime via `GET /v1/contracts`

Instead of a shared npm package, Core serves schemas as JSON at runtime:

| Step | What | Where |
|------|------|-------|
| 1 | Core exposes `GET /v1/contracts` returning JSON descriptions of all Zod schemas | `biassemble-core/src/routes/reflection.ts` |
| 2 | Backend fetches contracts at startup (or first request), caches in memory | `biassemble/backend/src/app/api/contracts/route.ts` |
| 3 | Backend proxies to frontend via `GET /api/contracts` | Same file |
| 4 | Frontend can consume at runtime instead of hardcoded types | Optional |

### What the contracts JSON contains

Field names, types, and min/max constraints. For example:

```json
{
  "reflection": {
    "QuestionOutput": {
      "questions": "string min 1[] min 2 max 5",
      "isComplete": "boolean"
    }
  }
}
```

### What it does NOT reveal

- AI prompts, model IDs, API keys
- Business logic, orchestration, DB schema
- Bias catalog or taxonomy

This is safe to share publicly — a competitor could infer the same shapes from frontend API calls.

## Public backend manual sync

Until runtime contract fetching is mature, `biassemble/backend/src/lib/ai/contracts.ts` is manually kept in sync with Core's `reflection.schemas.ts`. A diff mismatch warning can be added when `GET /v1/contracts` returns something unexpected.

## Future option

If contract volumes grow, a `@biassemble/ai-contracts` npm package could replace manual sync — but the current approach avoids package overhead.