# Reflection API contracts

| File | Role |
|------|------|
| `reflection-api.openapi.yaml` | Human/Swagger contract; sync with Zod at build time |
| `../data-model.md` | Entity field rules |
| Repo root `API.md` | Short integration doc for public backend devs |

**Implementation source of truth**: `src/contracts/reflection.schemas.ts` (created in implementation phase).

**Public consumer**: `biassemble/backend/src/lib/ai/contracts.ts` — must match schemas here until `@biassemble/ai-contracts` package ships.
