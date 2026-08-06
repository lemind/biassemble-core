# Grounnel live eval — minimum golden set

10 cases, `live-eval-golden-set.json`, in the same spirit as `evaluations/golden/audit/live-eval-fixtures/`: a real, live run of the actual pipeline (`GrounnelExtractService` + `GrounnelPipelineService`) against real Gemini (EXTRACT, VERIFY, `google_search` discovery) and a real Tavily fallback — no mocks, no recorded/replayed responses for the run itself.

## Labeling discipline

Same rule as `evaluations/golden/audit/README.md`: every case's expected `kind` (`true` / `false` / `silence`) was written before the script ever ran against it, based on independently verifiable public facts (5 true, 4 false, 1 fabricated/obscure for the silence case) — not adjusted afterward to match whatever the model produced.

## Running it

Two ways to trigger the same real-call logic (`src/evaluation/run-grounnel-eval.ts`, shared by both):

```
pnpm eval:grounnel [--min-correct-rate 1.0]                  # local CLI — runs in this process, writes fixture files
pnpm eval:grounnel:trigger [--min-correct-rate 1.0]           # fires the "eval-grounnel-run" Inngest job on the deployed app
```

Requires `GEMINI_API_KEY` and `TAVILY_API_KEY` in `.env` (the trigger form also needs `INNGEST_EVENT_KEY`). Makes real, budget-affecting API calls — matches `eval-reflection.ts`'s existing policy (real eval before prompt changes merge, never automatically on every commit/PR). Manual trigger only, no cron/CI wiring. The CLI form writes each case's real output to `live-eval-fixtures/{id}-run.json`; the Inngest job doesn't (no Postgres/file persistence, D019 §4 — its result lives in Inngest's own run history). Scoring uses `src/evaluation/grounnel-live-gate.ts` — `evaluateGrounnelRun()`'s pure logic already has its own fast synthetic unit tests (`tests/unit/evaluation/grounnel-live-gate.test.ts`) that don't need live calls.

**"False positive" here** = `no_false_accusation`: a claim that's true (or has no real web evidence either way) getting marked `contradicted`. This is the specific failure ADR-000 §2's grounding-product thesis calls fatal to trust — the eval script's summary line reports this count explicitly, separate from the aggregate correct-rate.

## Status (2026-08-06)

Built and structurally verified (loads the golden set, makes real Gemini/Tavily calls, catches and classifies errors correctly, scores and reports correctly, exits non-zero on failure) — but **no successful full run has completed yet**: the `.env` key's daily Gemini quota was already exhausted by other real-API work earlier in this session before this script's first run. `live-eval-fixtures/` is currently empty; nothing in it is fabricated to look like a real result.

**Next step, not yet done:** re-run `pnpm eval:grounnel` once quota resets (or with a different key) to produce real fixtures, confirm the golden set's labels hold up against a real model, and — only after that — add a `tests/unit/evaluation/grounnel-live-gate.test.ts` fixture-replay suite (mirroring `audit-live-gate.test.ts`) so the recorded run becomes a fast, no-network CI regression test. Don't write that suite against fixtures that don't exist yet.
