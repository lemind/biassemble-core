# Grounnel live eval — minimum golden set

16 cases, `live-eval-golden-set.json`, in the same spirit as `evaluations/golden/audit/live-eval-fixtures/`: a real, live run of the actual pipeline (`GrounnelExtractService` + `GrounnelPipelineService`) against real Gemini (EXTRACT, VERIFY, `google_search` discovery) and a real Tavily fallback — no mocks, no recorded/replayed responses for the run itself.

## Labeling discipline

Same rule as `evaluations/golden/audit/README.md`: every case's expected `kind` (`true` / `false` / `silence`) was written before the script ever ran against it, based on independently verifiable public facts (6 true, 4 false, 1 fabricated/obscure for the silence case) — not adjusted afterward to match whatever the model produced.

`g11-bloomberg-fallback` is the one case deliberately targeting a different thing than a true/false/silence label: `HybridSearchProvider` only calls Tavily when *every* DIY candidate (Gemini `google_search` discovery + direct fetch) fails for a claim — none of g01–g10 are designed to force that, so the fallback path had zero deliberate coverage. `bloomberg.com` commonly blocks non-browser fetches (403/unreachable), and the fact itself (Apple's market cap) is widely corroborated elsewhere, so Tavily has a real shot at resolving it. **Not guaranteed** — this repo has no per-claim provider-attribution field, so whether it actually fell back to Tavily on a given run has to be confirmed from logs (`"DIY fetch failed for every candidate — falling back"`), not from the eval's JSON output alone.

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
