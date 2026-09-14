# Implementation Plan: Shareable Assessment Permalink

**Branch**: TBD | **Date**: 2026-09-09 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/019-assessment-permalink/spec.md`

## Summary

Add a durable, unguessable share address for a completed run and a read path that serves the whole
assessment from Postgres. Everything the response needs is already persisted — this is an address
plus a reader, not new storage.

Spans three repositories, because the browser has never called this service directly.

## Technical Context

**Language/Version**: TypeScript 5.x strict, matching the repo.

**Primary Dependencies**: Fastify, drizzle-orm, Zod. No new dependencies.

**Storage**: Postgres (Supabase). `grounnel_runs.text` already holds the submitted article
([schema.ts:316](../../src/db/schema.ts#L316)); `grounnel_claims` holds every verdict, reason,
confidence, `source_excerpt` and `sources`. One new column — the share token — plus its index.

**Testing**: Orchestration/control flow only per CLAUDE.md's coverage cap: token generation,
unknown-token handling, and the internal-id-is-not-a-share-id rule. No LLM-behaviour tests; this
feature makes no model calls.

**Target Platform**: Vercel (Fastify service).

**Project Type**: Web service, consumed through a separate application backend.

**Constraints**:

- Every existing Grounnel route sits behind `authHook` —
  [routes/grounnel.ts:44](../../src/routes/grounnel.ts#L44) and
  [:109](../../src/routes/grounnel.ts#L109). This is the first unauthenticated read, so it must be
  narrow: one token, one assessment, nothing else.
- `GET /status/:id` is Redis-backed with `AUDIT_TTL_SECONDS = 7 days`
  ([grounnel-store.ts:10](../../src/persistence/grounnel-store.ts#L10)). It cannot serve this
  feature — links must outlive a week, which is precisely what FR-005 requires.
- The Redis status payload does not carry the submitted article text; the frontend supplies it from
  its own state today. Postgres is therefore the only viable source for FR-007.

**Scale/Scope**: One column, one route, one proxy route, one page. ~236 production runs and 3,262
claims currently exist and would all become addressable.

## Constitution Check

*GATE.*

`.specify/memory/constitution.md` is an unfilled template — every principle is a `[PLACEHOLDER]`,
never ratified, so there is no constitutional gate to evaluate. The governing rules are CLAUDE.md and
AGENTS.md. The ones that bear here:

| Rule | Bearing |
|---|---|
| Coverage cap — no tests to raise the number; control flow only | Scopes the test work above |
| Comments ≤ ~200 chars, rationale in the spec | Token generation and the read route |
| `try/catch`, never `await ….catch()` (AGENTS.md 11) | The read path |
| No silent failures | FR-010's not-found behaviour must be explicit, not an empty 200 |
| One-line commit messages, no AI attribution | Every task |

## Repositories affected

This is the part worth reading before estimating.

| repo | change | why |
|---|---|---|
| **biassemble-core** | `share_token` column + index; `GET /assessment/:token` reading Postgres | The data lives here |
| **biassemble/backend** | proxy route `api/grounnel/assessment/[token]` | The browser has never called core directly; core is key-gated and stays that way |
| **biassemble/frontend** | `/check/:token` page; surface the link when a run completes | Where a person actually sees it |

The proxy is not optional. Exposing core directly to browsers would mean either shipping its API key
to the client or opening CORS on a service that has none — both worse than one passthrough route.

## Key design decisions

### The token is a credential, so it must not be the run id

`run_id` is an application-generated v4 that already appears in logs, eval scripts, Redis keys,
telemetry queries and ad-hoc debugging. Making it the public address would turn every one of those
into a disclosure. A separate cryptographically-random `share_token` keeps the two identities apart
and makes FR-003 enforceable rather than aspirational.

### Generated at run creation, not on demand

Assigning the token when the run row is created (FR-001) means the link exists before the result
does, so the frontend can show "your link" immediately and the page can poll it. A token minted only
on completion would leave in-flight runs unaddressable — and in-flight runs are exactly the ones a
user is most likely to navigate away from.

### Not-found must not confirm existence

FR-010: an unknown token and a token for a deleted run return the same response. Distinguishing them
turns the endpoint into an oracle for whether a given run exists.

### No indexing

Assumption in the spec, mechanism here: the shared page carries `noindex`, and the read route sets a
matching header. Links are meant to be passed between people, not surfaced in search results for
documents that may name private individuals.

### Scope boundary against 018

018's FINDINGS.md holds the measured problems — entity collisions, unbounded payloads, wall-clock
overruns, coverage boundaries. **None of them are prerequisites here.** This feature makes existing
results reachable; it does not change what those results say. Shipping it does mean the known
defects become linkable and quotable, which is an argument for fixing them, not for delaying this.

## Project Structure

### Documentation (this feature)

```text
specs/019-assessment-permalink/
├── spec.md
├── plan.md
├── tasks.md
└── checklists/
    └── requirements.md
```

Matching 015/016/017 — no `research.md`, `data-model.md` or `contracts/`. Nothing here needs
research; every open question was settled against the schema and the running system.

### Source code (biassemble-core)

```text
src/
├── db/
│   ├── schema.ts              # + share_token column, unique index
│   └── migrations/            # + drizzle migration
├── routes/
│   └── grounnel.ts            # + GET /assessment/:token, outside authHook
├── persistence/
│   └── history-store.ts       # + readAssessmentByToken
└── contracts/
    └── grounnel.schemas.ts    # + SharedAssessmentSchema
```

## Sequencing

| step | contents |
|---|---|
| 1 | Column, index, migration, token generation on run creation |
| 2 | Durable read + contract |
| 3 | Route, unauthenticated, with not-found and noindex behaviour |
| 4 | Backend proxy |
| 5 | Frontend page and link surfacing |

Steps 1–3 are core and independently verifiable with curl. Steps 4–5 belong to the site repo and are
tracked in its spec 004.

## Out of scope

Revocation or deletion of an individual link; expiring links; per-viewer access control; editing a
shared assessment; anything in 018's findings.
