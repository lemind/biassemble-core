# T21 — instance-attribution prompt bake-off

Job `attribution-experiment`, Gemini, temp 0, 16 fixtures × 4 variants, N=1 (2026-08-27).
Fixtures in `src/jobs/attribution-experiment.ts`; passages `r1`–`r4` are the real g17 retrieval set.

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
- Not wired: no call site, no verdict mapping, no live golden-set run. Per D030 §3n the wiring
  decision is separate from this measurement.

## Open

- `conflict` still fails 3 of 4 variants; only c-expanded handles it.
- Trigger design: firing the second call only on a non-`supported` verdict would **miss** g17
  failure #1, which returned `supported` off a fabricated reason. Trigger on "claim selects an
  instance" instead of on the verdict.
