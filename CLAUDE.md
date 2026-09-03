<!-- SPECKIT START -->
**Active plan**: feature 014 — VERIFY negated-claim polarity. A true claim was returned
`contradicted` on live run `9a784003` (Cardinal Rule violation). Two increments: escalation may
retract a contradiction (containment), then a VERIFY prompt fix (correctness).

- specs/014-verify-negated-claim-polarity/plan.md — implementation plan
- specs/014-verify-negated-claim-polarity/tasks.md — task breakdown

Feature 013 (Grounnel D032 remediation — T27 contentless-claim eligibility, T31 `subject_entity`
disable) is merged; the `subject_entity` disable was reverted 2026-09-03 (D030 §3m Addendum 7) and
the gate is live again. Feature 012 (Grounnel ordinal gate + claim eligibility + g17 subject-entity fix)
is implemented and live-verified. The ADR is the authoritative record — read it before changing
this area:

- docs/decisions/030-grounnel-claim-eligibility-and-reason-grounded-ordinal-gate.md
- specs/012-grounnel-ordinal-eligibility-gates/spec.md — original feature specification
- specs/012-grounnel-ordinal-eligibility-gates/tasks.md — execution log

(plan.md/research.md/data-model.md/quickstart.md were pre-implementation planning scaffolding,
removed once superseded by the ADR and the shipped code/tests.)

Prior plan (008-b2b, audit mode) remains at specs/008-b2b/ if still relevant to work in progress there.
<!-- SPECKIT END -->

## Conventions

**Commit messages**: one line, `feat|fix|chore|docs(T0XX): <short desc>`. `docs` may omit `(T0XX)` when the commit spans multiple tasks or isn't task-scoped (e.g. an ADR-only update). Never commit without explicit user request.

**PR descriptions**: plain human language, no code identifiers, file paths, line numbers, or test/finding counts. Describe what changed for a person reading it, not what changed in the diff.

**Code comments**: max ~200 chars per comment. State what/why in one line; point to the decision doc (`docs/decisions/0NN-*.md` §X) for rationale, incident history, or design tradeoffs — never restate them inline. If a comment needs more than one line to justify itself, that justification belongs in the ADR, not the code.

**Test coverage ceiling (2026-08-10)**: **~60% repo-wide statement coverage is the max to aim for right now — not a floor, a cap.** Token savings beats chasing coverage %. Don't write a new test just to move the number up. Existing tests stay as-is (no pruning), but going forward: default to NOT adding a test — only add one when the bug is in orchestration control flow itself (retry-loop termination, batch splitting, rate-limit handling), not prompt/LLM behavior.

Why 60 and not higher: this codebase already has two regression signals stronger than a unit test for LLM/orchestration-shaped bugs — the 6-gate deterministic chain (`gates.ts`) and the live golden-set eval + `grounnel_gate_events`/`grounnel_llm_calls` telemetry (what actually caught g05/g11/the Emu War finding, not a unit test written in advance). Real coverage as of this note (`npx vitest run --coverage`, `@vitest/coverage-v8`): repo-wide 37% (dragged down by the compiled build artifact `api/index.js`, CLI eval scripts, process entrypoints `server.ts`/`dev.ts`, and DB passthrough wrappers `db/queries.ts` that aren't meant to be unit-tested), but Grounnel's core orchestration (`src/orchestrators/grounnel/`) already sits at ~97% statement/92% branch from 945 tests total. Adding a new hand-crafted `pipeline-service.test.ts` case per future live-eval finding pays token cost to duplicate what the golden set already proves — use a live golden-set re-run to verify LLM-behavior fixes instead. `gates.ts` (pure, zero LLM cost) is the one place still worth keeping exhaustive.
