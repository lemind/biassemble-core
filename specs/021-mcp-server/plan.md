# Implementation Plan: Grounnel as an MCP Server

**Branch**: `021-mcp-server` | **Date**: 2026-11-02 | **Spec**: [spec.md](./spec.md)

**Input**: [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md),
[contracts/mcp-tools.md](./contracts/mcp-tools.md).

## Summary

One public MCP endpoint on biassemble-core with two tools, `start_fact_check` and
`get_fact_check`. Own key only. The start tool runs the same code path as `POST /extract`
(preflight, extraction, reply, then `waitUntil` for the rest), pulled out into a shared function so
the two can't drift. The read tool returns the share-page payload plus the cap flag. The protocol
layer is the official SDK v2, which serves the 2026-07-28 revision and falls back to the 2025
protocol that every measured client still uses (research R2).

## Technical Context

**Language/Version**: TypeScript, Node 22 (as core today)

**Primary Dependencies**: Fastify 5.8, zod 4.4, `@vercel/functions` (waitUntil), Upstash Redis,
Drizzle. **New**: `@modelcontextprotocol/server` 2.4.0 (research R1).

**Storage**: Postgres (`grounnel.grounnel_runs`, migration 0019), Upstash Redis (limits,
reservations, switch).

**Testing**: vitest, inside the repo's ~60% coverage cap. Unit tests only for control flow: header
and input validation, reservation states, fail-closed limiting, status mapping, error mapping. No new
tests for LLM behaviour. Deployed checks for the SCs.

**Target Platform**: Vercel serverless, the existing `api/index.js` function (`maxDuration: 300`).

**Project Type**: web service (existing).

**Performance Goals**: start answers within 30 s at p95 (extraction p95 is ~3 s, research R4).

**Constraints**: the key lives only in memory (FR-012, FR-018); no job queue for MCP checks; 240 s
pipeline budget inside 300 s.

**Scale/Scope**: 2 tools, 1 route, 1 migration, 1 shared refactor, 1 About-page section (site repo).

## Constitution Check

`.specify/memory/constitution.md` is an unfilled template. The rules that govern this repo are in
`CLAUDE.md`:

| Rule | Bearing |
|---|---|
| One-line commits `feat(021-T21NN): …` | All tasks. IDs `T2101`–`T2199` |
| Comments ≤ ~200 chars, rationale in the ADR | New ADR `docs/decisions/034-mcp-server.md` holds the why |
| No new tests for LLM behaviour | None added; only control-flow tests |
| `gates.ts` exhaustive | Gates untouched |
| No AI attribution | All commits |
| New dependencies need approval | `@modelcontextprotocol/server` is the only one; approved with this plan |

Passes.

## Project Structure

### Documentation (this feature)

```
specs/021-mcp-server/
├── spec.md
├── research.md
├── plan.md
├── data-model.md
├── contracts/mcp-tools.md
└── tasks.md
```

### Source code

```
src/
├── orchestrators/grounnel/
│   └── start-check.ts          NEW  shared start path: decide provider, preflight, extract,
│                                    waitUntil(eligibility + pipeline); used by /extract and MCP
├── mcp/
│   ├── server.ts               NEW  McpServer factory: registers the two tools
│   ├── tools/start.ts          NEW  start_fact_check: headers, input, switch, limit, reservation
│   ├── tools/read.ts           NEW  get_fact_check: read limit, share payload → contract shape
│   ├── errors.ts               NEW  { code, message, retryAfterSeconds } and isError results
│   ├── fingerprint.ts          NEW  HMAC-SHA-256 helpers ("key:", "text:")
│   └── reservation.ts          NEW  SET NX reservation state machine (data-model.md)
├── routes/
│   ├── grounnel.ts             EDIT /extract calls start-check.ts; behaviour unchanged
│   └── mcp.ts                  NEW  POST /mcp (+405 for GET/DELETE): Origin check, Fastify→fetch
│                                    bridge, no authHook
├── db/schema.ts                EDIT entry_point, failure_reason
├── db/migrations/0019_*.sql    NEW
├── persistence/grounnel-store.ts  EDIT entry point on create; failure reason on fail; truncated
│                                    in the share read
├── orchestrators/grounnel/pipeline.service.ts  EDIT record failure_reason when a run fails
├── jobs/reap-stuck-runs.ts     EDIT failure_reason = time_limit when it settles a run as failed
├── jobs/eval-grounnel-run.ts   EDIT entry_point = eval
├── lib/env.ts                  EDIT MCP_HMAC_SECRET
└── server.ts                   EDIT register /mcp, wire MCP limiters
scripts/mcp-starts.ts           NEW  on | off | status for the emergency switch
docs/decisions/034-mcp-server.md  NEW
```

Site repo (`biassemble/frontend`): About page "Use Grounnel from your assistant" section (FR-021).

## Key design decisions

### Who pays

The user's LLM key pays extraction and verification. Search (Gemini grounding and Tavily) stays on
the site keys, as on the website, so every MCP check costs Grounnel its search share (spec "Who
pays"). `startCheck` uses the shared `HybridSearchProvider`; no per-request search provider and no
extra key headers. Our spend is bounded only by the per-key limit and the switch.

### One start path, two doors

`/extract` and `start_fact_check` both call `startCheck({ text, providerDecision, entryPoint })`.
Each door keeps only what differs: the website rate-limits per address and reads the provider
headers leniently (absent means site Gemini); MCP requires both headers, limits per key fingerprint,
reserves request tokens, and maps outcomes to MCP errors. The refactor is behaviour-neutral for
`/extract`; its existing tests are the guard.

### Address

`POST /mcp` on the core deployment, published as `https://mcp.grounnel.n30sk.cc/mcp` (a Vercel
domain on the core project). Users never see `vercel.app`, and the address can move later without
breaking connector configs. `/mcp` sits outside `authHook`, like `/assessment/:token`.

### Protocol and bridging

`createMcpHandler(factory)` with the default `legacy: 'stateless'`. The route rebuilds a web
`Request` from the Fastify request (as the spike did) and copies the `Response` back. Origin: if
present and not on the allow-list, reply 403 before the handler (`originValidationResponse`). GET
and DELETE get 405, per 2026-07-28; legacy clients don't need GET in stateless mode.

### Key never leaves memory

The tool handler reads the two headers with `ctx.http?.req?.headers.get("X-Grounnel-Provider")` and
`ctx.http?.req?.headers.get("X-Grounnel-Provider-Key")` (SDK v2 `ServerContext`; v1's
`extra.requestInfo` no longer exists there). Missing HTTP context counts as missing headers, never
as permission to use a default provider. It builds the provider object and passes it to
`startCheck`. Nothing logs headers: Fastify's logger is off, our logger never receives
the headers object, and SDK errors go through `scrubErrorMessage` before logging. The only derived
value stored anywhere is the key HMAC, as a Redis key name with a one-hour TTL.

### Input validation lives in the handler

The SDK validates arguments against `inputSchema` before calling the handler and turns a failure
into its own generic `isError` result, which can't carry our codes. So the registered input schema
is permissive (`text: string`, `requestToken?: string`), and the handler checks emptiness, the
20,000-character limit and the token pattern itself, returning `empty_text`, `text_too_large` or
`invalid_request_token`.

### Order inside `start_fact_check`

1. Validate headers and input (no Redis, no spend).
2. Switch check: `grounnel:mcp:starts-disabled` → `service_unavailable`.
3. If a request token was given: reserve or answer from the existing reservation (below).
4. Allowance: `ratelimit:mcp-start:{keyHmac}`. Over → release reservation, `rate_limited`.
5. `startCheck(...)`: preflight, then extraction. As soon as the run row exists, `startCheck` calls
   `onRunCreated(shareToken)`, which moves the reservation to `created` with the share token.
   On a failure before that → release the reservation, map the error.
6. Reply with share token and `readAfterSeconds`; the reservation is already `created`.
7. `waitUntil` runs eligibility and the pipeline (inside `startCheck`).

Any Redis error in steps 2–4 → `service_unavailable` (fail closed, FR-014a).

### Reservation lifecycle

A `pending` reservation is a short lease (120 s, longer than a start's p95 with margin) carrying a
random owner id; only that owner may advance or release it. `created` holds the share token for the
full hour. So:
- the process dies before a run exists → the lease expires in 120 s and a retry starts cleanly;
- the process dies after the run exists → the reservation is already `created`, and a retry gets
  that share token (the reaper settles the run itself);
- a retry during a live lease gets `in_progress`.

Rotating `MCP_HMAC_SECRET` changes reservation keys as well as limit buckets, so a retry within an
hour of a rotation can start a second check. Rotation is rare and manual; accepted and noted in the
ADR.

### Read path

`get_fact_check` applies the per-token and global read limits (a Redis error → `service_unavailable`,
fail closed like starts), then calls
`historyStore.readAssessmentByToken` (the share route's own read, extended with `truncated` and
`failure_reason`). It maps `extracting`/`verifying` to `running` + phase, adds `readAfterSeconds`
(10 s while running), and projects claims to the contract shape.

### Failure reasons

Today a failed run carries no reason. The pipeline already classifies provider errors
(`ProviderError` categories, `RateLimitError`); the terminal-failure write gains a mapped
`failure_reason`. The reaper writes `time_limit`. Anything unmapped is `pipeline`.

### Limits

| Bucket | Limit | Window |
|---|---|---|
| MCP start, per key HMAC | 30 | 1 h fixed |
| MCP read, per share token | 360 | 1 h fixed (one check read every 10 s for an hour) |
| MCP read, global | 3000 | 60 s |

Reads are cheap Postgres reads; the global ceiling only protects against floods.

### Text limit

`start_fact_check` refuses text over 20,000 characters as `text_too_large`. A check still covers at
most 40 claims (about 3,000 characters of typical text), so longer text adds cost without adding
claims. The website's limit is unchanged.

## Phases

| Phase | Delivers | Spec stories |
|---|---|---|
| 1. Foundation | ADR, dependency, env, migration 0019, entry point + failure reason written | — |
| 2. Shared start path | `startCheck` extracted; `/extract` unchanged in behaviour | — |
| 3. MCP endpoint | route, both tools, errors, limits, reservation, switch | US1, US2, US3 |
| 4. Release checks | the deployed SC runs, client end-to-end tests, About page | US4 |

## Risks

- **Spend in the release checks.** SC-006a asks for 20 deployed 40-claim runs per provider (60
  runs, plus site-paid search). That is a budget decision, not run by default: T2131 asks for
  approval with a cost estimate first.
- **Client support moves.** Clients may switch to 2026-07-28 at any time; the SDK serves both, and
  T2134 re-checks before launch.
- **Untested cloud clients.** Claude's connector and Grok-via-API weren't measured (research R2).
  Cursor's cloud path worked. Claude is listed as supported only after passing SC-008; without a
  test account before release, the About page lists it as unverified.
- **The bypass token leaked during research.** It is rotated before any further deploy (T2137).
- **The refactor of `/extract`.** It's the live website path. Phase 2 lands alone, with the existing
  route tests passing and a deploy check, before any MCP code.
- **Per-key limits multiply with keys, and each check spends our search money.** Accepted in the
  spec ("Who pays"); the switch (FR-014b) is the stop. Watch site Gemini and Tavily spend after launch.
