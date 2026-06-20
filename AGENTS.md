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

This project contains **two separate git repositories** in sibling directories:

```
/home/dl/_prog/biassemble/          ← NOT a git repo (workspace container only)
├── biassemble/                     ← App repo (BE + FE), has its own .git
│   ├── backend/
│   ├── frontend/
│   └── AGENTS.md
│
└── biassemble-core/                ← Core repo (private), has its own .git  ← YOU ARE HERE
    ├── src/
    └── AGENTS.md
```

- The parent `/home/dl/_prog/biassemble/` is **not** a git repository — it's a workspace container.
- `biassemble/biassemble/` is the **app repo** (backend + frontend). Run git commands from `/home/dl/_prog/biassemble/biassemble/`.
- `biassemble/biassemble-core/` is the **core repo** (private AI logic). Run git commands from `/home/dl/_prog/biassemble/biassemble-core/`.
- Each repo has its own branch, commits, and PRs. They are independent.

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
