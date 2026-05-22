# Reflection API contracts

| File | Role |
|------|------|
| `../data-model.md` | Entity field rules |
| Repo root `API.md` | Short integration doc for public backend devs |

**Source of truth**: `src/contracts/reflection.schemas.ts` (Zod — created in Phase 1 implementation).

**No OpenAPI generation in MVP** — Zod contracts are sufficient. If OpenAPI/Swagger docs are needed later, generate from Zod schemas via `zod-to-openapi`.

**Public consumer**: `biassemble/backend/src/lib/ai/contracts.ts` — must match schemas here until `@biassemble/ai-contracts` package ships.