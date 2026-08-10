<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan:
specs/008-b2b/plan.md

Supporting artifacts:
- specs/008-b2b/spec.md — feature specification (3 user stories, 21 functional requirements)
- specs/008-b2b/research.md — technical decisions: retrieval stub, ID strategy, prompt registry reuse, numeric fact shape, score computation, VERIFY batching, injection hard-stop
- specs/008-b2b/data-model.md — new `audit` pg schema entities: Audit, Claim, Verdict, SourcePassage, ScoreSummary
- specs/008-b2b/contracts/audit-endpoint.md — POST /audit request/result contract
- specs/008-b2b/quickstart.md — golden-set validation commands, pass bars, "done" definition
- docs/decisions/018-audit-mode-flag.md — ADR (authoritative decision record)
<!-- SPECKIT END -->

## Conventions

**Commit messages**: one line, `feat|fix|chore|docs(T0XX): <short desc>`. `docs` may omit `(T0XX)` when the commit spans multiple tasks or isn't task-scoped (e.g. an ADR-only update). Never commit without explicit user request.

**Code comments**: max ~200 chars per comment. State what/why in one line; point to the decision doc (`docs/decisions/0NN-*.md` §X) for rationale, incident history, or design tradeoffs — never restate them inline. If a comment needs more than one line to justify itself, that justification belongs in the ADR, not the code.

**Test coverage ceiling (2026-08-10)**: **~60% repo-wide statement coverage is the max to aim for right now — not a floor, a cap.** Token savings beats chasing coverage %. Don't write a new test just to move the number up. Existing tests stay as-is (no pruning), but going forward: default to NOT adding a test — only add one when the bug is in orchestration control flow itself (retry-loop termination, batch splitting, rate-limit handling), not prompt/LLM behavior.

Why 60 and not higher: this codebase already has two regression signals stronger than a unit test for LLM/orchestration-shaped bugs — the 6-gate deterministic chain (`gates.ts`) and the live golden-set eval + `grounnel_gate_events`/`grounnel_llm_calls` telemetry (what actually caught g05/g11/the Emu War finding, not a unit test written in advance). Real coverage as of this note (`npx vitest run --coverage`, `@vitest/coverage-v8`): repo-wide 37% (dragged down by the compiled build artifact `api/index.js`, CLI eval scripts, process entrypoints `server.ts`/`dev.ts`, and DB passthrough wrappers `db/queries.ts` that aren't meant to be unit-tested), but Grounnel's core orchestration (`src/orchestrators/grounnel/`) already sits at ~97% statement/92% branch from 945 tests total. Adding a new hand-crafted `pipeline-service.test.ts` case per future live-eval finding pays token cost to duplicate what the golden set already proves — use a live golden-set re-run to verify LLM-behavior fixes instead. `gates.ts` (pure, zero LLM cost) is the one place still worth keeping exhaustive.
