---
description: "Task list for serving Grounnel as an MCP server, own key only."
---

# Tasks: Grounnel as an MCP Server

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/mcp-tools.md](./contracts/mcp-tools.md).

## Overview

Two MCP tools on biassemble-core: one starts a fact-check, one reads it. Own key only, sent in the
same two headers the website uses. The start tool runs the website's own start path, shared, so the
key stays in memory and never enters a queue. Limits are per key fingerprint for starts and per
share token for reads. A failed check is a successful read with a reason.

## Format: `[ID] [P?] [Story?] Description`

IDs are `T2101` upward: spec `21` plus the two-digit task. `[P]` can run in parallel with the other
`[P]` tasks of its phase.

---

## Phase 1: Foundation

- [ ] T2101 Write `docs/decisions/034-mcp-server.md`: why two tools and polling, why per-key HMAC
  limits (Claude's and Cursor's cloud addresses, research R2), why no queue, why SDK v2 with the
  2025 fallback, the reservation order, fail-closed limiting, the switch. Code comments point here.
- [ ] T2102 Add `@modelcontextprotocol/server@2.4.0` to core.
- [ ] T2103 Add `MCP_HMAC_SECRET` to `src/lib/env.ts` (optional at boot; the MCP route refuses starts
  without it). Operator: set a 32-byte random value in Vercel Production and Preview, the same in both.
- [ ] T2104 Migration 0019: `grounnel_runs.entry_point` (nullable enum `website|mcp|eval`) and
  `failure_reason` (nullable enum, data-model.md). Update `src/db/schema.ts`. Existing rows stay null.
- [ ] T2105 Pass the entry point into run creation: `website` from `/extract`, `eval` from
  `src/jobs/eval-grounnel-run.ts` and `scripts/eval-grounnel.ts`.
- [ ] T2106 Record `failure_reason` when a run ends failed: map provider error categories and
  `RateLimitError` in the pipeline's terminal-failure write; the reaper writes `time_limit`; anything
  else is `pipeline`. One unit test for the mapping function.
- [ ] T2107 `readAssessmentByToken` also returns `truncated` and `failure_reason`. The share page
  ignores both; the schema gains them as optional.

**Checkpoint**: migration applied; website and eval runs write their entry point; nothing user-facing
changed.

## Phase 2: Shared start path

- [ ] T2108 Extract `startCheck({ text, decision, entryPoint, searchEngine })` into
  `src/orchestrators/grounnel/start-check.ts`: preflight (own key), extraction, then `waitUntil` for
  eligibility and the pipeline. It returns `{ id, shareToken, pendingClaims }` or a typed failure
  (preflight category, rate-limited extraction, extraction failed). `/extract` keeps its rate limit,
  body parsing and HTTP mapping and calls it. Existing `/extract` tests pass unchanged.
- [ ] T2109 Deploy (on explicit order) and run one site check and one own-key check on the website.
  Both finish as before. This lands before any MCP code.

**Checkpoint**: the website path runs through `startCheck` in production.

## Phase 3: MCP endpoint (US1, US2, US3)

- [ ] T2110 [P] `src/mcp/errors.ts`: the `{ code, message, retryAfterSeconds }` shape, the code list
  from the contract, and a helper that builds an `isError: true` tool result with structured content
  plus the same JSON as text.
- [ ] T2111 [P] `src/mcp/fingerprint.ts`: `keyHmac(provider, key)` and `textHmac(text)` with HMAC-SHA-256,
  `"key:"` / `"text:"` prefixes, exact UTF-8 bytes. Unit test: stable output, the two purposes never
  collide, a missing secret throws.
- [ ] T2112 [P] `src/mcp/reservation.ts`: reserve with `SET NX EX 3600`; read; mark done with the
  share token; release on failure. Returns `owner | done(shareToken) | in_progress | conflict`. Unit
  tests with a fake Redis for every transition in data-model.md.
- [ ] T2113 MCP limiters in `src/server.ts`: `RedisRateLimiter` with prefixes `ratelimit:mcp-start`
  (30/h), `ratelimit:mcp-read` (360/h), and a global read bucket (3000/60 s). A wrapper turns any
  Redis error into `service_unavailable` (fail closed). Unit test: a throwing Redis never lets a
  start through.
- [ ] T2114 Emergency switch: read `grounnel:mcp:starts-disabled` at the start of each start call;
  `scripts/mcp-starts.ts on|off|status` sets, clears and shows it.
- [ ] T2115 [US1][US2] `src/mcp/tools/start.ts` in the plan's order: headers (`key_required`,
  `provider_not_chosen`, `unsupported_provider`), input (`empty_text`, `text_too_large` over 20,000
  chars, `invalid_request_token`), switch, reservation, allowance, `startCheck` with entry point
  `mcp`, error mapping, reply with `readAfterSeconds` 15. Unit tests with fakes: validation runs
  before any Redis call; a failed preflight releases the reservation; a duplicate after `done` uses
  no allowance.
- [ ] T2116 [US1] `src/mcp/tools/read.ts`: read limits, `readAssessmentByToken`, `not_found`,
  status/phase mapping, `readAfterSeconds` (10 while running, null at the end), claim projection,
  `failed` returned as a normal result. Unit test for the status mapping.
- [ ] T2117 [US1][US3] `src/mcp/server.ts`: `McpServer` factory registering both tools with the
  contract's input and output schemas (zod), annotations, and descriptions carrying FR-008 and
  FR-013 wording.
- [ ] T2118 `src/routes/mcp.ts`: `POST /mcp` builds a web `Request`, applies the Origin allow-list
  (403), calls `createMcpHandler(factory)` (default stateless legacy fallback), copies the
  `Response` back. GET and DELETE return 405. Registered in `src/server.ts` outside `authHook`.
- [ ] T2119 Key-leak test: drive start through success, wrong key, preflight failure and extraction
  failure with a synthetic key; assert it appears in no captured log line and no tool result.
- [ ] T2120 Operator: add `mcp.grounnel.n30sk.cc` as a domain on the core Vercel project.
- [ ] T2121 Preview deploy. From Claude Code: connect with both headers, check a 3-claim text,
  read it to `done`, open the share link. Fix what breaks.

**Checkpoint**: both tools work end to end on a preview from a real client.

## Phase 4: Release checks and docs (US4)

- [ ] T2122 SC-002: one check read over MCP and on the share page; claims, verdicts and citations
  match.
- [ ] T2123 SC-003: 5 concurrent starts; start latency p95 under 30 s; each check finishes after its
  start returned.
- [ ] T2124 SC-004, SC-005: a wrong key causes no extraction call (`grounnel_llm_calls`) and no
  search; after a full run with a synthetic key, search the database, Vercel logs and stored errors
  for it: nothing.
- [ ] T2125 SC-006: 5 checks with different share tokens through one client, read every 10 s to the
  end; no `rate_limited`.
- [ ] T2126 SC-006b: two simultaneous starts with one request token give one extraction, one run,
  one allowance, one share token.
- [ ] T2127 SC-006c: on a preview pointed at an unreachable Redis, every start is refused with
  `service_unavailable` and no run row appears.
- [ ] T2128 SC-007: produce every start and read error code on purpose.
- [ ] T2129 SC-009: website, MCP and eval runs carry `website`, `mcp`, `eval`; website and MCP are
  `production`.
- [ ] T2130 SC-001: the same 10-claim text, same provider, over MCP and the website; pipeline time
  within 10%.
- [ ] T2131 SC-006a: 40-claim runs per provider. **Ask for spend approval first** with a cost
  estimate (60 runs at full size, plus site-paid search). Record provider, model, function config,
  elapsed time, outcome.
- [ ] T2132 [US4] Site repo: About page section "Use Grounnel from your assistant": address, Claude
  connector steps, Claude Code and Cursor snippets, the data-flow and public-page warnings, the key
  fingerprint note, and keeping keys out of shared config (FR-021).
- [ ] T2133 If the own-key article is published by then, add the one-line MCP fingerprint note
  (FR-021).
- [ ] T2134 SC-008, SC-010: re-test Claude Code and Cursor against the production address with the
  About page instructions; Claude's connector too if an account is available. Re-check which
  protocol each client sends.
- [ ] T2135 Production deploy, on explicit order.
- [ ] T2136 Clean-up: delete branch `021-mcp-spike`; rotate `VERCEL_BYPASS_TOKEN` (exposed during
  the research) in Vercel and `.env`; remove the `grounnel-spike` server from local Claude Code config.

## Dependencies

- Phase 1 before everything. T2104 before T2105–T2107.
- Phase 2 (T2108–T2109) before Phase 3.
- In Phase 3: T2110–T2114 before T2115–T2116; those before T2117; T2117 before T2118; T2118 before
  T2119 and T2121. T2120 any time before T2134.
- Phase 4 after T2121. T2131 needs spend approval. T2135 needs an explicit deploy order.
