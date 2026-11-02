# Research: Grounnel as an MCP Server

**Date**: 2026-11-02 | **Spec**: [spec.md](./spec.md)

Everything here was checked against the code, the published SDK, or a live client before the plan
was written. The throwaway endpoint used for it lives on branch `021-mcp-spike` (commit `e40e396`)
and is not merged.

## R1. Which MCP library

**Decision**: `@modelcontextprotocol/server` 2.4.0 (the SDK's v2 line, published 2026-10-23).

**Why**: v2 implements protocol revision 2026-07-28 and, by default, also serves 2025-era clients
statelessly from the same tool definitions (`createMcpHandler`, `legacy: 'stateless'`). Both eras
come from one factory, so they can't drift apart.

**Rejected**: `@modelcontextprotocol/sdk` 1.32.2. Its latest protocol is 2025-11-25 and it has no
`server/discover`, so it can't satisfy FR-020.

## R2. What real clients send

Measured against the spike on a Vercel preview, with a placeholder key value:

| Client | Protocol | `X-Grounnel-Provider` | `X-Grounnel-Provider-Key` | Called from |
|---|---|---|---|---|
| Claude Code 2.1.191 (VS Code plugin) | 2025-11-25 (legacy) | arrived | arrived | the user's machine |
| Cursor 1.0.0 | 2025-11-25 (legacy) | arrived | arrived | `3.209.66.12`, an AWS address |
| Claude custom connector (desktop/web) | not tested: no account available | — | — | Anthropic's cloud, per their docs |
| Grok via xAI API | not tested | — | — | xAI's cloud |

**Consequences**:
- Every measured client is still on the 2025 protocol. Serving both eras is required, not optional.
- A client can call from a shared cloud address (Cursor did). This confirms FR-014: limit per key,
  not per address.
- Custom headers survive both a local and a cloud-proxied client.

## R3. Running on our stack

**Decision**: mount the SDK's fetch-style handler on one Fastify route in core.

The spike rebuilt a web `Request` from the Fastify request and returned the handler's `Response`.
It worked locally and on Vercel. No new framework, no separate deployment. The handler is built per
request, which matches the stateless model and Vercel's function lifecycle.

## R4. How a check runs without a queue

Already true in the code, no change needed:
- `POST /extract` validates, preflights the own key, runs extraction, replies 202, and then runs
  eligibility and the pipeline inside `waitUntil`, with the provider object (and key) in memory.
- `vercel.json` gives the function `maxDuration: 300`; `AUDIT_MAX_DURATION_MS` budgets 240 s.
- `MAX_CLAIMS = 40` was sized to that budget from measured timing (~6.5 s per claim).
- The stuck-run reaper (`src/jobs/reap-stuck-runs.ts`) settles runs whose container died, as done
  or failed, from what Redis holds.

Extraction itself: p50 0.6–1.7 s, p95 0.9–2.9 s, max 7.5 s across providers (last 30 days of
`grounnel_llm_calls`). A start call answering within 30 s is safe.

## R5. What already exists for the result

- Share-page payload (`SharedAssessmentSchema`): status, text, claims (text, verdict, evidence,
  confidence, reason, sources, citations, status), counts, provider, model, `ownKeyTokens`.
- The cap flag exists as `grounnel_runs.truncated` (and `caps_hit` in the Redis meta). It is not in
  the share payload yet.
- Citations carry `source` label, `sentence` number, `url`, `text`. Titles come from `sources`.
- There is no stored reason for a failed run. FR-017's failure reasons need one (see plan).

## R6. Rate limiting building blocks

`RedisRateLimiter` (Upstash, atomic `incrWithWindow`, fixed window, key prefix parameter) already
backs the site, own-key and shared-link buckets. MCP gets two new prefixes on the same class.

## R7. Things checked and not needed

- **MCP Tasks extension**: optional in 2026-07-28, no measured client advertises it. Not used.
- **OAuth**: out of scope (spec).
- **Fastify adapter package** (`@modelcontextprotocol/fastify`): adds DNS-rebinding helpers for
  localhost servers. Not needed for a public endpoint; Origin validation uses the core package's
  helper.
