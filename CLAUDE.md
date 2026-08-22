<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan:
specs/012-grounnel-ordinal-eligibility-gates/plan.md

Supporting artifacts:
- specs/012-grounnel-ordinal-eligibility-gates/spec.md — feature specification (2 user stories, 10 functional requirements)
- specs/012-grounnel-ordinal-eligibility-gates/research.md — technical decisions: reason-grounded (not evidence-grounded) ordinal extraction, claim-anchored attachment over a global whitelist, no generic fact-gate abstraction yet, LLM classifier additive to the existing regex opinion filter
- specs/012-grounnel-ordinal-eligibility-gates/data-model.md — applyReasonOrdinalGate input/result shape + validation matrix, classifyClaimVerifiability result shape + policy, 4-file persistence union-type extension (deferred until wired in)
- specs/012-grounnel-ordinal-eligibility-gates/quickstart.md — build order, validation commands, live re-verification steps, "done" definition
- docs/decisions/030-grounnel-claim-eligibility-and-reason-grounded-ordinal-gate.md — ADR (authoritative decision record)

Prior plan (008-b2b, audit mode) remains at specs/008-b2b/ if still relevant to work in progress there.
<!-- SPECKIT END -->

## Conventions

**Commit messages**: one line, `feat|fix|chore|docs(T0XX): <short desc>`. `docs` may omit `(T0XX)` when the commit spans multiple tasks or isn't task-scoped (e.g. an ADR-only update). Never commit without explicit user request.

**PR descriptions**: plain human language, no code identifiers, file paths, line numbers, or test/finding counts. Describe what changed for a person reading it, not what changed in the diff.

**Code comments**: max ~200 chars per comment. State what/why in one line; point to the decision doc (`docs/decisions/0NN-*.md` §X) for rationale, incident history, or design tradeoffs — never restate them inline. If a comment needs more than one line to justify itself, that justification belongs in the ADR, not the code.

**Test coverage ceiling (2026-08-10)**: **~60% repo-wide statement coverage is the max to aim for right now — not a floor, a cap.** Token savings beats chasing coverage %. Don't write a new test just to move the number up. Existing tests stay as-is (no pruning), but going forward: default to NOT adding a test — only add one when the bug is in orchestration control flow itself (retry-loop termination, batch splitting, rate-limit handling), not prompt/LLM behavior.

Why 60 and not higher: this codebase already has two regression signals stronger than a unit test for LLM/orchestration-shaped bugs — the 6-gate deterministic chain (`gates.ts`) and the live golden-set eval + `grounnel_gate_events`/`grounnel_llm_calls` telemetry (what actually caught g05/g11/the Emu War finding, not a unit test written in advance). Real coverage as of this note (`npx vitest run --coverage`, `@vitest/coverage-v8`): repo-wide 37% (dragged down by the compiled build artifact `api/index.js`, CLI eval scripts, process entrypoints `server.ts`/`dev.ts`, and DB passthrough wrappers `db/queries.ts` that aren't meant to be unit-tested), but Grounnel's core orchestration (`src/orchestrators/grounnel/`) already sits at ~97% statement/92% branch from 945 tests total. Adding a new hand-crafted `pipeline-service.test.ts` case per future live-eval finding pays token cost to duplicate what the golden set already proves — use a live golden-set re-run to verify LLM-behavior fixes instead. `gates.ts` (pure, zero LLM cost) is the one place still worth keeping exhaustive.
