# D031 — Extend the Stuck-Run Self-Heal Past `verifying`; Rewrite Ungrounded-Affirmative Reasons

## §1. Trigger

A live `/extract` test run (6 articles, 2026-08-22) found two real bugs:

1. A run stuck reporting `status: "extracting"`, `checked: 0, total: 5`, for 30+ minutes — the
   other 5 runs in the same batch finished in 32–140s.
2. Two true claims came back `verdict: "unverifiable"`, `confidence: 1.0`, zero citations, with a
   `reason` reading *"Multiple sources state the first flight lasted 12 seconds."* — the verdict
   and the text shown beside it directly contradict each other.

## §2. Root cause — stuck `extracting`/mid-`verifying` runs

`routes/grounnel.ts` runs `classifyEligibility()` then `pipelineService.run()` inside one
`waitUntil()` call after the `202` response, bounded by the same `vercel.json` `maxDuration: 300`
D029 already documented. `classifyEligibility()` fans out one Gemini call per claim
(`ELIGIBILITY_CONCURRENCY = 20`, `Promise.all` per chunk) with no per-call or per-phase timeout. A
provider stall inside that fan-out hangs indefinitely; nothing throws, so nothing reaches the
existing `catch` (which marks `historyStore` — Postgres — failed on a thrown error), and a
`maxDuration` kill is not a JS exception either, exactly D029 §2's own argument, on a phase D029
didn't cover: D029's self-heal only fires when `checked === total && escalating`, i.e. after every
claim has already been written. A run that dies before writing its first claim never satisfies
that condition and is invisible to it.

**Confirmed asymmetry, worth recording**: `classifyEligibility`'s `catch` only updates
`historyStore` (Postgres, analytics-only). `GET /status/:id` reads `grounnelStore` (Redis) via
`getStatus()`, which nothing in that `catch` touches. So even a *fast, thrown* failure in
eligibility does not by itself change what a polling client sees — only a `getStatus()`-side fix
does. This is why the decision below lives in `getStatus()`, not in the `catch`.

## §3. Decision — extend the self-heal to any silent, incomplete run

`RedisGrounnelStore.getStatus()` reports `"failed"` when the run is **not** fully checked and
nothing has touched Redis in over the same stale threshold used for D029's escalation self-heal
(renamed `STUCK_RUN_TIMEOUT_MS` — one constant, two phases now).

Staleness is computed against `lastActivityAt`, falling back to `meta.createdAt` when
`lastActivityAt` was never written at all — which is exactly the case for the run that triggered
this ADR: it died before its first `writeClaimResult`, so `lastActivityAt` doesn't exist yet, and
`createdAt` (written unconditionally in `createAudit`) is the only activity signal available.

Same safety argument as D029, restated for the new condition: `maxDuration` bounds the *entire*
background execution from invocation start, so a threshold meaningfully above 300s cannot
false-trigger on a genuinely still-running phase — it only ever fires on a run already dead.

This is a read-time-only change. `getStatus()` stays read-only, matching D029 §4's own precedent —
no new write path, no attempt to reconcile Redis state after the fact.

One existing test's expectation changes as a direct, intended consequence: "stale + `checked <
total` + `escalating`" previously asserted the status stays `"verifying"` forever (D029's own
"never report an incomplete run done" principle). It now asserts `"failed"` — a third state that
honors the same principle (an incomplete run is still never reported as a finished success) while
also giving a stuck client a terminal state to stop polling on, which `"verifying"` forever did not.

## §4. Decision — fail the eligibility phase fast, and log its boundary

`classifyEligibility()` races its work against a 2-minute timeout (`ELIGIBILITY_PHASE_TIMEOUT_MS`)
— generous over the concurrency-20 fan-out's typical run, while leaving most of the 300s budget for
the pipeline run that follows in the same invocation. A timeout rejects into the existing `catch`
unchanged. Entry and exit `logger.info` calls make the phase boundary observable at all — before
this, a hang here was invisible except by polling `/status` and watching nothing move.

This does not fix §3's user-visible symptom by itself (see the asymmetry noted in §2) — it makes
the failure fail fast, get logged, and get recorded in `historyStore` for analytics, instead of
silently consuming the full `maxDuration` budget.

## §5. Root cause — reason/verdict incoherence

Grounded-by-construction (D026 §7) correctly refuses to call a claim `supported` with zero sentence
citations. That mechanism is working as designed. But nothing stops VERIFY's own `reason` text from
still affirmatively asserting that sources confirm the claim — the LLM is describing what it
believes, not what the pipeline can point to. The result reaching the user is self-contradictory:
a verdict that says "not verified" next to prose that says "confirmed."

## §6. Decision — rewrite the reason, never the verdict

`gates.ts` gains `rewriteUngroundedAffirmativeReason(verdict, citationsCount, reason)`: a pure
function that replaces `reason` with a plain, honest sentence — *"The available sources did not
provide a specific passage that could be cited to verify this claim."* — when, and only when,
`verdict` is `unsupported` or `unverifiable`, `citationsCount === 0`, and `reason` contains
affirmative source-confirmation language (`sources`/`passage`/`evidence` near
`state(s)`/`confirm(s)`/`indicate(s)`/`show(s)`/`support(s)`/`report(s)`) with no negation word
inside that matched span. Any negated phrasing ("sources do **not** confirm...") is left untouched,
as is any reason that doesn't use this language at all ("could not verify...").

Wired at the single point in `pipeline.service.ts` where VERIFY's gate-chain-processed result is
persisted (`processVerifyResults`) — the one path this bug was observed on, and the only place
`reason` is LLM-authored prose rather than a fixed template string. Verdict, confidence, and
citations are untouched — matching this file's established one-directional discipline (force one
way, never invent agreement in the other).

**On AGENTS.md rule 12 (prefer LLM judgment over regex for semantic checks)**: this is regex over a
closed, prompt-shaped vocabulary VERIFY itself tends to produce ("sources state/confirm/indicate"),
not open-ended natural-language classification — the same class of exception the rule already
carves out ("regex stays fine for closed, enumerable formats"). A miss leaves today's behavior
(the incoherent-but-not-wrong-verdict text); a false positive swaps one honest sentence for
another. Neither failure mode is a verdict-correctness risk.

## §6b. Review findings, folded in before this ADR was finalized

A medium/high-effort `/code-review` pass on this diff (before commit) surfaced two real bugs, both
fixed in place rather than deferred:

1. **`§4`'s `Promise.race` doesn't cancel its loser.** If `classifyEligibilityBatch` is merely slow
   — not truly hung — and resolves after the phase timeout already fired, it kept running
   unobserved: its `writeExcludedClaim` calls still landed in Redis, updating `lastActivityAt` after
   the run had already been reported `"failed"` in Postgres. Worse, a late write like this resets
   the exact staleness clock §3's self-heal reads, so a client that already saw `"failed"` could
   poll again and see `"verifying"` — a status flip-flop on what should be a terminal state.
   Meanwhile the eligible claims `classifyEligibilityBatch` would have returned are silently
   dropped either way, since `classifyEligibility` had already thrown before they could be used.
   Fixed with a shared `abandoned` flag, checked before each chunk and before the final write —
   Promise.race still can't stop in-flight work, but it stops that work's *effects* from landing
   once the race is already lost.
2. **§6's rewrite only covered the primary VERIFY write site.** `reconcileContradictedVerdicts` and
   `guardEscalatedContradictionReversals` (both in `pipeline.service.ts`) hit the identical shape —
   downgrade to `unsupported`, `citations: []`, and a carried-over `reason` written when the verdict
   was still affirmative or contradiction-asserting. Confirmed live in this repo's own existing
   tests: one fixture's reason already reads *"The passage states the tower was completed in 1887,
   contradicting the claimed 1889 date"* right before being downgraded to `unsupported` — the exact
   incoherence this ADR exists to fix, just not caught by the diff's original single call site. Both
   sites now route through the same `rewriteUngroundedAffirmativeReason`.

One finding was surfaced and deliberately left as-is: `AFFIRMATIVE_SOURCE_LANGUAGE_RE` is regex over
VERIFY's own reason prose, and a reviewer angle argued this doesn't cleanly fit AGENTS.md rule 12's
"closed, enumerable format" carve-out the way currency/UUID/date-shape regexes do — reason text is
open-ended LLM prose, not a closed format. The counter-argument in §6 (closed, *prompt-shaped*
vocabulary rather than open-ended classification) is a real distinction but a narrower one than the
rule's own examples suggest. Left in place because the failure modes are safely bounded either way
(a miss leaves today's incoherent-but-not-wrong-verdict text; a false positive swaps one honest
sentence for another — never a verdict-correctness risk) — but noted here as a genuine judgment call
rather than a settled one.

## §7. Explicitly not doing

- **Not fixing the retrieval/extraction bugs the same live run surfaced** — a false `contradicted`
  on two true Apple-earnings claims (unresolved "the same quarter of the previous year" reference),
  and refuting evidence retrieved at the page level but dropped at the sentence-selection level
  (Falcon Heavy vs. Atlas V). Both are reasoning/retrieval behavior changes with a materially
  different risk profile than the containment fixes here, and both need their own verification path
  (a live golden-set re-run for the EXTRACT prompt change; telemetry sized before building a
  sentence-selection rescue). Tracked separately, not bundled into this ADR.
- **Not adding a run-level "failed" write to `GrounnelStore`** — would close the §2 asymmetry more
  directly, but `GrounnelStore`'s interface has no run-level failure setter today, only per-claim
  `writeClaimResult` and the `escalating` flag; adding one is a real fix but a separate, larger
  interface change. §3's read-time self-heal covers the user-visible symptom without it.
- **Not touching `reason_ordinal` or any other gate in the deterministic chain** — this run's g17
  failures were already traced upstream, to retrieval/extraction, not to gate logic. Adding more
  gate sophistication here would be fixing the wrong layer.

## Consequences

- `src/persistence/grounnel-store.ts`: `STUCK_RUN_TIMEOUT_MS` (renamed), `getStatus()`'s staleness
  computation and status formula now also cover the not-fully-checked case.
- `src/orchestrators/grounnel/extract.service.ts`: `ELIGIBILITY_PHASE_TIMEOUT_MS`, timeout race
  around `classifyEligibility`'s work, entry/exit `logger.info` calls.
- `src/orchestrators/grounnel/gates.ts`: `rewriteUngroundedAffirmativeReason`, exported, pure.
- `src/orchestrators/grounnel/pipeline.service.ts`: three call sites — `processVerifyResults`
  (primary), `reconcileContradictedVerdicts`, `guardEscalatedContradictionReversals` (§6b).
- `tests/unit/persistence/grounnel-store.test.ts`: one existing test's expectation updated
  (stale-and-incomplete now asserts `"failed"`, not `"verifying"`); new tests for the
  `createdAt`-fallback case and the fresh/0-claim non-trigger cases.
- `tests/unit/orchestrators/grounnel/extract-service.test.ts`: new timeout test, plus a
  §6b regression test for the abandoned-batch late-write bug.
- `tests/unit/orchestrators/grounnel/gates.test.ts`: new describe block, full predicate matrix.
- `tests/unit/orchestrators/grounnel/pipeline-service.test.ts`: two existing tests (one per §6b
  reconciliation call site) gained a `claim.reason` assertion proving the rewrite fires there too.

**Source**: `biassemble-core` branch `012-gr-upd2`, 2026-08-22. Live run IDs: the stalled run is
`797b2eea-0cdb-4f6a-a1a8-a8cbded414ff`; the incoherent-reason run is `566d8e44-0ccf-4662-8bd5-67873db2313e`.
