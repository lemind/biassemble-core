# D023 — Grounnel Durable Persistence: History, Analytics, Gate/Fallback Telemetry

Reopens D019 §4 on its own named terms (*"Reintroduce Postgres if persistent history, analytics... become actual product requirements"*) and amends D020 §5's session-schema restriction. Six parts: what's reopened and why (§1); session ownership, reusing `biassemble/backend`'s existing mechanism rather than inventing one (§2); the new `grounnel` Postgres schema and its five tables (§3); prompt versioning — already built, never wired (§4); gate telemetry, a new capability this repo didn't have for any product before (§5); search-provider fallback telemetry, closing a real gap this session found had zero durable tracking (§6); and the Redis/Postgres division of labor (§7).

Source: `docs/decisions/019-grounnel-pipeline-trust-boundary.md` §4, `docs/decisions/020-grounnel-routes-through-biassemble-backend.md` §5, this repo's own `src/db/schema.ts`/`src/persistence/` (the audit product's proven pattern), and `biassemble/backend/src/services/session.service.ts` + `src/drizzle/schema.ts` (the reflection product's proven pattern) — both read directly from the checked-out repos, not from memory of them.

---

## §1. What's reopened, and why now

D019 §4 scoped Grounnel to Redis-only "ephemeral execution state," explicit that it was **not** a permanent rejection of Postgres, and named the exact triggers that would reopen it: *"persistent history, analytics, multi-user features, or long-lived shareable reports."* Two of those four are now real, explicit product requirements: a user should be able to see past checks (history), and the product needs aggregate visibility into its own behavior (analytics — verdict distribution, gate override rates, search-fallback rates). This ADR is that reopening, on the terms D019 §4 itself set, not a reversal of the reasoning that led to Redis-only at P0 — Redis was the right call when none of its own named triggers were true yet.

**Also surfaced by this reopening, not part of the original ask but found while building it**: `hybrid-provider.ts`'s Tavily-fallback path (D021) had **zero durable tracking** — only a `logger.info()` call, which lives in Vercel's short-retention function logs and is unrecoverable within hours. The question "how many times did we fall back to Tavily" was unanswerable in this session even from real production runs earlier the same day. §6 closes this specifically.

---

## §2. Session ownership — reuse, don't reinvent (amends D020 §5)

**Decision**: `biassemble/backend` creates a session for a Grounnel `/extract` call using its **existing, already-generic `sessions` table** (`id`/`status`/`createdAt`/`updatedAt` — no story-specific or product-specific columns), the same table and the same `createSession()` call the reflection product's `session.service.ts` already uses. No new table, no new mechanism — `handleCreateSession`'s shape (`create session` → `call AI Core, passing sessionId` → `persist product-specific result data keyed by that sessionId` → `update session status`) is copied structurally for Grounnel's proxy route, per D020 §3's existing `extractClaims`/`getGrounnelStatus` scope in `core-client.ts` (T013, not yet built).

**D020 §5 said** *"no session/user schema added to `biassemble/backend` for Grounnel... it is a stateless pass-through only."* That was correctly written against a world with no history/analytics requirement — a stateless proxy had nothing to attach a session to. It was never a statement that biassemble/backend must avoid its own **already-existing, product-agnostic** session mechanism forever; it was ruling out inventing a **new, Grounnel-specific** user/login system, which this ADR still does not do. No login system exists anywhere in this product family today (confirmed: `biassemble/backend`'s `sessions` table has no `users` table backing it at all) — Grounnel's "user history" is anonymous, session-scoped, exactly like the reflection product's already is. This is the answer to the "what does 'user' mean" question this ADR was blocked on: it means the same anonymous, per-session identity the rest of the product already uses, not a new concept.

**Do not**: build a login/accounts system as part of this ADR. If real cross-device, cross-session user identity is ever required, that is a new, separate decision — this one only extends the existing anonymous-session pattern to a second product.

---

## §3. New `grounnel` Postgres schema, in this repo

**Decision**: a third sibling `pgSchema`, alongside `core` and `audit` (`src/db/schema.ts`, D018 §2.4's precedent — one schema per product, so one product's data can be dropped without touching another's). **Own tables throughout, not shared with `core`'s existing `llm_calls`/`runs`/`session_data`-equivalents** — structurally similar where the shape genuinely matches (the LLM-call log in particular mirrors `core.llm_calls` closely), but a separate table, per the explicit instruction that this stay decoupled from the reflection product's schema rather than layering onto it.

```
grounnel schema
├── grounnel_runs         — one row per /extract call (the "story" — pasted text — plus status/score)
├── grounnel_claims       — one row per claim, durable copy of what Redis holds transiently
├── grounnel_llm_calls    — Gemini EXTRACT/VERIFY calls, mirrors core.llm_calls' shape (own table)
├── grounnel_search_calls — SearchProvider calls: DIY-fetch vs Tavily-fallback (§6, new concept)
└── grounnel_gate_events  — every gate firing, per claim (§5, new concept)
```

**`grounnel_runs`** — `run_id uuid PK` (application-generated, the *same* id already used as the Redis hash key `audit:{id}` — one id, two stores, not two identities for one run); `session_id uuid` (no FK, backend-owned, per §2); `text` (the pasted story); `status` (`running|done|failed`, mirrors `GrounnelStatusEnum`); `max_claims`, `truncated`; `prompt_version_extract`, `prompt_version_verify` (§4); `score jsonb` (final score object, written once); `created_at`, `completed_at`.

**`grounnel_claims`** — `claim_id uuid PK` (same id as the API/Redis contract); `run_id` FK → `grounnel_runs` (same-schema FK, matches `audits`/`claims`' existing precedent in `auditSchema`); `claim_text`; `verdict`, `evidence`, `confidence`, `reason`; `sources jsonb`; `status` (`done|failed`); `created_at`. Written once per claim, when its final result is written to Redis — a durable mirror, not a replacement (§7).

**`grounnel_llm_calls`** — same column shape as `core.llm_calls` (`stage: extract|verify`, `call_type: primary|fallback`, `provider`, `model`, `prompt_version`, `raw_response`, `parsed_output`, `status`, `failure_type`, token counts, timing) but its own table in the `grounnel` schema, written via a Grounnel-specific `GrounnelLlmCallStore` implementing the same `LlmCallStore` port shape `executeAndRecordLlmCall` already expects (`src/observability/llm-call-recorder.ts` — reused as-is, only the store implementation is new). `call_type` will read `primary` for essentially every row today (Grounnel has no LLM-level fallback provider, only `HybridSearchProvider`'s *search*-level fallback, §6) — the column exists for structural parity with `core.llm_calls` and because a fallback LLM provider is a plausible future addition, not because it's exercised today.

**Why not reuse `core.llm_calls` directly** (it would have cost zero new migration): D018 §2.4's own stated reason for `audit`'s separate schema — independent lifecycle, independent right-to-be-dropped, no coupling to a different product's retention/deletion decisions — applies identically here, and was also the explicit instruction this ADR is following rather than re-deriving.

---

## §4. Prompt version — already built, never wired

**Finding, not a gap to build**: `PromptRegistry` already has `getGrounnelExtractVersion()` and `getGrounnelVerifyVersion()` (`src/prompts/registry.ts:43-49`), reading the `version` field already present in `src/prompts/grounnel/extract/system.json` / `.../verify/system.json` (confirmed live at `"2.0.0"` for VERIFY, per D022 §3's rewrite). **Neither getter is called anywhere in the codebase today** — grep confirms zero call sites. The version-tracking mechanism this ADR was asked to check for already exists, structurally identical to how `assessmentData`'s version and audit's `getAuditVersion()` are already used (`verify.service.ts:71`, stamped into `promptRevisionVerify` on every `audits` row).

**Decision**: no new versioning infrastructure. `pipeline.service.ts`/`extract.service.ts` call the existing getters and pass the result into `grounnel_runs.prompt_version_extract`/`_verify` and every `grounnel_llm_calls.prompt_version` row, exactly matching `verify.service.ts`'s existing call shape.

---

## §5. Gate telemetry — new capability, no precedent to reuse

**Decision**: every gate evaluation in `pipeline.service.ts`'s chain (`applyReasonConsistencyGate`, `applyImplicitNegationGate` — D022 §4, `applyContradictionEvidenceGate` — gate #1, `applyNumericGate` — gate #2) writes one `grounnel_gate_events` row: `run_id`, `claim_id`, `gate` (`reason_consistency|implicit_negation|contradiction_evidence|numeric`), `verdict_before`, `verdict_after`, `overridden boolean`, `created_at`. Written regardless of whether the gate fired — a row with `overridden: false` is itself the data that answers "how often does this gate even get a chance to fire," not just "how often does it override."

**Why this didn't exist before**: no product in this repo has had per-gate-decision telemetry before now — `core.llm_calls` tracks LLM calls, not the deterministic code-side gates layered on top of them. This is Grounnel's own trust-boundary (D019 §2) becoming observable, which is a direct, mechanical answer to "let's log eval gates": every gate D019 §2/D022 already made deterministic and unit-testable now also becomes queryable in aggregate — override rate per gate, per prompt version, over time — instead of only verifiable one golden-set run at a time (D022 §1).

**Consequences**: this is what would have let this session's own gate-fix work (D022) be validated against real aggregate rates instead of an 11-case golden set alone, going forward.

---

## §6. Search-provider fallback telemetry — closes a real, found gap

**Decision**: `HybridSearchProvider.search()` (`hybrid-provider.ts`) writes one `grounnel_search_calls` row per claim's search: `run_id`, `claim_id`, `query`, `call_type` (`diy_fetch|tavily_fallback`), `result_count`, `status` (mirrors `SearchPassage.status`), `duration_ms`, `created_at`. The `logger.info()` at line 102-105 stays (operational visibility during an active incident) — this is additive, a durable second copy for anything that needs to survive past Vercel's log retention window, which this session confirmed is already too short to answer a same-day question.

**Why this is its own table, not folded into `grounnel_llm_calls`**: a search call is not an LLM call — different provider, different failure modes (`rate_limited`, `unreachable`, not `schema_validation`/`timeout`), and D021's whole fallback design (DIY-fetch first, Tavily only when every DIY candidate fails) is specifically about *this* call type. Collapsing it into the LLM-call table would mean overloading `call_type`'s meaning across two unrelated systems.

---

## §7. Division of labor — Redis stays, Postgres is additive

**Decision**: no change to D019 §4's Redis mechanism for in-flight state. `GET /status/:id` keeps reading Redis (`HGETALL audit:{id}`) exactly as today — that is the live-polling path and Postgres is not on it. `grounnel_runs`/`grounnel_claims` are written **after** Redis (fire-and-forget, matching `retrievalComparisons`' own "written fire-and-forget after runFullAssessment" precedent in `core`'s schema) — once a run or claim result is already correct and served from Redis, not instead of it. `grounnel_llm_calls`/`grounnel_search_calls`/`grounnel_gate_events` are written inline as each call/gate happens, same as `core.llm_calls` already does via `executeAndRecordLlmCall`.

**Why**: this preserves every real-time guarantee D019 §4 established (no read-modify-write race, `GET /status/:id`'s per-poll `HGETALL` cost unchanged) while adding exactly the two capabilities named in §1 as the reopening trigger. A Postgres write failing does not fail the user-facing run — matches `executeAndRecordLlmCall`'s own existing `try/catch` + `logger.warn` pattern around `store.recordCall`, reused rather than re-derived.

**Redis TTL** (`AUDIT_TTL_SECONDS`, 7 days) is unchanged — it still governs how long a run is *live-pollable*; Postgres is what makes it *permanently retrievable* past that window, which is the actual "history" requirement.

**Consequences**: `POST /extract`'s response latency is unaffected (Postgres writes are fire-and-forget or already-inline-and-cheap, not blocking the `202`); `GET /status/:id`'s latency is unaffected (still Redis-only); a new `GET /grounnel/history` (or equivalent, not designed here) becomes possible against Postgres, out of this ADR's scope to design.

---

## Not decided here — named, not silently dropped

- The actual shape/route for reading history back (`GET /grounnel/history?sessionId=...` or similar) — this ADR adds the write path, not a new read API.
- Whether `grounnel_runs`/`grounnel_claims` ever need a retention/deletion policy of their own (GDPR-style "forget me," given anonymous pasted text could contain PII) — flagged, not resolved; D019 §4's Redis TTL had this luxury for free at 7 days, Postgres does not.
- `biassemble/backend`'s own Grounnel proxy (T013, tasks.md Phase 6) is still not built — this ADR extends its eventual scope (create a session, same as `handleCreateSession`) but does not build it.
