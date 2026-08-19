# Quickstart: Grounnel Ordinal Contradiction Detection & Claim Eligibility Filtering

## Build order

1. `applyReasonOrdinalGate` in `gates.ts`, **unwired** — pure function, no call site yet.
2. `gates.test.ts` — the full validation matrix from `data-model.md` §1, plus a run of the existing
   `applyReasonYearGate` golden cases unchanged (regression guard).
3. Only after (2) passes with zero false positives on the "must NOT fire" / "must abstain" rows:
   wire into `runGateChain` (`pipeline.service.ts`), after `reason_year`.
4. Persistence: add `"reason_ordinal"` to the 4 union types (`data-model.md` §3) — only at this
   point, not before.
5. `classifyClaimVerifiability` in new `claim-eligibility.ts` + its prompt
   (`src/prompts/grounnel/eligibility/system.json`) — independent of steps 1–4, can be built in
   parallel.
6. Wire into `extract.service.ts` / the EXTRACT→search boundary, **after** the existing
   `isOpinionClaim` call, not ahead of it — the cheap regex runs first (unchanged); the LLM
   classifier only evaluates claims the regex didn't already exclude. Same outcome, lower cost.
7. Golden-set additions (both features) under `evaluations/golden/grounnel/`.

## Validation commands

```bash
pnpm typecheck
pnpm test:run tests/unit/orchestrators/grounnel/gates.test.ts
pnpm test:run tests/unit/orchestrators/grounnel/claim-eligibility.test.ts
pnpm test:run                       # full suite — must not regress the documented 16 pre-existing failures
pnpm eval:grounnel                  # live golden-set run, once both pieces are wired in
```

## Live re-verification (this repo's own convention — see D030's "Source" line and tasks.md Phase
34/35 for why this matters: two prior fixes for this exact bug looked correct in isolation and
still failed live)

After deploying with the ordinal gate wired in:

```bash
# re-run the exact test article that originally exposed the Wright-brothers bug, twice,
# and confirm the claim no longer lands on "supported" or "partially_supported"
```

Check `grounnel_gate_events` directly (same method used to verify T069) to confirm
`reason_ordinal` fires on the regression case and does not fire on unrelated runs in the same
batch.

## Definition of done

- [ ] `applyReasonOrdinalGate` passes 100% of the D030 §3a / `data-model.md` §1 validation matrix
      (including the expanded false-positive rows: modifiers between ordinal and anchor, discourse
      ordinal mixed with a real one, same-anchor-different-measurement).
- [ ] Zero false downgrades on a held-out set of correctly-supported claims (SC-002) — not just the
      built-in fixture set.
- [ ] All existing `applyReasonYearGate` golden cases still pass unchanged (no cross-gate
      interference).
- [ ] Wired into `runGateChain`; 4 persistence union types updated.
- [ ] Live re-run of the original Wright-brothers regression article: claim no longer `supported`.
- [ ] `classifyClaimVerifiability` passes its true-exclusion and hard-negative validation set
      (`data-model.md` §2) — zero false exclusions of checkable claims in the hard-negative set.
- [ ] Zero false exclusions on a held-out set of checkable first-person claims (SC-004) — the
      primary safety metric for this check.
- [ ] Confirm `isOpinionClaim` runs before `classifyClaimVerifiability` (not after) in
      `extract.service.ts` — the classifier should never be invoked for a claim the regex already
      caught.
- [ ] Live re-run of the original "I was in need of a new laptop" report: claim labeled distinctly
      from a checked-and-empty result, not `unsupported`.
- [ ] `verify/system.json` (`MULTIPLE SOURCES`) untouched — confirm no unintended prompt-version
      bump slipped in alongside this change.
- [ ] Both changes reviewed at this repo's usual effort level before merge (see
      `code-review-and-quality` skill / `docs/testing-philosophy.md`).
