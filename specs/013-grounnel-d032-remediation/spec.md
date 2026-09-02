# Spec: Grounnel D032 Remediation — bounded fixes and gated measurements

Source of truth for scope: [D032](../../docs/decisions/032-grounnel-failure-taxonomy-and-rework-vs-fix.md)
(including its §8 review round). This spec implements **only** D032's "fix now" tier plus the
measurements that gate the rest. The rework candidates R1–R4 are explicitly out of scope.

## Assumptions

Stated up front, per the `spec-driven-development` skill's Phase 1. **Correct these before
implementation begins** — three of them can invalidate whole work items.

1. ~~Contract A will be ratified~~ **RATIFIED (2026-08-26).** Every scoring change in SC-6 depends
   on it; T9 unblocked.
2. **`unsupported` remains the correct verdict for a false-but-unsupported claim** (D032 §7 Q2,
   answered). FIX-2 assumes we are improving the *explanation*, not the verdict. *If reversed, FIX-2
   becomes R1 and this spec is the wrong shape.*
3. **The frontend can be coordinated for a verdict-enum change.** FIX-1 adds a value to a shared
   contract. *If the frontend cannot be changed in the same window, FIX-1 ships backend-only and the
   frontend keeps reading `reason` until it catches up — acceptable, but must be a decision, not a
   surprise.*
4. **This work is measurement-gated, not deadline-gated.** Three items (FIX-3, FIX-4, FIX-5) cannot
   start until their gating measurement passes. That is the point, not an obstacle.
5. **No new LLM call is added to the per-claim hot path** except FIX-3's query reframing, which
   replaces an existing search rather than adding one. Budget context: D032 §3e.

## Objective

Close the bounded, low-risk failures identified in D032 §4, and produce the measurements that decide
whether the higher-risk items are worth building at all.

**Users:** `biassemble/backend` (API consumer) and the engineers operating Grounnel's telemetry.

**Success looks like:** exclusion is distinguishable from failed verification in both the API and
`grounnel_claims`; a user reading an `unsupported` verdict understands it is not a finding of
falsehood; negatively-phrased claims are verifiable; and the three deferred decisions
(prediction policy, reranker authority, superlative detector) each have a number attached instead of
an argument.

**Explicit non-goal:** improving the headline score. D032 §2 shows the 52%/77% gap is a rubric
disagreement; this spec does not chase either number.

## Scope

### Fixes

| ID | Item | D032 ref | Gate before starting |
| --- | --- | --- | --- |
| FIX-1 | `excluded` verdict value | §4 #8/#9 | §7 Q3 — frontend `reason` handling |
| FIX-2 | Enriched `reason` on `unsupported` | §5 (replaces R1) | none — lowest risk item |
| FIX-3 | Negative-claim query reframing | §4 #4 | MEASURE-3 (golden subset must exist) |
| FIX-4 | Superlative-qualifier prompt extension | §4 #1 | MEASURE-1 (failure must reproduce) |
| FIX-5 | Prediction exclusion policy | §4 #7 | MEASURE-2 (misclassification rate) |

### Measurements (these gate the fixes above and the reworks in D032 §5)

| ID | Question it answers | Gates |
| --- | --- | --- |
| MEASURE-1 | Does case #1 reproduce at N≥10, or was it one draw? | FIX-4 |
| MEASURE-2 | What fraction of `prediction`-classified claims are genuinely checkable? | FIX-5 |
| MEASURE-3 | Do negative claims fail systematically, or was #4 isolated? | FIX-3 |
| MEASURE-4 | Does rerank systematically prefer lexical density over source authority? | D032 R4 → R3 |

### Out of scope

- **R1 (symmetric refutation)** — D032 §5 decided against it on principle. Do not build.
- **R2 (`subject_entity`)** — D030 §3m; deliberately unfixed, 4/4 candidate fixes refuted.
- **R3 (predicate-structure detector)** — blocked behind MEASURE-4 by D032 §5's ordering correction.
- **R4 implementation** — MEASURE-4 characterises it; changing the reranker is a separate decision.
- **Removing `CONFIDENCE_THRESHOLD`** — withdrawn (D032 §3b correction): it shapes the VERIFY
  prompt, so removal is a behaviour change, not a refactor.

## Tech Stack

Unchanged from the repo. TypeScript/Node ESM, Fastify 5, Zod 4, Drizzle + Postgres, Upstash Redis,
Gemini (`gemini-2.5-flash-lite`), Tavily, Inngest, Vitest. No new dependencies.

## Commands

```
Typecheck:   npx tsc --noEmit
Test:        npx vitest run
Test (one):  npx vitest run tests/unit/orchestrators/grounnel/gates.test.ts
Migration:   pnpm db:generate     # then hand-verify SQL, see .skills/drizzle-migrations.md
Live eval:   pnpm tsx scripts/trigger-eval-grounnel.ts --cases <ids> --repeats N
Live smoke:  POST https://biassemble-core.vercel.app/extract  (Bearer $AI_CORE_API_KEY
             + ?x-vercel-protection-bypass=$VERCEL_BYPASS_TOKEN), then poll /status/:id
Review:      /code-review medium current changes
```

Postgres from this sandbox requires the SOCKS forwarder — outbound TCP is proxy-only:
`python3 scratchpad/socks_forward.py 15432 aws-1-eu-central-1.pooler.supabase.com 6543`

## Project Structure

```
src/contracts/grounnel.schemas.ts          Zod contract — GrounnelVerdictEnum (FIX-1)
src/db/schema.ts, src/db/queries.ts        Drizzle schema + verdict enum (FIX-1)
src/db/migrations/                          generated SQL (FIX-1)
src/orchestrators/grounnel/
  extract.service.ts                        writeExcludedClaim (FIX-1), eligibility wiring (FIX-5)
  claim-eligibility.ts                      isEligibilityExcluded policy (FIX-5)
  pipeline.service.ts                       writeNoEvidence reason text (FIX-2), search (FIX-3)
  gates.ts                                  rewriteUngroundedAffirmativeReason (FIX-2)
src/prompts/grounnel/verify/system.json     QUALIFIED RANK section (FIX-4)
evaluations/golden/grounnel/
  live-eval-golden-set.json                 new cases for MEASURE-1/-3
tests/unit/orchestrators/grounnel/          unit tests
scratchpad/ (untracked)                     measurement scripts — not shipped
```

## Code Style

Existing conventions (CLAUDE.md). Comments max ~200 chars, stating what/why and pointing at the ADR
section rather than restating it:

```ts
// D032 §4 #4 — a negative claim can't be confirmed by a support-seeking search; query the positive
// form and let VERIFY evaluate the negation against it. Adds no `contradicted` surface (D032 §5).
function reframeNegativeClaim(claimText: string): string | null { ... }
```

Gate/policy functions stay pure and synchronous where the existing chain is
(`pipeline-gate-chain.ts` is pure/sync/no-I/O by design — D025 §2). Enum additions are made in all
declaration sites at once (Zod contract, `db/schema.ts`, `db/queries.ts`, persistence types) — the
established pattern from the `retry_decision` addition.

## Testing Strategy

Vitest. **Coverage is capped at ~60% repo-wide and is not a target** (CLAUDE.md): default to *not*
adding a test. Specifically for this spec:

- **Add unit tests for:** FIX-1's enum handling and FIX-3's reframing predicate — both are pure
  orchestration/contract logic, the category CLAUDE.md says is worth testing.
- **Do NOT add unit tests for:** FIX-2 and FIX-4. These are prompt/LLM-behaviour changes; the repo's
  rule is to verify those with a live golden-set re-run, not a hand-written fixture.
- **`gates.ts` stays exhaustively tested** — it is pure and costs nothing to run.
- **Every measurement (MEASURE-1..4) runs at N≥10** where it produces a rate. D030 §3k: this
  pipeline is stochastic; a single run is a draw, not a result.
- **Regression protection:** any fix landing must not reduce the golden set's hard safety gate —
  zero `contradicted` on true claims, across every repetition.

## Boundaries

**Always:**
- Simulate a candidate fix against persisted historical telemetry before writing production code
  (D030 §3n; 4/4 `subject_entity` fixes died at this step).
- Run `npx tsc --noEmit` and the full suite before proposing a commit.
- Run `/code-review` on the diff before shipping.
- Quote rates only at N≥10.

**Ask first:**
- Any change to `GrounnelVerdictEnum` (shared contract — FIX-1).
- Any change to a prompt under `src/prompts/` (behaviour change requiring live re-verification —
  FIX-4, and FIX-2 if the reason text moves into a prompt).
- Reversing a documented ADR policy (FIX-5 reverses D030 §3b).
- Applying a DB migration.
- Any commit whatsoever.

**Never:**
- Build R1–R4 under this spec.
- Remove `CONFIDENCE_THRESHOLD` as "dead code" (D032 §3b correction).
- Introduce a code path that can produce `contradicted` from *absence* of evidence.
- Add a hand-maintained keyword whitelist over free English (D030 §1, already reverted once).
- Optimise for gate fire rate (D032 §3a).

## Success Criteria

Numbered so tasks can cite them.

- **SC-1** — A claim excluded by the eligibility filter is distinguishable from a claim that was
  checked and could not be verified, in both the API response and `grounnel_claims`. Verified by a
  live smoke request containing one opinion and one genuinely-unverifiable claim.
- **SC-2** — An `unsupported` verdict's user-facing `reason` states that no supporting evidence was
  found **and** that this is not a finding of falsehood. Verified by reading the stored `reason` for
  a known no-evidence claim.
- **SC-3** — For a negatively-phrased claim whose positive form is well documented
  (e.g. "Microsoft did not create the iPhone"), the pipeline returns `supported` rather than
  `unverifiable`, in ≥8 of 10 repetitions.
- **SC-4** — The case-1 fixture ("first computer mouse was wireless") returns `contradicted` or
  `unsupported` — never `supported` — in **10 of 10** repetitions. This is a false-affirmation case;
  the bar is absolute, not a rate.
- **SC-5** — No regression: across the full golden set at N≥5, zero `contradicted` verdicts on
  claims marked `kind: true`, and the detection rate is not below its pre-change value.
- **SC-6** — The evaluation harness scores against the ratified extraction contract, and the
  contract is stated in the golden set's own documentation so a future reviewer applies the same
  rubric. *(Depends on Assumption 1.)*
- **SC-7** — Each of MEASURE-1..4 produces a written number in D032 or a follow-up ADR section, with
  N stated. A measurement that does not change a decision must say so explicitly.

## Open Questions

1. ~~Contract A ratification~~ **ANSWERED (2026-08-26): Contract A ratified** (D032 §7 Q1). SC-6
   unblocked.
2. ~~Frontend `reason` handling~~ **ANSWERED (2026-08-26): no, frontend switches on `verdict` alone**
   (D032 §7 Q3). FIX-1 ships backend-first; frontend styling tracked separately as tasks.md T16.
3. **Does `excluded` belong in `GrounnelVerdictEnum`, or as a separate `status`?** A claim that was
   never checked arguably has no *verdict* at all. The enum is the smaller change; a status field is
   arguably the more correct model. Not decided — affects FIX-1's shape.
4. **FIX-2 wording ownership** — is the user-facing "this is not a finding of falsehood" phrasing a
   backend string, or does the frontend own presentation? Affects whether FIX-2 is a one-line
   constant change or a contract change.
