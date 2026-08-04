---
description: "Task list for the Grounnel API surface — POST /extract + GET /status/:id"
---

# Tasks: Grounnel API Surface

**Input**: `specs/009-grounnel/spec.md`, `plan.md`, `initial-context.md` (SPEC-GROUNNEL v10), `docs/decisions/019-grounnel-pipeline-trust-boundary.md`, `docs/decisions/020-grounnel-routes-through-biassemble-backend.md`. Generated via the `spec-driven-development` skill's Phase 3, using `planning-and-task-breakdown` as the canonical task-sizing/dependency mechanics (per `spec-driven-development`'s own deferral to it).

**Tests**: Included — matches this repo's convention (`docs/testing-philosophy.md`, `specs/008-b2b/tasks.md`'s precedent). Gate logic in particular gets unit tests as pure functions, per D019 §2's whole premise that these are deterministic code, not model calls.

**Organization**: Phases follow `plan.md` §2's implementation order, not perceived importance — the gates/filters phase is scheduled early because it has zero infra dependencies and is the most novel logic (plan.md §2 step 4's own rationale), not because it's "foundational" in the schema sense 008-b2b's phases were.

**Placed at** `specs/009-grounnel/tasks.md`, matching `specs/008-b2b/tasks.md`'s convention — same reasoning as `plan.md`'s header: no generic `/build`-style command here expects `tasks/todo.md`, and this repo already has an established per-spec location.

## Format: `[ID] [P?] Description`

- **[P]**: Can run in parallel (different files, no dependency on another incomplete task in this list)
- Task IDs are local to this spec (`T001`–`T016`), following `specs/008-b2b/tasks.md`'s own numbering precedent, not a repo-global sequence — matches how numbering already varies per spec across this repo's `specs/*/tasks.md`.
- Commit convention: `feat(T0XX): <short desc>` per `AGENTS.md` — one line, no multi-paragraph bodies.

## Path Conventions

Single project, `src/`/`tests/` at this repo's root, following `plan.md` §1's project structure — new `src/orchestrators/grounnel/`, `src/providers/search/`, parallel to the existing `src/orchestrators/audit/` layout. One task (T013) touches a different repo (`biassemble/backend`) — called out explicitly where it appears, per D020 §5's requirement that this not be silently dropped.

## Out of scope for this task list — Grounnel's frontend

This tasks.md covers the **API surface only**, matching spec.md's own stated scope ("only what's buildable in this repo"). T013 reaches into `biassemble/backend` because that proxy is a direct, required consequence of D020's architecture decision made *in this spec* (auth, contract shape). Grounnel's actual frontend — paste box, submit → `POST /extract`, the 10s poll loop, claim-span highlighting/recoloring, the score header, the click-through evidence panel (v10 §2, §6, §8) — is real, sizable, separate work with its own tech stack and repo (`biassemble/frontend`, per this conversation's earlier decision), and none of it has a spec, plan, Tech Stack, or Testing Strategy behind it yet. Deliberately **not** added as a Phase 8 here: doing so would mean inventing tasks without a spec backing them, the exact discipline this whole spec→plan→tasks chain has maintained. Tracked as: **needs its own `spec-driven-development` pass (spec.md → plan.md → tasks.md) in `biassemble/frontend` before any FE task exists** — named explicitly here, per the same "don't let it silently drop" reasoning D020 §5 applied to session/auth scope.

---

## Prerequisites (before Phase 1 — external, not engineering work)

- [ ] **T001** Confirm Tavily's real response shape with one manual, non-mocked API call against a real Tavily key (plan.md §2 step 0; §3's risk-table entry). **Not implementation work** — an API-key-provisioning/manual-call step, kept out of "Phase 1: Setup" so the critical path doesn't visually start with engineering that's actually blocked on an external account.
  - **Acceptance:** a real `search()` response and a real `fetch()`-equivalent response are captured (saved as a fixture or pasted into this task's notes), and T008's interface is checked against them, not against documentation alone.
  - **Verify:** manual — no test to write yet, this is the prerequisite that makes T008's tests meaningful.
  - **Dependencies:** None. Directly blocks only T008 (per plan.md §4 — not a blocker for T002 or the Phase 2 gate tasks) — but T008 is on this list's longest chain (T001 → T008 → T010 → T012 → T013 → T014–T016), so this is the actual root of the critical path, not a low-stakes side item. **If a Tavily key isn't provisioned yet, this is the single thing to unblock first** — every task from T008 onward is stalled behind it even though only one task names it as a direct dependency.
  - **Files:** None (or a scratch fixture under `tests/mocks/` if the captured response is worth keeping as a fixture for T008's tests).
  - **Size:** XS — not code, an external/manual step.

---

## Phase 1: Setup

- [ ] **T002 [P]** Define Zod contracts in `src/contracts/grounnel.schemas.ts` — `ExtractRequestSchema`, `StatusResponseSchema`, claim/score shapes, matching spec.md's response shape and v10 §3b field-for-field (plan.md §2 step 1)
  - **Acceptance:** every field in v10 §3b's example response (`status`, `progress`, `claims[]`, `score`, `caps_hit`) has a corresponding Zod field with the correct nullability (`field: Type | null`, never `field?: Type | null` — AGENTS.md rule 9).
  - **Verify:** `pnpm typecheck` passes with the new file imported nowhere yet (dead code is fine here, a type error is not — plan.md §5's first checkpoint).
  - **Dependencies:** None.
  - **Files:** `src/contracts/grounnel.schemas.ts`.
  - **Size:** S — 1 file.

---

## Phase 2: The trust boundary — gates and filters (D019 §2)

**Purpose**: The four gates named in D019 §2, split into four independent tasks rather than one bundled task — each is a pure function, fully unit-testable with zero mocking, and none depends on Phase 1's contracts existing yet in any load-bearing way. This is plan.md §2 step 4, deliberately un-bundled here: bundling "gates.ts + opinion-filter.ts + passage-filter.ts" into one task would touch 3 implementation files + 3 test files in a single task, past this repo's ~5-file guideline, and would violate `planning-and-task-breakdown`'s "two independent subsystems in one task" red flag — gate #1 (evidence substring matching) and gate #3 (opinion classification) share no logic.

**Checkpoint after this phase**: full unit coverage on all four, including T006's deliberate known-failing case, before Phase 3 starts (plan.md §5).

- [ ] **T003 [P]** Gate #1 — contradiction evidence gate: if `verdict: contradicted`, verify `evidence` is a non-empty substring (or close match) of the passage actually sent to VERIFY; force-downgrade to `unsupported` on failure (spec.md §4a gate #1, D019 §2 table)
  - **Acceptance:** a `contradicted` verdict with fabricated/absent evidence is downgraded to `unsupported`; a `contradicted` verdict with evidence that's a real substring passes through unchanged. **"Close match" defined, not left open:** exact substring after whitespace/punctuation normalization only — never fuzzy or semantic matching, which would reintroduce model-shaped judgment into a gate whose entire point is a deterministic string check (D019 §2).
  - **Verify:** `pnpm test:run tests/unit/orchestrators/grounnel/gates.test.ts`.
  - **Dependencies:** None.
  - **Files:** `src/orchestrators/grounnel/gates.ts` (gate #1 portion), `tests/unit/orchestrators/grounnel/gates.test.ts`.
  - **Size:** S — 1 file + its test.

- [ ] **T004 [P]** Gate #2 — numeric normalization/comparison in code, ported from the proven B2B reconcilers where the shape matches (spec.md §4a gate #2, D018 §5, D019 §2 table — "near-direct port," plan.md §3's risk-table entry)
  - **Acceptance:** an inverted/wrong-scale/wrong-period numeric comparison is caught deterministically, not left to model reasoning; at minimum the equal/inverted/wrong-scale cases from D018 §5's existing test fixtures have Grounnel-side equivalents. **Scope note, stated explicitly rather than assumed:** D018's fixtures are row/period-scoped table extractions; D019 §1 already predicts this reconciler "fires less often" on unstructured web prose. The port is expected to cover the *comparison arithmetic* (equal/inverted/wrong-scale decision logic) fully, not the *row/table-matching* machinery D018 §5's later addenda built for tabular filings — web prose has no rows to match. If a case only makes sense against a table, it's out of scope for this task, not silently dropped; note it here rather than porting table logic that has nothing to match against.
  - **Verify:** `pnpm test:run tests/unit/orchestrators/grounnel/gates.test.ts` (same file as T003, separate `describe` block — same file is acceptable since it's the same "gates.ts" module named in plan.md, unlike opinion/passage filters which are already separate files).
  - **Dependencies:** None (reuses D018 code by import, doesn't wait on any Grounnel task).
  - **Files:** `src/orchestrators/grounnel/gates.ts` (gate #2 portion), same test file as T003.
  - **Size:** S — same file as T003, additive.

- [ ] **T005 [P]** Gate #3 — pre-search opinion/non-factual filter, rule-based first (spec.md §4a gate #3)
  - **Acceptance:** a claim with no checkable referent (value judgment, prediction, vague intensifier) routes to `unverifiable` **without a `SearchProvider` call being made** — this "zero search calls" behavior is the actual acceptance bar, not just the correct verdict (spec.md Success Criteria).
  - **Verify:** `pnpm test:run tests/unit/orchestrators/grounnel/opinion-filter.test.ts`, asserting a mock `SearchProvider` is never invoked for a filtered claim.
  - **Dependencies:** None.
  - **Files:** `src/orchestrators/grounnel/opinion-filter.ts`, `tests/unit/orchestrators/grounnel/opinion-filter.test.ts`.
  - **Size:** S — 1 file + its test.

- [ ] **T006 [P]** Gate #4 — passage relevance pre-filter, lexical-presence only, known coreference gap named not hidden (spec.md §4a gate #4, D019 §2)
  - **Acceptance:** a passage missing the claim's key entities/numbers is dropped before VERIFY; the coreference/pronoun case (D019 §2's Bukowski example) is captured as `test.todo("passage filter drops valid pronoun-only evidence — D019 §2, no fix designed yet")` — visible in every run's summary as a named, tracked gap, not a permanently-red test that trains people to ignore CI failures.
  - **Verify:** `pnpm test:run tests/unit/orchestrators/grounnel/passage-filter.test.ts` — suite is fully green; the `.todo()` case shows as pending in vitest's output, never as passing or failing, so it can't silently start "passing" from an unrelated change without someone deliberately promoting it to a real test first.
  - **Dependencies:** None.
  - **Files:** `src/orchestrators/grounnel/passage-filter.ts`, `tests/unit/orchestrators/grounnel/passage-filter.test.ts`.
  - **Size:** S — 1 file + its test.

---

## Phase 3: Infrastructure — state and search

- [ ] **T007 [P]** `GrounnelStore` — Redis hash-per-audit persistence: `createAudit`, `writeClaimResult`, `getStatus` (`HSET`/`HGETALL`, D019 §4)
  - **Acceptance:** concurrent `writeClaimResult` calls for the same audit never overwrite one another — both land (plan.md §3's risk-table entry; the read-modify-write hazard this avoids is D019 §4's design rationale, not a separate implementation-level checklist item here); `@upstash/redis` is the only new persistence dependency this task (or any other in this list) introduces — no `pg`/`postgres`/Drizzle import anywhere under `src/orchestrators/grounnel/` or `src/persistence/grounnel-store.ts` (spec.md Success Criteria: "No Postgres dependency anywhere in this surface," D019 §4 — this is the one task where that criterion is actually at risk of being violated, so it's checked here rather than left to the closing checkpoint alone).
  - **Verify:** `pnpm test:run tests/unit/persistence/grounnel-store.test.ts`, including the concurrent-write test.
  - **Dependencies:** T002 (types the store against `StatusResponseSchema`'s shape).
  - **Files:** `src/persistence/grounnel-store.ts`, `tests/unit/persistence/grounnel-store.test.ts`.
  - **Size:** S/M — 1 file + test, new `@upstash/redis` dependency (spec.md Boundaries — ask first).

- [ ] **T008** `SearchProvider` interface + Tavily implementation (plan.md §2 step 2, D019 §2 "provider abstraction scope")
  - **Acceptance:** the interface (`search(query)`, `fetch(url)`) is defined before `tavily-provider.ts` implements it, checked against T001's real captured response, not guessed.
  - **Verify:** `pnpm test:run tests/unit/providers/search/tavily-provider.test.ts`, using T001's captured fixture.
  - **Dependencies:** T001 (real response shape), T002 (contracts).
  - **Files:** `src/providers/search/search-provider.ts`, `src/providers/search/tavily-provider.ts`, test file.
  - **Size:** M — 2 implementation files + test, new Tavily-calling dependency (spec.md Boundaries — ask first).

**Checkpoint**: `pnpm typecheck` clean, all Phase 2 + Phase 3 unit tests green (except T006's deliberate known-failure), before Phase 4 starts.

---

## Phase 4: Orchestration

- [ ] **T009** `extract.service.ts` — EXTRACT call + gate #3, writes initial claim list via `GrounnelStore` (plan.md §2 step 5)
  - **Acceptance:** claim list is written to Redis and the function returns **before** the caller needs to wait on any search/verify work — this is what makes T012's `202` response synchronous-EXTRACT, not fire-and-forget (spec.md Success Criteria).
  - **Verify:** `pnpm test:run tests/unit/orchestrators/grounnel/extract-service.test.ts`, `MockProvider` standing in for Gemini.
  - **Dependencies:** T002, T005, T007.
  - **Files:** `src/orchestrators/grounnel/extract.service.ts`, test file.
  - **Size:** S/M.

- [ ] **T010** `pipeline.service.ts` — per-claim loop: `SearchProvider` → fetch → gate #4 → VERIFY (batched 5-10) → gates #1/#2 → `GrounnelStore` write (plan.md §2 step 6)
  - **Acceptance:**
    - A failed VERIFY batch marks its claims `not_checked` and the run continues (spec.md Success Criteria, v10 §5/§13).
    - A `contradicted` verdict never reaches the store without having passed T003's gate.
  - **Verify:** `pnpm test:run tests/unit/orchestrators/grounnel/pipeline-service.test.ts` (fakes for `SearchProvider`/`GrounnelStore`), **plus** a manual, real (non-mocked) run against a real Tavily key and a real short pasted article before this is trusted (plan.md §5's step-6 checkpoint — the D019-benchmark-style manual check).
  - **Dependencies:** T003, T004, T006, T007, T008.
  - **Files:** `src/orchestrators/grounnel/pipeline.service.ts`, test file.
  - **Size:** S/M by file count (1 file + test) despite the wide dependency list — wiring, not new logic.

- [ ] **T011 [P]** `rate-limit.ts` — IP-based limiter in front of `/extract`, now defense-in-depth behind `authHook` rather than the primary control (plan.md §2 step 7, D020 §4)
  - **Acceptance:** requests exceeding the configured per-IP limit get a 429; the limit itself is a named constant in one file, not scattered inline (plan.md §3's mitigation) — exact number is an open question (spec.md), not decided by this task.
  - **Verify:** `pnpm test:run tests/unit/lib/rate-limit.test.ts`.
  - **Dependencies:** T002.
  - **Files:** `src/lib/rate-limit.ts`, test file.
  - **Size:** S.

---

## Phase 5: Wiring

- [ ] **T012** `routes/grounnel.ts` — `registerGrounnelRoutes`, wiring `POST /extract` (with `authHook` as `preHandler`, D020 §3) and `GET /status/:id` (plan.md §2 step 8)
  - **Acceptance:** an unauthenticated `POST /extract` returns 401; a valid request returns `202 { id }` with the claim list already in Redis (T009's guarantee, surfaced at the route level); `GET /status/:id` returns the full shape every call, no delta logic.
  - **Verify:** `pnpm test:run` on the new integration tests (Phase 6, T014–T016) — this task isn't independently verifiable without them.
  - **Dependencies:** T009, T010, T011.
  - **Files:** `src/routes/grounnel.ts`, `src/server.ts` (route registration).
  - **Size:** S/M.

---

## Phase 6: Cross-repo proxy (`biassemble/backend` — different repo, D020)

- [ ] **T013** `core-client.ts` gains `extractClaims`/`getGrounnelStatus`, mirroring `generateQuestion`/`generateAssessment`; two new Next.js route files forward request/response (plan.md §2 step 8.5, D020 §3)
  - **Acceptance:** `AI_CORE_API_KEY` is attached server-side exactly as the existing two calls do; no new session/user schema, no Inngest wiring added (D020 §5's explicit "Do not"); this repo's `/extract` contract (T012) is stable before this task starts.
  - **Verify:** manual real end-to-end call through the proxy to this repo, confirming the added-hop latency against v10 §3b's 10-second polling assumption (plan.md §5's step-8.5 checkpoint — resolves D020 §6's "not yet measured").
  - **Dependencies:** T012 (this repo's contract must be stable first — this is *why* it's sequenced after, not before).
  - **Files:** (different repo) `biassemble/backend/src/lib/ai/core-client.ts`, two new route files under `biassemble/backend/src/app/api/grounnel/`.
  - **Size:** M — 3 files, different repo, named here so it isn't silently dropped (D020 §5).

---

## Phase 7: Integration tests

- [ ] **T014 [P]** `tests/integration/grounnel-extract.test.ts` — full `POST /extract` contract, including the 401-on-missing-auth case (D020 §3)
  - **Dependencies:** T012.
  - **Size:** S.

- [ ] **T015 [P]** `tests/integration/grounnel-status.test.ts` — full `GET /status/:id` contract shape, `not_checked` on a forced batch failure, `caps_hit` on an exceeded cap
  - **Dependencies:** T012.
  - **Size:** S.

- [ ] **T016 [P]** `tests/integration/grounnel-rate-limit.test.ts` — 429 on exceeding the configured limit
  - **Dependencies:** T011, T012.
  - **Size:** XS/S.

**Checkpoint — before calling P0 done**: every Success Criterion in `spec.md` checked off explicitly, not inferred from "tests pass" — `caps_hit`, `not_checked` denominator handling, and the rate-limit 429 in particular are easy to have green tests for while still being wrong in a way tests didn't cover (plan.md §5's closing note). Explicitly re-verify the two criteria with no dedicated test in this list: **"No Postgres dependency anywhere in this surface"** (T007's acceptance checks it locally at introduction time; re-confirm with one `grep -r "postgres\|drizzle" src/orchestrators/grounnel src/persistence/grounnel-store.ts` across the whole surface before sign-off, not just T007's own files) and **"No session/user schema added to `biassemble/backend`"** (T013's acceptance, `biassemble/backend`'s own schema file unchanged).
