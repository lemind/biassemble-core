# Grounnel live eval — minimum golden set

19 cases, `live-eval-golden-set.json`, in the same spirit as `evaluations/golden/audit/live-eval-fixtures/`: a real, live run of the actual pipeline (`GrounnelExtractService` + `GrounnelPipelineService`) against real Gemini (EXTRACT, VERIFY, `google_search` discovery) and a real Tavily fallback — no mocks, no recorded/replayed responses for the run itself.

## Labeling discipline

Same rule as `evaluations/golden/audit/README.md`: every case's expected `kind` (`true` / `false` / `silence`) was written before the script ever ran against it, based on independently verifiable public facts (6 true, 4 false, 1 fabricated/obscure for the silence case) — not adjusted afterward to match whatever the model produced.

`g17-wright-brothers-ordinal` (added D030, tasks.md T008) restores the intent of the original
`g15-wright-brothers-ordinal` — deliberately removed (see D030 §1) when the fix attempt it was
validating (a `SEQUENCE POSITION` VERIFY prompt section) failed live 2/2 and was reverted. This case
exercises the real fix instead: `applyReasonOrdinalGate`, a deterministic gate reading VERIFY's own
`reason` text for a differing ordinal, not a prompt instruction. The article deliberately misattributes
the Wright Flyer's fourth-and-final-flight distance (852 ft / 59 s, real historical figures) to the
first flight — real web sources state the first flight actually covered ~120 ft in 12 seconds, so a
live run should find that contradiction and land on `contradicted`.

`g18-eligibility-personal-exclusion` and `g19-eligibility-hard-negatives` (added D030 §3b, tasks.md
T015) exercise `classifyClaimVerifiability`, the pre-search LLM eligibility classifier. Two new
`kind` values back them (`grounnel-live-gate.ts`) — `silence`'s existing `["unsupported",
"unverifiable"]` pair can't tell "correctly excluded pre-search" apart from "searched, found
nothing," which is exactly the ambiguity FR-008 exists to eliminate:
- `excluded` (only `unverifiable` is acceptable) — g18 reuses the real user report that motivated
  this whole feature verbatim ("In 2023, I was in need of a new laptop that should hopefully last
  me for a while," specs/009-grounnel/tasks.md's backlog entry) — a private circumstance with no
  public record, must be excluded pre-search, not searched-and-found-empty.
- `not_excluded` (`unverifiable` is the one unacceptable outcome) — g19's Fleming/penicillin claim
  is a real, well-documented historical fact phrased as an attributed quote (`"I discovered
  penicillin in 1928," said Fleming`); the birth-year claim is a checkable personal fact about a
  named public figure. Both are first-person-shaped but plainly checkable — the whole point of
  `certainty`/`personal`-is-not-non-checkable (data-model.md §2) — and must reach search, not get
  excluded on grammar alone. **Open, not yet confirmed** (blocked on live deploy access, same as
  T016/T018): whether `GrounnelExtractService`'s EXTRACT step actually produces a `sourceExcerpt`
  for the Fleming claim that includes the `"said Fleming"` attribution clause — if it doesn't, the
  classifier has no way to make the correct call regardless of prompt quality (T015's own explicit
  concern), and that would be a real gap in EXTRACT's excerpt-matching, not this classifier.

`g20-apple-earnings-year-over-year` (added D031 §7, follow-up fix) targets the EXTRACT prompt fix, not a
gate. A real live-API run this session (not a hypothetical) came back `contradicted` on both
`94.04 billion` and `23.43 billion` — Apple's real fiscal Q3 2025 revenue and net profit, verified
independently via web search before writing this case. The article states them as "the same
quarter the previous year" relative to "third fiscal quarter 2026," with no literal year in that
sentence; retrieval matched the boilerplate "year-ago quarter" phrasing in unrelated 2021/2022
earnings articles instead. `system.json` v1.6.0 extends the EXTRACT self-contained-claim rule from
pronouns/bare-descriptions to relative time/comparison references — this case is the regression
guard. `109.4 billion` (the current quarter's own figure, never confused in the live run) is
included as a control: the fix must not regress correct current-period matching.

`g11-bloomberg-fallback` is the one other case deliberately targeting a different thing than a true/false/silence label: `HybridSearchProvider` only calls Tavily when *every* DIY candidate (Gemini `google_search` discovery + direct fetch) fails for a claim — none of g01–g10 are designed to force that, so the fallback path had zero deliberate coverage. `bloomberg.com` commonly blocks non-browser fetches (403/unreachable), and the fact itself (Apple's market cap) is widely corroborated elsewhere, so Tavily has a real shot at resolving it. **Not guaranteed** — this repo has no per-claim provider-attribution field, so whether it actually fell back to Tavily on a given run has to be confirmed from logs (`"DIY fetch failed for every candidate — falling back"`), not from the eval's JSON output alone.

## Running it

Two ways to trigger the same real-call logic (`src/evaluation/run-grounnel-eval.ts`, shared by both):

```
pnpm eval:grounnel [--min-correct-rate 1.0]                  # local CLI — runs in this process, writes fixture files
pnpm eval:grounnel:trigger [--min-correct-rate 1.0]           # fires the "eval-grounnel-run" Inngest job on the deployed app
```

Requires `GEMINI_API_KEY` and `TAVILY_API_KEY` in `.env` (the trigger form also needs `INNGEST_EVENT_KEY`). Makes real, budget-affecting API calls — matches `eval-reflection.ts`'s existing policy (real eval before prompt changes merge, never automatically on every commit/PR). Manual trigger only, no cron/CI wiring. The CLI form writes each case's real output to `live-eval-fixtures/{id}-run.json`; the Inngest job doesn't (no Postgres/file persistence, D019 §4 — its result lives in Inngest's own run history). Scoring uses `src/evaluation/grounnel-live-gate.ts` — `evaluateGrounnelRun()`'s pure logic already has its own fast synthetic unit tests (`tests/unit/evaluation/grounnel-live-gate.test.ts`) that don't need live calls.

**"False positive" here** = `no_false_accusation`: a claim that's true (or has no real web evidence either way) getting marked `contradicted`. This is the specific failure ADR-000 §2's grounding-product thesis calls fatal to trust — the eval script's summary line reports this count explicitly, separate from the aggregate correct-rate.

## Status (2026-08-06)

Deployed and run for real via the Inngest trigger. First real run crashed 2/10 cases (`GrounnelPipelineService.runBatch()` had no guard against VERIFY's `results` field coming back `null` when `repair.ts` can't salvage it — fixed, see `src/orchestrators/grounnel/pipeline.service.ts`'s `isValid` check). Second real run: 0 crashes, 0 false accusations across every completed case, 2 open, not-yet-diagnosed findings:

- `g02-mount-everest` — both claims landed on `verdict: null` (a degraded/failed batch, not a wrong verdict). Cause not yet confirmed — likely a transient Gemini per-minute rate limit mid-VERIFY, since nothing else in the same run failed. `GrounnelClaim` now also captures `status`/`reason` (previously only `verdict`), so the next real run's output will actually say why instead of just showing `null`.
- `g05-statue-of-liberty` — landed on `unsupported` instead of `contradicted`. This looks like a real pipeline/prompt limitation, not a bug: the claim needs *indirect* contradiction (evidence says "gift from France," claim says "gift from Canada" — mutually exclusive facts about the same entity, not a direct "X is false" statement). Not investigated further yet.

`live-eval-fixtures/` is still empty in git — real runs so far were via the Inngest trigger (`pnpm eval:grounnel:trigger`), which doesn't write files (no persistent filesystem, D019 §4); only the CLI form (`pnpm eval:grounnel`) does. **Next steps, not yet done:** run the CLI form for real to produce committable fixtures; once they exist, add a `tests/unit/evaluation/grounnel-live-gate.test.ts` fixture-replay suite (mirroring `audit-live-gate.test.ts`) as a fast, no-network CI regression test; diagnose g02 and g05 with a fresh real run now that status/reason are captured.
