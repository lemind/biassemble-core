# Plan: Grounnel Citation Provenance

Phase 2 of `spec-driven-development`, against `spec.md` in this directory. See `docs/decisions/027-grounnel-citation-provenance.md` for the full investigation and rationale — this plan covers only the "how", not the "why".

## 1. Files touched

```
src/contracts/grounnel.schemas.ts        → new ClaimCitationSchema, ClaimSchema gains `citations`
src/orchestrators/grounnel/
  passage-sentences.ts                   → resolveEvidenceFromCitations returns structure, not just a string
  pipeline.service.ts                    → callVerify's return shape, processVerifyResults's gate-survival logic
tests/orchestrators/grounnel/
  passage-sentences.test.ts              → new cases for the structured resolver
  pipeline-service.test.ts               → updated mocks (new field on every VerifyResultSchema-shaped fixture), new gate-nulling/retry cases
```

No route file changes — `routes/grounnel.ts` serializes whatever `getStatus` returns; `ClaimSchema`'s change is picked up automatically.

## 2. Implementation order

1. **`passage-sentences.ts`**: split `resolveEvidenceFromCitations` into two return values (or add a sibling function) — `{ evidence: string | null; citations: ResolvedCitationEntry[] }` where `ResolvedCitationEntry = { source: string; sentence: number; text: string }` (no `url` yet — this function doesn't have access to source URLs, only sentence pools keyed by label). Preserves citation order exactly as given, one entry per citation, no merging. Depends on nothing — pure function, testable in isolation first.
2. **`pipeline.service.ts`'s `callVerify`**: consume the new structured return; each result gains `citations: ResolvedCitationEntry[]` (label + sentence + text, no URL yet) alongside the existing `evidence: string | null`. `VerifyResponseSchema`'s TS-side result type (not the Zod schema consumers see — this is an internal type) grows the field. Depends on step 1.
3. **`pipeline.service.ts`'s `processVerifyResults`**: this is where URLs get attached and gates get applied, in that order:
   - Map each citation's `source` label back to its real `SearchPassage` via `item.passages[i]` (label order = rank order, existing invariant) — `item.passages[i].url` is the answer. Build `citationsBeforeGates: ClaimCitation[]` (now with `url`) from `result.citations` (primary) or `retried.citations` (if a retry happened) — same binary selection already made for `evidence`/`reason`/`confidence` (existing code, lines ~933/962).
   - After the full gate chain + `checkRetryContradiction` produce the final `chain.evidence`, apply the survival rule: `finalCitations = chain.evidence !== null ? citationsBeforeGates : []`.
   - Include `citations: finalCitations` in the `ClaimResult` written via `writeClaimResult` and `historyStore.createClaim` (the latter for consistency, even though history's own citation column isn't part of this spec — pass it through if `createClaim`'s input type accepts extra fields harmlessly, otherwise omit from history specifically and note why in a comment, not silently).
   Depends on steps 1–2.
4. **`grounnel.schemas.ts`**: add `ClaimCitationSchema` (`source: z.string()`, `sentence: z.number().int()`, `url: z.url()`, `text: z.string()`), `ClaimSchema` gains `citations: z.array(ClaimCitationSchema).default([])`. Independent of steps 1–3 — can be written any time, but must land before step 5's tests can assert against real Zod parsing.
5. **`grounnel-store.ts`**: no code change expected — `writeClaimResult`'s read-merge-write already spreads whatever `ClaimResult` fields exist; `ClaimSchema.parse` on read already handles the new field's default. Verify this assumption with a test (T004 below) rather than asserting it blind.
6. **Tests**: unit tests for step 1 (structured resolver — order preservation, no merging, empty/null-citations case), a `gates.ts`-adjacent test confirming the derived survival rule against a real gate #1 rejection, a `pipeline-service.test.ts` case for the retry-citations-not-primary-citations scenario (FR-006), and a backward-compatibility test for step 5 (parse a hand-written pre-existing-shape Redis value missing `citations`, confirm it defaults to `[]`).

## 3. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Citation survival rule (evidence-nulled ⇒ citations-nulled) has an edge case the "gates only pass-through-or-null, never rewrite" invariant doesn't actually hold for (e.g. a future gate change violates it silently) | The rule is applied at one single point (`processVerifyResults`, after the full chain), not scattered — a future violation would show as a citations/evidence mismatch, testable directly. Documented explicitly in D027 §2 and this plan so a future gate author sees the assumption. |
| `item.passages[i]` (label→passage index mapping) drifts from `sentencesByClaim`'s own label assignment if either changes independently in future work | Both already derive from the exact same `String.fromCharCode(65 + i)` convention over the exact same `passages` array, in the exact same function (`callVerify`) — no new indirection introduced, this plan reuses the existing invariant rather than inventing a second one. |
| `historyStore.createClaim`'s input type doesn't accept a `citations` field and this silently drops it or errors | Checked at implementation time (step 3); if the type doesn't accept it, `citations` is passed to `writeClaimResult` (the response-facing store) only, with a one-line comment noting history intentionally doesn't carry it yet — not silently absorbed into an `any`. |
| Existing `pipeline-service.test.ts` mocks (every `VerifyResultSchema`-shaped fixture) break once the internal result type gains a required-in-practice `citations` field | Expected and budgeted — same category of mechanical update D026 §11/§12 each required ("every existing gate-event-count assertion shifted... updated, not weakened"). Not a design risk, a known mechanical cost. |

## 4. Verification checkpoints

- **After step 1**: unit tests for the structured resolver pass in isolation — order preservation, no-merge, and the existing D026 §11 "any unresolvable citation nulls the whole answer" behavior still holds (now nulling both `evidence` and `citations`).
- **After step 3**: a `pipeline-service.test.ts` case reproducing D027's own acceptance scenarios directly — multi-source citation with correct per-citation `url`, gate-#1-nulled evidence ⇒ empty citations, retry-path citations (not primary-path).
- **After step 4**: `pnpm typecheck` clean; a hand-constructed `StatusResponseSchema.parse()` call against a fixture missing `citations` succeeds with `citations: []`.
- **Before calling this done**: one real, non-mocked pipeline run (existing local/live-eval harness) against a multi-source claim, `citations` inspected by hand against the real `grounnel_llm_calls` raw citation output for that claim — confirming the shipped code, not just the tests, matches D027 §2's traced behavior.
- **Full suite**: `pnpm test:run` green, `pnpm typecheck` clean, no unrelated test regressions.

## 5. Explicitly out of scope (see D027 §4 for full rationale)

- `biassemble/backend`/`biassemble/frontend` consuming the new field — separate follow-up.
- `#:~:text=` deep links.
- Any prompt (`verify/system.json`) version bump — VERIFY's own output contract doesn't change.
- Any Postgres/history schema migration.
