# Plan: Grounnel API Surface

Phase 2 of `spec-driven-development`, against `spec.md` in this directory. Placed alongside `spec.md`/`initial-context.md` rather than at repo-root `tasks/plan.md` (the skill's generic default) — this repo already has an established `specs/00N-slug/plan.md` convention (see `specs/008-b2b/plan.md`) and no `/build`-style command here expects the generic path, so following the existing convention keeps this discoverable the same way every other spec in this repo is.

## 1. Major components and dependencies

```
SearchProvider (interface + Tavily impl)  ─┐
                                            │
GrounnelStore (Redis hash-per-audit)  ─────┼──→ pipeline.service.ts ──→ routes/grounnel.ts
                                            │         ▲
gates.ts / opinion-filter.ts /             │         │
passage-filter.ts (pure, deterministic) ───┘         │
                                                      │
extract.service.ts (EXTRACT + gate #3) ──────────────┘
                                                      │
rate-limit.ts ───────────────────────────────────────┘ (sits in front of routes/grounnel.ts, not the pipeline)
```

Dependency direction, strict: `routes/grounnel.ts` depends on the orchestrators and the store; the gates and filters depend on nothing in this list (pure functions over passed-in data); `SearchProvider` and `GrounnelStore` are the only two things touching the network/Redis, and both are injected, never imported directly by the pipeline (this is what makes the integration tests fakeable without real Tavily/Redis, per spec.md's Testing Strategy).

**Reused, not rebuilt:** EXTRACT/VERIFY prompt files and the repair pipeline (D004) — these are imported from the existing `src/prompts/audit/` and `src/lib/` locations, not copied.

**Out of this diagram, but not out of this plan:** per D020, `routes/grounnel.ts` is called by `biassemble/backend` (`core-client.ts`'s `extractClaims`/`getGrounnelStatus`), not by Grounnel's frontend directly. That side lives in a different repo and isn't drawn above, but it's tracked explicitly as step 8.5 in §2 rather than left unmentioned — the spec absorbed D020 fully; this plan needs to as well.

## 2. Implementation order

Sequential where a real dependency exists, otherwise noted as parallelizable in §4.

0. **Confirm Tavily's real response shape with one manual API call.** External prerequisite, not internal work — needs a Tavily key provisioned (not yet done, per earlier conversation). Blocks step 2: building `SearchProvider`'s interface against a guessed shape and adjusting later is exactly the risk §3's risk table warns about, so this has to resolve first, not in parallel with step 2.
1. **Contracts first** (`src/contracts/grounnel.schemas.ts`) — `ExtractRequestSchema`, `StatusResponseSchema`, claim/score shapes, matching v10 §3b exactly. Everything typed against a real shape (steps 2, 3) waits on this; step 4 (pure functions over passed-in data, no shape to type against) does not.
2. **`SearchProvider` interface + hybrid implementation** — **superseded by D021, as built (T008):** one method, `search(query) → SearchPassage[]`, not the two (`search`/`fetch`) sketched here — D021's fallback choreography (DIY fetch, then Tavily only if every candidate fails) can't be split across two caller-orchestrated calls without leaking internal choreography past the interface (D019 §2). Depends on step 0.
3. **`GrounnelStore` (Redis)** — `createAudit`, `writeClaimResult`, `getStatus`, exactly the `HSET`/`HGETALL` shape from D019 §4. Depends on step 1 only, **not** step 0 — this is a single, reconciled answer (an earlier draft of this plan gave three different answers across this line, §4, and §4's grouping table, caught in review; tasks.md's T007 `Dependencies: T002` was always correct and is what this line and §4 now match). Can be built in parallel with step 2 once step 1 lands (no shared code between the two), but both must land before step 5.
4. **The four gates + opinion/passage filters** (`gates.ts`, `opinion-filter.ts`, `passage-filter.ts`) — pure functions, no dependencies on steps 2 or 3. **Can start immediately, in parallel with everything above, including step 0.** This is the highest-value early work: it's the most novel logic in the whole feature (D019 §2's trust boundary), fully unit-testable with zero mocking, and de-risked independent of infra decisions.
5. **`extract.service.ts`** — EXTRACT call + gate #3, writes initial claim list via `GrounnelStore`. Depends on steps 1, 3, 4.
6. **`pipeline.service.ts`** — the per-claim loop: `SearchProvider` → fetch → gate #4 → VERIFY (batched) → gates #1/#2 → `GrounnelStore` write. Depends on steps 2, 3, 4, and the existing VERIFY prompt/repair pipeline.
7. **`rate-limit.ts`** — IP-based limiter in front of `/extract`, now defense-in-depth behind `authHook` rather than the primary control (D020 §4). No dependency on 5/6; can be built any time after step 1, in parallel with 5–6.
8. **`routes/grounnel.ts`** — wires everything together behind `registerGrounnelRoutes`, **including `authHook` as `preHandler` on `POST /extract`** (D020 §3 — this is the actual code change that realizes the ADR, not incidental to it, so it's named explicitly rather than assumed into "wires everything together"). Depends on every service above existing with a stable interface.
8.5. **`biassemble/backend` proxy** (different repo — `core-client.ts` gains `extractClaims`/`getGrounnelStatus`, mirroring `generateQuestion`/`generateAssessment`; two new route files forward request/response) — the D020 side of this feature. Depends on step 8's contract being stable (this is *why* it's sequenced after, not before). Tracked here so it isn't silently dropped, even though the file changes happen outside this repo.
9. **Integration tests** (`grounnel-extract.test.ts`, `grounnel-status.test.ts`, `grounnel-rate-limit.test.ts`) — written against step 8, using fakes for `SearchProvider`/`GrounnelStore` per spec.md's Testing Strategy, plus a 401-on-missing-auth case now that step 8 includes `authHook`.

## 3. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Tavily's real response shape doesn't match what was assumed while building steps 4–6 against a guessed interface | Resolved structurally, not just by discipline: step 0 makes the manual confirmation call a hard prerequisite that blocks step 2, rather than a "should probably do this at some point" aside. |
| `biassemble/backend`'s proxy (step 8.5) gets built against a `/extract`/`/status/:id` contract that's still shifting in this repo, or gets skipped entirely since it's "someone else's repo" | Step 8.5 is sequenced strictly after step 8, not in parallel — the contract must be stable first. Naming it in this plan at all is the mitigation for the second half: D020 made it this repo's decision, so it doesn't get to be invisible to this repo's plan. |
| Redis hash-per-audit design (D019 §4) has an untested edge case — e.g. two claims in the same batch writing to the same audit concurrently | The design already avoids the read-modify-write race by construction (per-claim `HSET`, no shared blob) — but write one integration test that fires two concurrent `writeClaimResult` calls for the same audit and asserts both land, to confirm the design assumption holds in practice, not just in the ADR's reasoning. |
| Gate #1/#2 logic silently diverges from the already-proven B2B reconcilers (D018 §5) instead of reusing them, reintroducing bugs D018 already paid to fix | Import and adapt from `src/orchestrators/audit/` where the shape matches (numeric comparison in particular is a near-direct port per D019 §2's table) rather than writing gate logic from scratch. |
| Rate limiter becomes the thing that's "temporarily" skipped to unblock testing and never gets re-enabled | It's listed as a P0 non-negotiable in spec.md's Success Criteria with its own integration test (step 9) — the test suite, not discipline alone, is what keeps this from silently regressing. |
| `maxClaims`/search-cap defaults (spec.md Open Questions) get hardcoded during implementation before they're actually confirmed | Land them as named constants in one file (not scattered inline), so confirming the real number later is a one-line change, not a search-and-replace. |

## 4. Parallel vs. sequential

**Can start in parallel, day one:** step 4 (gates/filters — no dependencies at all), step 1 (contracts), and step 0 (Tavily confirmation — a phone-call/API-key-provisioning task, not code, so it costs nothing to run alongside 1 and 4). Step 3 (`GrounnelStore`) is **not** in this group — it needs step 1 first (see step 3's own line above). Step 2 (`SearchProvider`) needs step 0.

**Must be sequential:** step 2 needs step 0; step 3 needs step 1; steps 5 and 6 both need 1+3+4 done first; step 8 needs everything before it; step 8.5 needs step 8; step 9 needs step 8.

**Realistic grouping for a solo-dev pace:** {0, 1, 4} first (step 0 running in the background while 1 and 4 are actual coding work — fastest path to a fully-tested, real piece of the trust boundary shipping); then, as soon as step 1 lands, step 3 can start regardless of whether step 0 has resolved yet, and step 2 can start as soon as step 0 has resolved regardless of step 3 — the two don't block each other, they just each wait on a different, independent prerequisite; then 5 → 6 → 7 → 8 → 8.5 → 9.

## 5. Verification checkpoints

- **After step 0:** the real Tavily response for at least one query/URL pair is on hand and step 2's interface is checked against it, not against documentation alone.
- **After step 1:** `pnpm typecheck` passes with the new contracts imported nowhere yet (dead code is fine at this point, a type error is not).
- **After step 4:** full unit test coverage on all four gates + both filters, including the coreference-gap case from D019 §2 captured as `test.todo(...)` (tasks.md T006 — a permanently-red test trains people to ignore CI failures, so the gap is tracked as a visible, named pending case instead) so it stays visible in the suite rather than only in prose, and gate #3's zero-search-calls assertion (spec.md Success Criteria) alongside it.
- **After step 6:** one manual, real (non-mocked) run against a real Tavily key and a real short pasted article, checked by hand against the "what to check" discipline used in the D019 benchmark (real evidence, real source, gate #1 actually firing on at least one deliberately-planted bad case) — before trusting the integration test fakes.
- **After step 8:** integration suite green, including the concurrent-write test from §3's risk table, the forced-batch-failure `not_checked` test, and the 401-on-missing-auth test (`authHook`, D020 §3) from spec.md's Success Criteria.
- **After step 8.5:** one real end-to-end call through `biassemble/backend` → this repo, confirming the added hop's latency against v10 §3b's 10-second polling assumption (D020 §6 — "considered, not yet measured" gets resolved here, not left open indefinitely).
- **Before calling P0 done:** every Success Criterion in spec.md checked off explicitly, not inferred from "tests pass" — `caps_hit`, `not_checked` denominator handling, and the rate-limit 429 in particular are easy to have green tests for while still being wrong in a way tests didn't cover.

## 6. Post-P0 addendum (D022)

Steps 0–9 above cover P0 as originally planned; P0 shipped and this plan's checkpoints all passed. What §5's checkpoints could not cover — because it needs real, non-mocked API calls, not the fakes this plan's integration tests use — is whether the shipped pipeline is actually *correct* against real Gemini/Tavily responses, not just internally consistent against fixed test inputs. D022 §1 builds that missing check (a real-call golden set + CLI/Inngest runner) and §2–§4 cover what it found. Tracked as tasks.md Phase 8 (T017–T022), not folded into the numbered steps above since none of it was foreseeable at plan time — it's a direct consequence of running the already-shipped pipeline for real, not a step that could have been sequenced in originally.

## 7. Durable persistence addendum (D023)

D019 §4's Redis-only decision is reopened on its own named terms — persistent history and analytics are now real requirements, and this session's own live-eval work (§6) surfaced a third: gate/search-fallback telemetry had no durable tracking at all, an unrecoverable gap once Vercel's log retention rolled past it. D023 designs a new `grounnel` pg schema (5 tables, sibling to `core`/`audit`) and reuses `biassemble/backend`'s existing anonymous-session mechanism rather than inventing one. Tracked as tasks.md Phase 9 (T023–T028): schema first as the dependency root (`planning-and-task-breakdown`'s "build foundations first" rule — nothing else can be reviewed against a guessed column shape), then four independent write-path tasks (history, LLM-call+prompt-version, search-fallback, gate telemetry) that each touch a different call site and don't block each other, then the cross-repo session task last since it depends on this repo's shape being stable — same sequencing reasoning already applied to T013/step 8.5 above. Redis stays exactly as-is for `GET /status/:id`'s live-polling path (D023 §7) — this is additive, not a replacement, so none of steps 0–9's checkpoints are invalidated by it.
