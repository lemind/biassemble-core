# Tasks: Grounnel Citation Provenance

**Input**: [plan.md](plan.md), [spec.md](spec.md), [D027](../../docs/decisions/027-grounnel-citation-provenance.md)

**Path convention**: all within this repo (`biassemble-core`) — no cross-repo tasks; consuming this in `biassemble/backend`/`frontend` is a separate follow-up (spec.md § Assumptions).

---

## Phase 1: Contract + resolver (foundational) ✅ Done

- [x] T001 [P] `ClaimCitationSchema` + `ClaimSchema.citations` — `src/contracts/grounnel.schemas.ts`. **Found and fixed during code review**: added a `.refine()` invariant (`evidence === null ⇒ citations.length === 0`, one-directional only — the converse doesn't hold since `attachCitationUrls` can legitimately drop a citation while evidence stays non-null) as a parse-time backstop, matching `ScoreSchema`'s own existing `.refine()` precedent in this file. Required splitting into an unexported `ClaimObjectSchema` (plain `ZodObject`) with `ClaimSchema`/`ClaimResultSchema` as two separately-refined derivations, since `.refine()` returns `ZodEffects`, which doesn't support the `.omit()` `ClaimResultSchema` needs (FR-001, FR-002, FR-005, FR-007).
- [x] T002 [P] Structured citation resolution — `src/orchestrators/grounnel/passage-sentences.ts`: `resolveEvidenceFromCitations` returns `{ evidence, citations }`, preserving citation order, never merging by source (FR-003). Unresolvable-citation-nulls-whole-answer behavior (D026 §11) extended to `citations` too.

**Checkpoint**: `pnpm typecheck` clean.

---

## Phase 2: Wire through the pipeline ✅ Done

- [x] T003 `callVerify` return shape — `VerifyProcessedResult` type (derived via intersection with `z.infer<typeof VerifyResultSchema>`, not hand-duplicated — code review finding, matches `VerifyRawResultSchema`'s own established `.omit().extend()` drift-proofing precedent right next to it) (depends on T002).
- [x] T004 `processVerifyResults` — citation labels mapped back to real URLs via `item.passages` (label order = rank order); `result.citations` vs `retried.citations` selected the same way `evidence`/`reason`/`confidence` already are (FR-006); gate-survival rule applied after the full chain (FR-005); `citations` included in `writeClaimResult`'s `ClaimResult`, deliberately NOT added to `historyStore.createClaim` (out of scope, D027 §4) (depends on T001, T003). **Found and fixed during code review**: the label encode/decode convention (`String.fromCharCode(65+i)` / `charCodeAt(0)-65`) was duplicated inline at 3 sites; extracted `passageLabelForIndex`/`passageIndexForLabel` for the 2 that are genuinely the same scheme (`callVerify`'s encode, `attachCitationUrls`'s decode) — left `rerankPassages`' own separate, ephemeral labeling untouched since it's a different concept despite the same alphabet (confirmed by an independent review pass tracing both).

**Checkpoint**: `pnpm typecheck` clean with the new field wired in.

---

## Phase 3: Tests ✅ Done

- [x] T005 [P] `passage-sentences.test.ts` — citation order preserved, same-source-repeated-twice produces two separate entries, unresolvable citation nulls both `evidence` and `citations` (11 → 18 tests, all passing) (depends on T002).
- [x] T006 `pipeline-service.test.ts` — no existing fixtures needed updating (the field is additive and optional at the TS level via Zod's `.default()`); added: (a) multi-source citation → correct per-source `url` attribution, extending the existing D026 §11 pooling test — Scenario 1; (c) gate #1-nulled evidence ⇒ `citations: []`, extending the existing fabricated-citation test — Scenario 3/SC-002; (d) a new dedicated test proving retry citations win over the primary's discarded ones even when BOTH are independently real/grounded (same repeated-sentence-different-index trick used to distinguish them without relying on gate-nulling) — Scenario 4/FR-006. (Same-source-twice, Scenario 2, is covered structurally by T005 at the resolver level — not duplicated here.) 47 → 48 tests, all passing (depends on T003, T004).
- [x] T007 [P] Backward-compatibility test — `grounnel-store.test.ts`: a hand-written pre-D027-shape claim row (no `citations` key at all, written directly to the fake Redis backing store, bypassing `createAudit`/`writeClaimResult`) parses via `getStatus` with `citations: []` — Scenario 5, FR-007. 10 → 11 tests (depends on T001).
- New: `grounnel.schemas.test.ts` — 5 new tests for T001's `.refine()` invariant directly (positive/negative cases for both `ClaimSchema` and `ClaimResultSchema`), added while applying the code-review fix. 12 → 17 tests.

**Checkpoint**: `pnpm test:run` — 990/990 passing (1 pre-existing, unrelated todo), `pnpm typecheck` clean, zero regressions anywhere in the 81-file repo-wide suite.

---

## Phase 4: Real-run verification ✅ Done

- [x] T008a — Ran the real (non-mocked) `GrounnelPipelineService` end-to-end locally via a one-off script wiring real `GeminiProvider`/`HybridSearchProvider`/`TavilySearchProvider` against the in-memory `FakeRedisHashClient` (bypassing only the Redis *infrastructure* requirement, not the pipeline logic itself — local `.env` has no Upstash Redis config, matching `server.ts`'s own documented conditional-boot behavior, so the HTTP route path was never an option locally). **Blocked short of the intended multi-source case**: local Gemini Search Grounding returned `400` and Tavily returned `403` — both external credential/config issues in this local dev environment, not caused by this change. What DID get verified: the real code path executed end-to-end (not mocked) and correctly degraded to `unsupported`/`evidence: null`/`citations: []` when search failed.
- [x] T008b — SC-001 fully verified against the live production API (`https://biassemble-core.vercel.app`, commit `55cdefd`, 2026-08-12): `POST /extract` + polled `GET /status/:id` with a real 3-claim article, real Gemini + real web fetch, no mocks anywhere. Confirmed: (1) `citations` present on every resolved claim with the documented `{source, sentence, url, text}` shape; (2) correct **multi-source** attribution — claim "designed by Gustave Eiffel" cited both source A (`pariscityvision.com`) and source B (`en.wikipedia.org`), each citation's `url` matching its own label, proving the object-identity matching (FR-004) holds under real multi-source pooling, not just in unit tests; (3) citation order preserved, not sorted/deduped (FR-003); (4) `evidence`/`sources`/`verdict`/`score` shapes unchanged (SC-003). Full raw response inspected, not just spot-checked.

---

## Dependencies & Execution Order

- Phase 1 (T001, T002) — both `[P]`, no shared files, can run in parallel.
- Phase 2 (T003 → T004, sequential — same file, T004 depends on T003's new return shape existing) blocks on Phase 1.
- Phase 3 (T005 `[P]` with T006/T007 once their own dependencies land; T006 needs T003+T004, T007 only needs T001).
- Phase 4 (T008) needs Phases 1–3 complete and passing.

## Notes

- No task touches `biassemble/backend` or `biassemble/frontend` — cross-repo consumption is explicitly deferred (spec.md § Assumptions, D027 §4).
- No prompt version bump, no DB migration — see D027 §4 for the full list of what this deliberately does not touch.
