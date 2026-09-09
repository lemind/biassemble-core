---
description: "Task list for the shareable assessment permalink — share token, durable read, unauthenticated route. Frontend and proxy tracked in the site repo's spec 004."
---

# Tasks: Shareable Assessment Permalink

**Input**: [spec.md](./spec.md), [plan.md](./plan.md).

**Prerequisites**: none. The submitted text and all claim results are already persisted.

**Tests**: control flow only per CLAUDE.md's coverage cap — token generation, unknown-token
handling, and the internal-id-is-not-a-share-id rule. No LLM-behaviour tests; this feature makes no
model calls.

**Scope**: this file covers **biassemble-core only**. The proxy route and the page live in the site
repo — see `biassemble/specs/004-grounnel-public-site/tasks.md`.

## Format: `[ID] [P?] Description`

- **[P]**: can run in parallel (different files, no dependencies)

---

## Phase 1: Address

- [ ] T001 Add `share_token` to `grounnel_runs` in `src/db/schema.ts` — not null, unique index.
  **Not `run_id`**: that value already appears in logs, eval scripts, Redis keys and telemetry
  queries, so reusing it as the public address makes every one of those a disclosure (FR-002/FR-003).
- [ ] T002 Drizzle migration for the column and index. Existing rows need a backfill — 236 production
  runs and ~2,900 eval runs currently have none.
- [ ] T003 Generate the token at run creation in `extract.service.ts`, alongside the existing
  `runId`. URL-safe random, **≥128 bits** — e.g. 16+ bytes from `crypto.randomBytes` base64url'd.
  (`crypto.randomUUID()` is v4 with ~122 bits of entropy, so it is not *guessable*; it is simply not
  URL-pretty and reads like an internal id. The bar is entropy plus visual distinctness from
  `run_id`, not a claim that v4 is weak.) Assigning it at creation rather than completion means an
  in-flight run is already addressable (FR-001).

  **Random, not derived.** Do not hash `run_id` into the token — a hash of a known input is
  recoverable by anyone holding `run_id`, which defeats FR-003 exactly as reusing `run_id` would.
  Fresh entropy per run, stored, never computed.

## Phase 2: Read

- [ ] T004 `readAssessmentByToken` in the history store — one query joining `grounnel_runs` and
  `grounnel_claims`. Returns the submitted text (`grounnel_runs.text`), status, and every claim with
  verdict, reason, confidence, `source_excerpt` and `sources` (FR-007/FR-008).
- [ ] T005 `SharedAssessmentSchema` in `src/contracts/grounnel.schemas.ts`. **Must not carry**
  `run_id`, `session_id`, or operational telemetry (FR-009). This is a public shape — design it as
  one, not as a dump of the row.
- [ ] T006 Handle the incomplete cases: a run that failed, is still verifying, or produced no
  claims renders what exists and states its status rather than looking complete (FR-011). Not `[P]`
  — this is behaviour of the reader and route in T004/T007, not a separate file.

  The shared page must key on the run's **`status`**, not only on `verdict === null` — those are
  different states, and the site's T015 fix handles the second. Same UX, two sources.

## Phase 3: Route

- [ ] T007 `GET /assessment/:token` in `src/routes/grounnel.ts`, **outside `authHook`**. This is the
  first unauthenticated route on this service — keep it narrow: one token in, one assessment out,
  no list, no search, no filters.
- [ ] T008 Unknown token and deleted run return the **same** response (FR-010). Distinguishing them
  makes the endpoint an oracle for whether a run exists.
- [ ] T009 [P] `X-Robots-Tag: noindex` on the response. These documents may name private
  individuals; links are for passing between people, not for search results.
- [ ] T010 [P] Tests in the existing suite — token generated on creation, unknown token refused,
  a `run_id` supplied as a token is refused, response shape carries no internal identifiers.

## Phase 4: Verify

- [ ] T011 curl an assessment for a run older than the 7-day Redis TTL and confirm it renders in
  full from Postgres (SC-001). Pick one of the August runs.
- [ ] T012 Confirm a `run_id` used in the token position is refused (SC-003).

---

## Dependencies

- T001 → T002 → T003. The column exists before anything writes it.
- T004 → T005 → T007. The reader exists before the route that exposes it.
- T007 → the site repo's proxy task, which cannot be written before the route it proxies.

## Cross-repo

Ordering: **019 T007 must exist before** the site's T022 proxy can be written, and the site's
T020/T021 must address runs by `share_token`, never `run_id` (FR-003). The shared page reuses the
site's T014/T015 verdict-wording branches — a shared assessment renders the same claims and has the
same "Supporting sources" / null-verdict defects if those are not fixed first.

| repo | work | tracked in |
|---|---|---|
| biassemble-core | this file | here |
| biassemble/backend | proxy route `api/grounnel/assessment/[token]` | site spec 004 |
| biassemble/frontend | `/check/:token` page, surface the link on completion | site spec 004 |

The proxy is required, not optional: core stays key-gated for everything else, and exposing it
directly to browsers would mean shipping its API key to the client or opening CORS on a service that
has none.

## Out of scope

Revoking or deleting a link; expiry; per-viewer access control; editing a shared assessment.
Everything in [018 FINDINGS.md](../018-assessment-integrity-and-guardrails/FINDINGS.md) — entity
collisions, unbounded payloads, wall-clock overruns — remains parked. None of it blocks this, though
shipping this does make those known defects linkable and quotable.
