# AGENTS.md — Biassemble Core (private)

## Philosophy

- **AI must re-read this file at the start of every session.**
- Prefer KISS over DRY.
- Duplication is acceptable if abstraction harms readability.
- Avoid abstractions before the third real use case.
- Prefer boring, maintainable solutions.
- Explicit code over clever code.
- Measure before optimizing. Prefer profiling and instrumentation over assumptions.

## Communication

- Ask clarifying questions before acting on ambiguous requirements.
- State assumptions explicitly when information is missing.
- Propose concrete next steps, not general suggestions.

## Security & Privacy

- Never commit secrets, tokens, or `.env` contents.
- Mask credentials in logs; use parameterized queries only.
- Flag hardcoded paths, IPs, or emails before committing.

## Code Style & Consistency

- Follow project linter/formatter rules (ESLint, Prettier, etc.).
- Do not disable linters or skip formatting to "fix" a bug.
- Match existing naming conventions; do not rename variables without scope.
- **Naming**: Use descriptive names that make purpose obvious (`loadAssessment`, `pollSessionStatus`, `stopPolling`). Avoid generic names like `fetch`, `data`, `result`, `check`, `cleanup`, `doStuff`. Don't over-verbose — `updateAnswer` is good, `updateCurrentAnswerTextInState` is not.

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

## Git & Version Control

- Commit atomically: one logical change per commit.
- **Single-line commit messages only.** No multi-line bodies. Example: `feat: add retry logic` — not `feat: add retry logic to syncQueue with exponential backoff and timeout`.
- Never force-push or rewrite history without explicit approval.
- **Git repo location**: The `.git` directory is at `biassemble-core/`. Run `git` commands from `/home/dl/_prog/biassemble/biassemble-core/`.

### Commit Convention

Format: `<tag>(<scope>): <short description>`

Tags:
- `feat:` — new feature
- `fix:` — bug fix
- `review:` — addressing PR/code review feedback
- `chore:` — tooling, config, deps, CI
- `docs:` — documentation only
- `test:` — adding/fixing tests
- `refactor:` — code change with zero behavior change
- `perf:` — performance improvement

Scope (optional): task ID if applicable, e.g. `T102`, `T1b3`

Examples:
- `feat(T102): add computeSystemMetrics function`
- `fix: correct schemaParseRate null on empty input`
- `review: drop traceType, add sessions comment`
- `chore: add drizzle config for core schema`

## Architecture

- API routes must stay thin.
- Business logic belongs in `services/`.
- Never place prompts inside route handlers.
- Avoid framework lock-in where practical.
- Prefer existing platform/framework capabilities before adding libraries.
- **Constants**: Keep configuration constants in the file where they're used. Do not create a shared `constants.ts` prematurely. Extract only when a constant is used across 3+ modules.
- **README**: Keep README as project-level information only (what, why, architecture, tech stack, quick start). Do not put process tracking, phase status, or task progress in README — that belongs in `specs/<feature>/tasks.md` and `specs/<feature>/plan.md`.
- **Environment**: Always verify `.env` loading works before committing. Use `node --env-file=.env` (built into Node 22+) instead of relying on runtime libraries like `dotenv`. The `dev` and `start` scripts must include `--env-file=.env`.
- Database migrations must be reversible and reviewed before applying (no `:latest` in production without testing rollback).
- Do not add product-specific architecture, paths, or constraints here — those belong in `specs/<feature>/plan.md` and `architecture.md`.

## AI Rules

- Use structured JSON outputs only.
- Validate all AI outputs through Zod.
- Prefer cheaper models first.
- Keep prompts centralized and versionable.

## Error Handling & Validation

- Validate at boundaries (API, DB, external services).
- Wrap third-party calls in try/catch with structured error tags.
- Never `catch` and ignore; always log context or rethrow.
- Use TypeScript contracts internally for type safety.

## Testing

- Match test type to change: unit for logic, integration for APIs/DB, e2e for user flows.
- Run relevant tests iteratively; run full suite before finalizing.
- Mock external services; never skip tests due to flakiness without documenting why.

## Spec-kit & `specs/` (keep in sync)

After **any** change that affects behavior, scope, architecture, stack, file layout, env vars, or delivery status, update the matching artifacts under `specs/` for the active feature (see `.specify/feature.json` → `feature_directory`, e.g. `specs/001-reflection-flow/`).

| Change type | Update |
|-------------|--------|
| Product scope, user flows, acceptance criteria | `spec.md` |
| Tech stack, folder structure, phases, constraints | `plan.md`, `architecture.md` |
| Task status, new work items, path corrections | `tasks.md` |
| Spec quality / readiness gates | `checklists/*.md` |

**Rules**

- Do not leave code and specs diverged: if you change the implementation, update the spec docs in the same PR/commit series (or explicitly note why deferral is safe).
- When `plan.md` structure or paths change, propagate to `tasks.md` (exact file paths, phase names, checkpoints).
- When `spec.md` requirements change, check whether `plan.md` phases and `tasks.md` still cover them; add or adjust tasks if not.
- Mark completed work in `tasks.md` (`[x]`) and reflect current status in root `README.md` when deployability or phase milestones shift.
- `spec.md` stays technology-agnostic where possible; stack and paths belong in `plan.md` / `tasks.md`, not in functional requirements.
- **This is the private repo** — prompts, model IDs, provider keys live here. Never commit `.env` files. Use `src/lib/env.ts` for env validation.
- Keep `.env.example` updated but never include real keys.

**Trigger examples** (docs update required): new `frontend/` or `backend/` package, API route added/renamed, env var moved server-side, phase completed, MVP scope narrowed or expanded.

## Task Tracking

- **Source of truth**: `specs/<feature>/tasks.md` — this is the only place task status is tracked.
- **When you complete a task**: Open `tasks.md`, change `- [ ]` to `- [x]` for that task ID, and commit the change.
- **Do not maintain a separate checklist** in your internal state or in tool parameters. The file is the record.
- **If you notice a task is already done** (e.g., file exists, tests pass), mark it `[x]` in `tasks.md` — don't leave it stale.

## Workflow

- Implement incrementally.
- Verify after every meaningful change (smoke test + relevant tests).
- Do not rewrite unrelated files.
- Preserve existing architecture unless explicitly requested.
- Treat spec/plan/tasks updates as part of the change, not a follow-up chore.

## Plan Compliance

- **Follow the plan strictly.** Do not add features, heuristics, code, files, or logic that are not specified in `specs/<feature>/tasks.md` and `specs/<feature>/plan.md`.
- If something seems missing from the plan, ask before adding it.
- If you think a heuristic or enhancement would be valuable, document it in `specs/<feature>/possible-enhancements.md` — do not implement it.
- Mark tasks as `[x]` in `tasks.md` only when the implementation matches the task description exactly.
- **Chronological ordering in tasks.md**: Add new sub-phases to the **end** of the current phase, not in the middle. Sub-phase letters (`4a`, `4b`, `4c`, `4d`) must reflect actual completion order, not planned order. If you add work after other sub-phases were already completed, give it the next letter in sequence.
- **Do not modify spec.md, plan.md, or tasks.md after implementation has started** unless adding corrections or clarifications. If a task turns out to be unnecessary, mark it as `[SKIPPED]` with a reason — do not rewrite the task description.
- **Interdependent tasks that cannot be shipped separately MUST be merged.** If tasks A and B break each other when deployed independently, they are one task, not two. Gating rules in `tasks.md` are not a substitute for merging.

## Autonomy

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
- Committing code — show summary of changes first, ask user to review before running `git commit`
- Adding any code, heuristic, or file not explicitly listed in `tasks.md`

## Forbidden

- Do not create documentation files that are not explicitly listed in plan.md or tasks.md. The spec/plan/tasks files are the source of truth.
- Premature abstractions.
- Global state unless justified.
- Silent failures.
- Hidden magic behavior.
- Microservices.
- Premature RAG/vector DB.
- Force-pushing or history rewriting.
- Committing secrets or `.env` files.
- Adding new dependencies (npm/pip/uv) without explicit approval and justification in PR.
