# T21 — instance-attribution prompt bake-off

Job `attribution-experiment`, Gemini, temp 0, 16 fixtures × 4 variants, N=1 (2026-08-27).
Fixtures were in `src/jobs/attribution-experiment.ts` (deleted in T29 once the fix was live; recoverable from git history); passages `r1`–`r4` are the real g17 retrieval set.

## Result

| Variant | Accuracy | false `different` | fabricated citation |
|---|---|---|---|
| **c-expanded** | **16/16** | 0 | 0 |
| a-neutral | 15/16 | 0 | 1 |
| b-conflict-framed | 15/16 | 0 | 1 |
| d-minimal | 15/16 | 0 | 0 |

Only miss for a/b/d: `s2-both-members-same-value` — two passages each explicitly naming a
different member, answered `same` instead of `conflict`. c-expanded is the only variant that
keeps genuinely disagreeing sources from being silently resolved.

**Winner: c-expanded** — neutral wording plus a forced 4-step `working` field.

## Does it fix g17

Yes, when retrieval returns the explicit passage. All four variants:

- `r1-g17-realistic-mixed` (vague **+** explicit passages, as production sends them) → `different` → `contradicted`
- `r2-g17-realistic-vague-only` (control) → `absent` → abstain, no guessing
- `r4-explicit-same-plus-vague` (control) → `same`, so it is not biased toward `different`

## What changed the outcome

Two edits between the first (12-fixture) run and this one:

1. **Realistic multi-passage fixtures.** The first run fed passages one at a time, which
   production never does. Every variant answered `absent` on g17 — an artifact of the harness.
2. **"Explicit outranks vague" rule** added to all four variants. This alone flipped c-expanded
   from disqualified (false `different` on the ambiguous case) to perfect. The earlier reading —
   "forced reasoning makes it less safe" — was wrong: the prompt was underspecified, and once the
   rule was stated, reasoning became the best variant.

## Caveats

- N=1, deterministic draw; answer key authored in-repo, so 16/16 partly measures agreement with it.
- `fabCite` is not attributed to a fixture — the harness records the fixture id only when the
  *attribution* is also wrong, so a fabricated citation on a correct answer is invisible.
- The bake-off gave each fixture **one claim**. Production batches several claims over one shared
  passage set — see the live run below, where that is exactly what broke.

## Implemented (commit 76b78d6, deploy eyvpbqew7)

`c-expanded` shipped as `instance-attribution/system.json` v2.0.0 and wired as a second auditor:

- Fires from `processVerifyResults` for every non-`contradicted` claim whose text names a sequence
  instance (`extractInstanceSelector`) — trigger is the selector, not the verdict, because g17
  failure #1 returned `supported`.
- Runs **alongside** the consistency classifier, not instead of it. Routing ordinal claims away
  from it removed the retry safety net from the riskiest claims; four tests caught that.
- Feeds the `instance_attribution` gate, placed after `reason_ordinal` and before gate #1 so a
  forced `contradicted` still has to clear the evidence check.
- `different` → `contradicted`; `conflict` → `unverifiable` (affirmative verdicts only);
  `same`/`absent`/null → no-op. Uncitable `different`/`conflict` is dropped at the call site.
- Skips `unverifiable` (a confidence downgrade), and its contradictions are protected from
  reconciliation the same way `reason_ordinal`'s are.

## First live run (g17 + g22, 6 calls, 13 gate events)

| Claim | Checker | Final |
|---|---|---|
| "The **first** flight covered 852 feet" (false) | `different` ✅ | `contradicted` ✅ |
| "The **first** flight lasted 59 seconds" (false) | `same` ❌ | `unverifiable` |
| "The **fourth and final** flight… 852 feet" (true) | `same` ✅ | `unverifiable` ❌ |
| 4 other true claims | `same` ✅ | `supported` ✅ |

Zero false accusations. Two things this run does **not** show:

1. **It did not cause the g17 catch.** `reason_ordinal` flipped that claim to `contradicted`
   earlier in the chain, so this gate no-oped. It agreed; it did not add catch.
2. **g22 is untouched.** The checker answered correctly (`same`); `subject_entity` downgraded the
   claim anyway, later in the chain.

## Root cause of the miss: schema field order (fixed)

The miss was not a checker weakness. The model reasoned correctly and then emitted a contradicting
answer. Its own `working` on that claim ends:

> "…the passages do not attribute the FACT to the CLAIM's member… **Therefore, the attribution is
> absent.**"  → emitted `attribution`: **`same`**

Across persisted production calls, **3 of 9** answers with a stated conclusion contradicted their
own reasoning.

Cause: Gemini generates structured-output fields in schema order.

| | field order |
|---|---|
| Bake-off schema | `id, `**`working`**`, attribution, citation` |
| Production schema as first shipped | `id, `**`attribution`**`, citation, working` |

So production committed to the answer *before* writing the reasoning — inverting the forced-reasoning
step that made `c-expanded` win the bake-off. The prompt was never the problem; the wiring was.

Fixed by reordering the Zod schema, plus a converter test locking declaration order. `propertyOrdering`
(the REST field that would make this explicit) was **not** shipped — it cannot be verified from this
machine, which is geo-blocked from the Gemini API, and a wrong guess breaks every call.

Not yet re-run live: the fix is unproven until g17 comes back with the 59-second claim no longer `same`.

## Open

- **Re-run g17 + g22** to confirm the field-order fix. Pass condition: the 59-second claim stops
  coming back `same`. Everything below is worth less until this lands.
- **Multi-claim fixture.** Several claims sharing one passage set, mixing true and false instance
  claims in the same batch — the unsafe direction is a true "fourth flight" claim getting
  `different`. Run it AFTER the fix, or it measures the field-order bug instead.
- **Deterministic citation-vs-claim check** (held): the checker's own citation names a member; the
  claim names one too. Comparing them is free and would have caught this miss. Simulate on persisted
  traces before writing it — if it produces false `different`s on historical `same`s, it dies.
- **Does the gate add catch?** Unproven. Every live `different` so far was on a claim
  `reason_ordinal` already caught. Needs a case where the reason carries no ordinal.
- **g22 / `subject_entity`** downgrades a true claim its own reason confirms. Separate from T21.
- `conflict` has never fired live; only c-expanded got it right in the bake-off.
