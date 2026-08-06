# D022 — Grounnel Post-P0 Hardening: Real-Call Golden-Set Gate, Bugs It Found, and the Reason-Consistency Gate Family

Four parts: promoting D019 §2's "one hand-run set" methodology to a repeatable, real-call golden-set gate (§1); the concrete production bugs that gate surfaced and their fixes (§2); the VERIFY prompt rewrite and the honest empirical finding that a prompt-only fix did not close two of the golden set's known failures (§3); and the planned code-side gate for one of those two remaining gaps, including why the other is deliberately not being built yet (§4).

Source: this repo's `evaluations/golden/grounnel/live-eval-golden-set.json`, real Vercel/Inngest production logs pulled via `vercel logs` across several live runs on 2026-08-06, and `src/orchestrators/grounnel/gates.ts` / `src/parsers/repair.ts` as shipped.

---

## §1. Real-call golden-set gate, promoted from "one hand-run set"

**Decision**: Grounnel gets a repeatable, non-mocked evaluation harness — a checked-in golden set (`evaluations/golden/grounnel/live-eval-golden-set.json`, 11 cases) scored by pure functions (`src/evaluation/grounnel-live-gate.ts`) and run for real against live Gemini + Tavily by a shared core (`src/evaluation/run-grounnel-eval.ts`), with two entry points: a local CLI (`scripts/eval-grounnel.ts`, `pnpm eval:grounnel`) and an Inngest job (`src/jobs/eval-grounnel-run.ts`, triggered via `scripts/trigger-eval-grounnel.ts`) so the same real-call check can run from a deployed environment, not just a developer machine with working credentials.

This supersedes spec.md's Testing Strategy line: *"Not covered by automated tests at P0: real Tavily calls, real Redis — those are the one manual/live check before shipping... a small hand-run set, not a golden set, promoted to one once the harness exists per v10 §9."* The harness now exists; the promotion has happened.

**Why**: D019 §2's whole premise is that gates need an independent artifact to check a tool's output against. The gates themselves had that (passage text, substring matching). The *pipeline as a whole* didn't have an equivalent for its own output — nothing independently checked "did VERIFY's actual verdict match ground truth on a real claim," only unit tests against fixed inputs and mocked providers. A golden set with known-true/known-false/known-silent claims and real API calls is that missing independent check, applied one level up from the gates to the pipeline itself.

Scoring contract (`grounnel-live-gate.ts`): each golden case has `claims: ExpectedClaim[]` (`match` substring + `kind: "true" | "false" | "silence"`), an `ACCEPTABLE` map (`true` → `[supported, partially_supported]`, `false` → `[contradicted]`, `silence` → `[unsupported, unverifiable]`), and a `minCorrectRate` per case. `Violation{rule: "no_false_accusation"}` fires whenever a `kind: "false"` expected claim is *not* found among the run's contradicted claims and something else was marked `contradicted` in its place with no textual match — this is the one violation type that blocks regardless of `minCorrectRate`, matching the prompt's own CORE PRINCIPLE ("false positives are worse than false negatives") and D019's product framing throughout.

**Do not**: mock the provider for this specific suite — the entire point is exercising the real Gemini/Tavily failure modes (rate limits, malformed JSON, bare-array responses — see §2) that a `MockProvider` cannot produce. Treat this suite's pass rate as a release gate in CI (it costs real API quota and takes real wall-clock time per run) — it stays a manually/Inngest-triggered check, not wired into `.github/workflows/test.yml`, which stays mock-only per its own zero-real-secret design.

**Consequences**: every case in the golden set below is now a standing, re-runnable check — a future prompt or gate change gets validated against the same 11 cases, not re-litigated from scratch each time (see §4's validation criterion, which depends on this existing).

---

## §2. Bugs the golden set found in real production runs, and their fixes

Three real bugs, found via `vercel logs` on actual Inngest-triggered runs against live Gemini/Tavily — not reasoned about, reproduced from real payloads:

1. **`repair.ts` — bare-array response.** Asked for `{results: [...]}}`, Gemini sometimes returns `[...]` directly (confirmed identical on all 3 retries for one real claim batch). Zod correctly rejected it as the wrong shape; `partialParseObject`'s documented null-on-unsalvageable-field behavior then read the keyless array as an object with no `results` field, silently discarding valid data as `null`. Fixed generically — `unwrapBareArrayResponse()` in `repair.ts`, scoped narrowly to schemas with exactly one array-typed top-level field (avoids ambiguity for multi-field schemas) — shared infrastructure, not Grounnel-specific, since `extract.service.ts`'s `isValid` guard already existed but `pipeline.service.ts`'s `runBatch()` didn't (added as defense-in-depth alongside the real fix).
2. **`applyNumericGate` — no threshold-comparison support.** "Apple's market cap surpassed $3.5 trillion" against evidence "$3.57 trillion" was marked `contradicted` (3.5 ≠ 3.57) instead of `supported` (3.57 exceeds the claimed threshold). The gate only used `compare()`'s `equal` field; `direction` (`-1|0|1`, already computed) was unused. Fixed with `AT_LEAST_RE`/`AT_MOST_RE` claim-language detection plus a direction-based check (golden-set case `g11-bloomberg-fallback`, which also deliberately exercises the Tavily-fallback path per D021).
3. **`applyReasonConsistencyGate` (new) — verdict/reason binding mismatches.** VERIFY's own `reason` sometimes explicitly states a contradiction ("directly contradicting the claim") while `verdict` doesn't match it. Fixed by reusing `CONTRADICTION_LANGUAGE_RE`/`NEGATED_CONTRADICTION_RE` from `src/orchestrators/audit/verify-reconcilers.ts` (exported, previously private) — years of incident-driven tuning already exist there, not reinvented. Confirmed against golden-set case `g04` (WWII end date)'s real text: fixes the binding mismatch. **Confirmed, via the same real case, to not fix everything** — see §3/§4.

**Why reuse, not new regex**: same reasoning as D019 §2's gate #2 — `CONTRADICTION_LANGUAGE_RE` is proven production code from the audit product's own incident history; writing a second, Grounnel-specific contradiction-language regex would mean re-discovering its false-positive edge cases (hedge phrases, negated comparisons) instead of inheriting fixes already paid for.

**Consequences**: `pipeline.service.ts`'s gate order is now confidence-threshold → `applyReasonConsistencyGate` → gate #1 (contradiction-evidence) → gate #2 (numeric). Reason-consistency runs first deliberately: a verdict it flips to `contradicted` still has to clear gate #1's real evidence-substring check, not bypass it — a forced verdict is not exempt from the trust boundary (D019 §2) just because the force came from code rather than the model.

---

## §3. VERIFY prompt v2.0.0 — rewritten, and the case-level result

**Decision**: VERIFY's system prompt (`src/prompts/grounnel/verify/system.json`) was rewritten from prose-based rules to an explicit STEP 1→2→3 decision procedure (passage fact → relationship classification [SAME/PARTIAL/CONFLICT/ABSENT] → fixed verdict mapping), worked consistency examples (including one matching golden-set case `g05`'s exact wording), a numeric-relationship table, and deterministic evidence-quoting rules. Deployed and validated against the real golden set, not just reasoned about.

**Result, stated plainly rather than rounded up**: real before/after runs against the two cases the rewrite specifically targeted —

- **`g05`** ("gift from Canada" claim, "gift from France, not Canada" passage): byte-identical `reason` text, identical wrong verdict (`unsupported`, should be `contradicted`), before and after the rewrite — including a worked example in the new prompt matching this input almost word-for-word. **Confirmed prompt-resistant.**
- **`g04`** (WWII end-date claim): the *binding* failure (reason said "directly contradicting," verdict didn't match) is fixed — by §2's code-side gate, not the prompt rewrite; a real before/after showed the prompt rewrite changed this case's failure mode from a binding mismatch to an internally-consistent-but-still-wrong classification (reason and verdict agree with each other, both still wrong — the passage's real conflict is misclassified as ABSENT).

Aggregate: 0 false accusations held across every run this session regardless of prompt version — the metric the product cares about most has not regressed at any point.

**Why this is recorded as a decision, not just a changelog entry**: it's a negative result worth keeping precedent for. A prompt rewrite that includes a near-verbatim worked example of the failing case, deployed and measured against real API calls (not assumed from the prompt text alone), produced zero change on that case. This is the same "measure, don't assume" discipline D019 §3 established for the native-search benchmark — recorded here so a future contributor doesn't re-attempt "just improve the prompt wording" on `g05` without knowing it was already tried, specifically, and confirmed not to work.

**Do not**: revisit `g05` via further prompt tuning as the first move — §4 exists because this was already ruled out empirically, not because it wasn't tried.

---

## §4. Case A gate (planned) and Case B (deliberately not built yet)

**Decision**: build one new gate for Case A (`g05`-shaped bare "X, not Y" negation with no contradiction verb); do not build anything for Case B (`g04`-shaped multi-date role misclassification) until a separate investigation step, run first, shows it's worth it.

### Case A — the claim entity extractor gate

A gate distinct from `applyReasonConsistencyGate` (different inputs — needs `claimText` and `passageText`, not just `verdict`/`reason`), same file (`gates.ts`), three required conditions:

1. `reason` matches `,\s*not\s+<short phrase>` → extract `Y`.
2. `Y` word-boundary-matches inside `claimText`.
3. **Claim entity extractor**: at least one capitalized entity span from `claimText`, other than `Y`, appears in `passageText`.

Condition 3 is named "claim entity extractor," not "proper noun detector" — it extracts candidate entities specifically from the claim text to use as a second-party discriminator against the passage, which is a narrower and more accurate description of what it does than general NER framing would suggest.

**Condition 3 is a conservative heuristic, not the fundamental correctness criterion — this is deliberate, not an oversight.** It trades recall for precision on purpose: a single-entity claim ("the winner was Bob, not Alice") has no second entity to check, so the gate abstains (leaves the verdict unchanged) rather than fire on weaker evidence. This is a direct application of the prompt's own CORE PRINCIPLE ("false positives are worse than false negatives") and D019 §2's "decline rather than guess" precedent (the row/cross-metric reconciler in the audit product follows the same shape) — **do not weaken condition 3 to raise recall.** A future contributor who finds a single-entity case this gate misses should treat that as the accepted cost of this design, not a bug to patch by loosening the match.

**Validation criterion for shipping this gate**: run the real golden set before and after. `g05` must flip from `unsupported` to `contradicted`. Every case that has been stable and byte-identical across every real run captured so far — `g01, g03, g06, g07, g08, g09, g10` — must remain byte-identical; any change to any of those blocks the change from shipping. `g02`, `g04`, and `g11` are excluded from this strict identity check: real runs this session showed each of them changing verdict across successive runs with **zero code changes in between** (pure model non-determinism, not regression), so holding them to a byte-identical bar would false-block on noise the gate has no way to control. `falseAccusations` staying at `0` is non-negotiable regardless of which case it comes from.

### Case B — investigate first, do not build

`g04`'s real gap is a classification error, not a binding error: the passage contains two years (WWII start 1939, end 1945) in the same comparison sentence, and the model picks the wrong role. No reason-parsing gate touches this — it needs either a more precise passage (retrieval-side) or a genuine multi-date role-resolution capability neither prompting nor a string-matching gate provides on its own. `reconcileTemporalVerdict` (`verify-reconcilers.ts:797`) was checked and confirmed out of scope — it's `QUARTER_RE`-scoped to fiscal-quarter claims, not bare-year claims, and can't be directly ported.

Before building anything: grep the golden set and any captured real fixtures for how many bare-year claims have a passage containing 2+ years in the relevant sentence. One case (just `g04`) → don't build a gate for it, log the gap as a scoped-out known limitation instead. More than one → a real, separate ADR and plan, not bundled into this one.

**Why**: D019 §2's trust boundary needs a genuine independent artifact to check against; for Case A that artifact is the claim text itself (condition 3). For Case B, no such cheap deterministic check exists yet — building one without first measuring how often the failure shape recurs risks over-engineering a gate for a single golden-set case rather than a real, recurring product gap.

**Consequences**: this ADR's Case A gate is additive to the gate chain in §2 (runs alongside, not instead of, `applyReasonConsistencyGate`). Case B remains a named, tracked gap — not silently dropped — until the investigation step above resolves it one way or the other.
