# AGENTS.md — Biassemble Core

## Commands

```bash
pnpm dev              # Start dev server with hot reload
pnpm build            # Build for production
pnpm test             # Run tests (watch mode)
pnpm test:run         # Run tests once
pnpm typecheck        # TypeScript type checking
pnpm eval             # Run mock evaluation (no API cost)
pnpm eval --provider real  # Run real evaluation (uses Gemini)
pnpm db:generate      # Generate Drizzle migrations
pnpm db:migrate       # Apply migrations
pnpm db:studio        # Open Drizzle Studio
```

## Current State
- Active stage: check specs/ for current stage and phase
- Known issues: gemini-2.0-flash deprecated — use gemini-2.5-flash
- Real eval runs: none yet, MockProvider only

## Repository Structure

This project contains **three separate git repositories** in sibling directories (found stale here before — this used to list only two; `biassemble-engine` was missing entirely):

```
/home/dl/_prog/biassemble/          ← NOT a git repo (workspace container only)
├── biassemble/                     ← App repo (BE + FE), has its own .git
│   ├── backend/                    → Vercel project "biassemble-be"
│   ├── frontend/                   → separate Vercel project
│   └── AGENTS.md
│
├── biassemble-core/                ← Core repo (private), has its own .git  ← YOU ARE HERE
│   ├── src/                        → Vercel project "biassemble-core"
│   └── AGENTS.md
│
└── biassemble-engine/              ← RAG sidecar repo (Python, pure retriever — no LLM calls), has its own .git
    └── AGENTS.md                   → Hugging Face Space
```

- The parent `/home/dl/_prog/biassemble/` is **not** a git repository — it's a workspace container.
- `biassemble/biassemble/` is the **app repo** (backend + frontend). Run git commands from `/home/dl/_prog/biassemble/biassemble/`.
- `biassemble/biassemble-core/` is the **core repo** (private AI logic). Run git commands from `/home/dl/_prog/biassemble/biassemble-core/`.
- `biassemble/biassemble-engine/` is the **RAG sidecar** (vector search + a local LLM over the bias catalog, called by this repo, never the reverse). Run git commands from `/home/dl/_prog/biassemble/biassemble-engine/`.
- Each repo has its own branch, commits, and PRs. They are independent. Dependency direction: `biassemble` (app backend) → `biassemble-core` (this repo) → `biassemble-engine` → `pgvector`. Never reversed.

### Shared secrets — keep in sync across deploy targets

A mismatch here fails silently as `401`, not a build error — verified the hard way (2026-07-22): rotating `AI_CORE_API_KEY` in this repo's Vercel env without also updating the app-backend repo's copy broke every backend→core call with no build failure, no alert, until someone hit the live app.

| Secret | Lives in this repo's `.env`/Vercel env | Must match | Lives in |
|---|---|---|---|
| `AI_CORE_API_KEY` | ✓ (this repo IS the core service being authenticated to) | ⟷ | `biassemble/backend`'s `AI_CORE_API_KEY` (Vercel project `biassemble-be`) |
| `RAG_API_KEY` | ✓ (this repo calls `biassemble-engine` with it) | ⟷ | `biassemble-engine`'s HF Space Secret `RAG_API_KEY` |
| `RAG_ENGINE_URL` | ✓ | must point at | `biassemble-engine`'s actual deployed HF Space URL |
| `RAG_HF_TOKEN` | ✓ | — | only needed if `biassemble-engine`'s `LLM_MODEL_REPO` points at a private HF repo |

If you rotate any of these, update **both** sides in the same sitting, then verify with a real call through the *other* repo (e.g. the backend's own proxy endpoint, or a real `/retrieve-biases` call) — a call to this repo alone won't prove the other side's copy is still valid.

## Critical Rules

1. **Integration is mandatory** — When creating a function, plan WHERE it gets called. "Created the function" ≠ "implemented the feature".
2. **Use proper types** — Never use `any` or inline union literals when named types exist in `persistence/types.ts` or `contracts/`.
3. **Fire-and-forget for observability** — `recordLlmCall()` failures must never break the main flow. Wrap in try/catch.
4. **Test behavior, not schema** — Test that `TimeoutError` maps to `status="timeout"`, not just that the field can be stored.
5. **Validate at boundaries** — API, DB, external services. Never trust input.
6. **Single-line commits** — `feat: add retry logic`, not multi-line bodies.
7. **Check existing migrations** — Before generating new ones, verify `src/db/migrations/` doesn't already have the table.
8. **Spec alignment** — Don't carry assumptions from previous stages. Each stage has its own scope.
9. **Nullable semantics** — Use `field: Type | null` for nullable DB columns, not `field?: Type | null`.
10. **Scope discipline** — Do only what was explicitly asked. Everything else is out of scope.
11. **Error handling style** — Use `try/catch` blocks, not `await ... .catch()`. Prefer explicit control flow over chained error handlers.
12. **Prefer LLM judgment over regex for semantic/contextual checks** — Regex only catches phrasings already seen; anything requiring "does this text mean X" (not just "does it match a fixed pattern") should be a small LLM classifier call instead, not a growing pile of patterns. Two real incidents: (a) the injection-guard's `\byou\s+are\s+now\b` regex, meant to catch prompt-injection attempts like "you are now a different assistant," false-positived on a scraped webpage's "You are now subscribed" newsletter boilerplate quoted verbatim as VERIFY evidence — degraded a whole batch of otherwise-correct verdicts (2026-08-09, fixed by excluding verbatim-quote fields from the scan, see `injection-guard.ts`'s `quotedFields`). (b) D025 (Grounnel)'s reconciliation-pass gate originally tried extracting numeric/date facts via regex (`extractNumericFact`) to catch reason/verdict mismatches, and had to be replaced with a batched LLM classifier mid-implementation — the regex approach couldn't generalize past the one category (currency/percent) it happened to be written for, and the real motivating bug was a date mismatch it never covered. Regex stays fine for genuinely closed, enumerable formats (a currency pattern, a UUID, a fixed date shape) — not for "is this suspicious" or "does this reasoning support that verdict."

## Integration Requirement

When implementing a new cross-cutting function (persistence, observability, validation):

- [ ] Identify all call sites (grep for where it should be invoked)
- [ ] Thread required parameters through the call chain
- [ ] Document architectural ownership constraints (e.g., "only X should call Y")
- [ ] Add tests verifying the integration works end-to-end
- [ ] Update `docs/integration-map.md` with the new function and its call sites

See `docs/integration-map.md` for the current mapping of cross-cutting functions to their call sites.

## Git Convention

Format: `<tag>(<scope>): <short description>`

Tags: `feat:`, `fix:`, `review:`, `chore:`, `docs:`, `test:`, `refactor:`, `perf:`

Examples:
- `feat(T102): add computeSystemMetrics function`
- `fix: correct schemaParseRate null on empty input`
- `chore: add drizzle config for core schema`

**Single-line commit messages only.** No multi-line bodies.

## Code Comments

Max ~200 chars per comment. State what/why in one line; point to the relevant ADR (`docs/decisions/0NN-*.md` §X) for rationale, incident history, or design tradeoffs — never restate them inline. If a comment needs more than one line to justify itself, that justification belongs in the ADR, not the code.

## When To Ask

### Act without asking:
- Fix typos, lint errors, or obvious bugs
- Add missing error handling or null checks
- Improve tests within the same module
- Refactor ≤1 file with zero behavior change

### Ask before acting:
- Changes affecting >3 files or >2 services
- Modifying configs, CI/CD, or deployment scripts
- Adding/removing dependencies or changing versions
- Altering public APIs, DB schemas, or auth flows
- Committing code — show summary first
- **Any work beyond the explicitly stated task**

## Testing

Match test type to change: unit for logic, integration for APIs/DB, e2e for user flows. Mock external services. See `docs/testing-philosophy.md` for full testing principles and criteria.

## Skills

Load these skill files when working on related tasks:

- `.skills/drizzle-migrations.md` — Migration safety rules, NOT NULL column handling
- `.skills/llm-pipeline.md` — Provider interface, recordLlmCall usage, repair pipeline
- `.skills/eval-pipeline.md` — Golden/no_bias datasets, eval commands, thresholds
- `.skills/inngest-jobs.md` — Job definitions, async patterns, real provider usage
- `.skills/zod-contracts.md` — Validation rules, branded types, nullable semantics

## Docs

- `docs/decisions/` — ADRs: architectural decisions with rationale (read before changing architecture)
- `docs/integration-map.md` — Ownership rules for cross-cutting functions
- `docs/testing-philosophy.md` — Full behavioral testing principles
- `docs/system-state.md` — Known issues, eval status, active stage

## Forbidden

- Premature abstractions
- Global state unless justified
- Silent failures
- Hidden magic behavior
- Microservices
- Force-pushing or history rewriting
- Committing secrets or `.env` files
- Adding new dependencies without explicit approval
- Creating documentation files not listed in plan.md or tasks.md
