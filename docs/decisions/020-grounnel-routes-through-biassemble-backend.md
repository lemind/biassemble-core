# D020 — Grounnel Routes Through `biassemble/backend`: Reversing SPEC-GROUNNEL §3a's "No Intermediary" Call

Amends SPEC-GROUNNEL v10 §3a (`initial-context.md`, frozen as originally written — this ADR is where the correction lives) and, as a consequence, touches §3b's latency assumption and §3c's rate-limiting rationale. Does not touch D019 (§1 pipeline, §2 trust boundary, §3 native-search disqualification, §4 Redis-only state) — all four of those hold unchanged regardless of which HTTP client calls `/extract`.

---

## §1. What §3a originally decided, and why

**Original decision**: Grounnel's frontend calls `biassemble-core`'s `/extract` + `/status/:id` directly, no intermediary. "There is no separate Grounnel backend service... a Grounnel-side proxy would add a network hop that does no actual work."

**Original reasoning, precisely** (worth restating before reversing it): two distinct arguments, not one.
1. Routing through the *existing* `/audit` endpoint specifically would waste a call (`sources: []` just to get EXTRACT's claim list, then a redundant re-run per batch) and couple Grounnel's uptime/latency to B2B's own queue depth and Gemini quota — a shared-capacity concern.
2. Building a *new, dedicated* Grounnel backend service, whose only job would be forwarding requests to `/extract`/`/status/:id` unchanged, adds a hop that does no actual work — nothing about the request or response would differ for having passed through it.

Both arguments were correct as stated. Neither anticipated `biassemble/backend` already existing.

## §2. What changed

Investigated (not assumed) what `biassemble/backend` actually does, prompted by the realization that it already exists and already talks to `biassemble-core`. Findings:

- It holds `AI_CORE_API_KEY` server-side (`core-client.ts:35`) for every existing call to biassemble-core (`/v1/reflection/question`, `/v1/reflection/assessment`) — a secret that structurally cannot live in a browser.
- It owns its own Postgres session DB (`sessions`, `session_data`) and Inngest-based async job orchestration for the reflection product — neither of which Grounnel needs (v10 §1: no login, no accounts; §6a: ephemeral Redis, not persistent session state; async work happens inside biassemble-core's own request/poll handling, no external queue).
- Its documented reason for existing (`biassemble/specs/001-reflection-flow/architecture.md`, "Public app vs private AI Core") is exactly the secret-holding argument above — "Public App → Public API → Private AI Core," where the Public API's entire job is being the thing that's allowed to hold private-side secrets.

**This is the decisive difference from §1's argument 2, not a reason to ignore it.** Argument 2 rejected a hop that does no actual work. A proxy through `biassemble/backend` does real, structurally-necessary work that a direct browser call cannot do at all: holding a Bearer secret. That's not the same proposal §3a rejected, evaluated against the same standard §3a used.

## §3. Decision

Grounnel's frontend (wherever it's ultimately hosted) calls `biassemble/backend`, which proxies to `biassemble-core`'s `/extract` + `/status/:id` as a thin, stateless pass-through — mirroring the existing `generateQuestion`/`generateAssessment` shape in `core-client.ts` exactly (new functions `extractClaims`/`getGrounnelStatus`, same pattern, not a new one). `biassemble-core`'s `/extract` now requires `AI_CORE_API_KEY` via the same `authHook` `/audit` already uses — it is no longer a public, unauthenticated endpoint.

**Does this reintroduce §1's shared-point-of-failure concern? Answered explicitly, not left open**: partially, but the blast radius doesn't transfer. §1's argument 1 concern was about *shared capacity* — Grounnel traffic contending with B2B's own queue/Gemini quota by routing through `/audit`. This proxy does not do that: it calls the dedicated `/extract`/`/status` surface, not `/audit`; `biassemble/backend`'s own Inngest queue is not invoked for Grounnel's flow at all (pass-through, not enqueued); `biassemble-core`'s Redis-tracked pipeline (D019 §1, §4) remains the sole source of truth for audit progress, untouched by this decision. What's added is a real but shallow coupling — `biassemble/backend` being up is now required for `/extract` to succeed — not the shared-orchestration/shared-quota coupling §1 was actually worried about.

## §4. Auth model consequence

`/extract` moves from "public, defended by IP rate limiting" (v10 §3c) to "authenticated like `/audit`, rate limiting as a second layer." This is a strict improvement, not a wash: §3c's rate limiting was adopted specifically *because* there was no secret-holder available for a direct browser call — that constraint is what made IP-limiting "the defense" rather than "a defense." It no longer holds. Rate limiting stays in `biassemble-core` regardless (an authenticated caller can still be buggy or compromised, and v10 §4.1's search-quota ceiling doesn't care whether the caller is authenticated) but its role changes from primary control to defense-in-depth — worth updating in spec.md so a future reader doesn't read §3c as still describing the only line of defense.

## §5. Scope boundary — what this does not include

**Do not**, as part of landing this proxy:
- Add new tables or columns to `biassemble/backend`'s `sessions`/`session_data` schema for Grounnel. No audit-to-session linkage exists today; none is added here.
- Wire Grounnel's flow through Inngest or any job runner in `biassemble/backend`. `biassemble-core`'s own request/poll handling (D019 §1) remains the entire async execution model; `biassemble/backend`'s role is strictly "hold the secret, forward the request/response."
- Add user auth, login, or per-user rate limiting. IP-based limiting (v10 §3c) stays the mechanism at `biassemble-core`; anything user-account-shaped is separate, future work with its own trigger — a real login feature actually shipping — not something to build now because this file is already open. This is the same "gate infrastructure behind an actual need" discipline v10 §14 already applies to Render/WebSockets/a broker/Grafana, applied here to session/auth scope creep specifically.

## §6. Polling-latency check

`GET /status/:id` gains one hop under this decision: browser → `biassemble/backend` → `biassemble-core`, instead of browser → `biassemble-core` directly. Both are Vercel-hosted functions; the added hop is one intra-platform HTTP round-trip, on the order of tens of milliseconds, not seconds. This does not materially affect the 10-second polling cadence (v10 §3b) — considered and judged negligible, though not yet measured against a real deployment. Worth a real measurement once both sides are built, not asserted as proven here.

## Consequences

- `spec.md` (this repo's `specs/009-grounnel/`) needs its Open Questions and Boundaries sections updated to reflect this decision and resolve the "where does Grounnel's frontend live / how does it reach core" open question — tracked as a follow-up to this ADR, not left as a silent edit.
- `biassemble-core`'s `/extract` route gains `authHook`, same as `/audit` — a small, real code change, not yet made.
- `biassemble/backend`'s `core-client.ts` gains two new thin wrapper functions and two new route files — mirrors existing code, not a new pattern.
- D019 §1–§4 are entirely unaffected — the pipeline, trust boundary, native-search disqualification, and Redis-only state design hold regardless of which authenticated client calls `/extract`.

## §7. Addendum (2026-08-07) — "no external queue" corrected: `waitUntil()`, not a bare `await`

§2/§5 both describe the async model as "`biassemble-core`'s own request/poll handling... no external queue" — true and unchanged. What was wrong, and only surfaced on the first real production deploy (`specs/009-grounnel/tasks.md` T012 had explicitly flagged this exact mechanism as unverified against real Vercel runtime behavior): the *implementation* of "no external queue" assumed `vercel.json`'s `maxDuration: 300` keeps the serverless container alive for work `await`ed after `reply.send()`. It does not. Vercel freezes the container based on when the HTTP response finishes, not on whether the route handler's own promise chain has resolved — `maxDuration` only bounds how long work is *allowed* to run, it doesn't keep the container alive to do it. In production this meant the VERIFY pipeline (and every fire-and-forget Postgres write from D023) would suspend mid-flight the instant the `202` was sent, only resuming in unpredictable bursts if some unrelated request happened to reuse the same warm container.

This does **not** reopen §2/§5's decision — there is still no external queue, no Inngest, no job runner for this surface. The fix is `waitUntil()` from `@vercel/functions` (already a dependency, already used for the identical problem in `assessment.service.ts`, see D016): it's the actual platform-supported mechanism for "keep this container alive for background work after the response," which a bare `await` after `reply.send()` was never a substitute for. `pipelineService.run()` and every fire-and-forget store write (`grounnel_runs`/`grounnel_llm_calls`/`grounnel_search_calls`/`grounnel_gate_events`) are now wrapped in it.
