# Implementation Plan: Choice of AI Provider and Bring-Your-Own Key

**Branch**: `020-multi-provider-keys` | **Date**: 2026-10-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/020-multi-provider-keys/spec.md`

## Summary

Add DeepSeek and Qwen next to Gemini. The existing `Provider` interface is only `{mode, completeJson}`
and cannot carry this: rate-limit and billing control flow today depends on `RateLimitError`, a class
defined in `gemini.ts` and `instanceof`-checked from provider-agnostic code. Move a shared provider
error (invalid key, no balance, rate limited, unavailable) into `providers/types.ts`, and have each
provider map its own HTTP status onto it. Make the provider a per-run choice instead of a
process-wide singleton, and record provider, model and key source on every run. Run a small comparison (golden set once or twice plus a few real texts) on all three, and
publish it on Stats. The site account stays on Gemini with no picker. With an own key the user
selects Gemini, Qwen, or DeepSeek.

Web search does not change. URL discovery stays on Gemini's Google Search grounding with the site's
key, for every provider and every key source, so the comparison isolates the model (FR-003).

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Node on Vercel, as today.

**Primary Dependencies**: Existing only. DeepSeek and Qwen both expose an OpenAI-compatible chat
API, so one new provider class covers both over `fetch` — no new SDK (research R1).

**Storage**: Postgres via Drizzle — migration `0018` (next free after `0017_steady_boomer`) adds
`provider`, `model` and `key_source` to `grounnel.grounnel_runs` only. `grounnel_llm_calls.provider`
and `.model` already exist, `notNull`, and are written on every call (migration `0011`); do not add
them again. Redis meta, `GET /status/:id` and the share payload gain `provider` and `model`. No key
is ever stored.

**Testing**: Per CLAUDE.md: no new tests for prompt or model behaviour — the comparison run is the
test. Unit tests only for the provider-selection and key-handling control flow, and for the price
table arithmetic.

**Target Platform**: Vercel Hobby, 300 s ceiling. Runs execute inside the request via `waitUntil`
(`routes/grounnel.ts`), so a user's key lives only in that invocation's memory — no queue, no job
payload, nothing to persist.

**Project Type**: Web service (core) plus changes in the site repo (frontend + backend proxy).

**Performance Goals**: Same as today for Gemini. Other providers: claim cap set from measured time
per claim (FR-012).

**Constraints**:

- **No key at rest.** Not in Postgres, Redis, logs, Inngest events, share tokens or error messages.
  Pino's property redaction does not scrub a key inside a string. Provider error bodies are
  discarded, and any `error_message` is passed through a scrubber before a log line or
  `grounnel_llm_calls.error_message` write. A 401 body that echoes the key is the case this exists
  for. The same change fixes the live discovery write: `hybrid-provider.ts` builds the Gemini URL
  with the site key in the query string and passes `String(err)` into `recordDiscovery`, which
  stores it. The log next to it already uses `sanitizeErrorForLogging`. The current test asserts
  that log and uses a no-op store, so it cannot see the column. The new test asserts the persisted
  `error_message` contains no key.
- **Structured output differs.** Gemini enforces our schema; DeepSeek offers only JSON-object mode;
  Qwen offers schema mode but not in the Singapore region (research R2). So both new providers run
  in JSON-object mode and rely on the existing Zod validation and repair path.
- **Data location.** Qwen through the international (Singapore) endpoint only. For a visitor, Qwen
  and DeepSeek are own-key only (spec FR-009, FR-017). The operator comparison uses deployment keys
  and does not go through `POST /extract`. DeepSeek processes in China.
- **Evals run deployed.** Gemini is region-blocked from the dev machine; the comparison runs through
  the deployed Inngest eval job, as all evals do.
- **Migration against the shared live DB** needs explicit sign-off before it is applied.

**Scale/Scope**: 3 providers, 1 model each. Comparison = 28 golden cases × 1–2 passes + ~5 real
texts, per provider. Measured: a golden case ≈ 43k input / 3k output tokens; an average real run
≈ 76k / 6k; the largest run ≈ 382k input.

## Constitution Check

`.specify/memory/constitution.md` is an unfilled template, so there are no constitutional gates. The
rules that govern this repo are in `CLAUDE.md`; the ones that bear here:

| Rule | Bearing |
|---|---|
| One-line commits, `feat(020-T0NN): …`, never commit without request | All tasks |
| Comments ≤ ~200 chars, rationale in the decision doc | Provider class, key handling |
| No new tests for LLM behaviour; golden-set run is the check | The comparison replaces per-model tests |
| `gates.ts` kept exhaustive | Gate code stays as it is. It is not provider-proof: four reason-reading gates force `contradicted` from Gemini-tuned English. The comparison reports their override counts (FR-006, FR-010) |
| No AI attribution | All commits |

Passes. Post-design re-check: the gate chain is not edited. The comparison reads `grounnel_gate_events` so a gate that stops matching is visible.

## Project Structure

### Documentation (this feature)

```text
specs/020-multi-provider-keys/
├── spec.md
├── plan.md              # this file
├── research.md          # R1–R7
├── data-model.md        # provider columns, provider options, comparison report
├── quickstart.md        # how to run the comparison and try own keys
├── contracts/
│   └── provider-selection.md   # request headers between site and core
├── checklists/
│   └── requirements.md
└── tasks.md             # next step, /speckit-tasks
```

`docs/decisions/033-multi-provider-keys.md` records the decisions comments point at.

### Source code

**biassemble-core (this repo)**

```text
src/
├── providers/
│   ├── types.ts                 # shared ProviderError (invalid key, no balance, rate limited, unavailable)
│   ├── gemini.ts                # per-run model and optional key; getGenerativeModel uses that model
│   ├── openai-compatible.ts     # NEW — DeepSeek and Qwen, JSON-object mode, per-provider max_tokens
│   ├── registry.ts              # NEW — ProviderOption table + resolveProvider(choice, key)
│   └── pricing.ts               # NEW — $/1M in/out per provider model, used by cost reports
├── orchestrators/grounnel/
│   ├── extract.service.ts       # takes the per-run provider; model name from it, not env
│   ├── claim-eligibility.ts     # same
│   └── pipeline.service.ts      # same
├── routes/grounnel.ts           # reads provider choice + key headers, validates, builds provider
├── observability/logger.ts      # not sufficient alone — see the scrubber below
├── persistence/error-scrub.ts   # NEW — strip key material from any string before log or DB
├── providers/search/hybrid-provider.ts  # scrub the discovery error before recordDiscovery
├── db/schema.ts                 # grounnel_runs: provider, model, key_source only
├── contracts/grounnel.schemas.ts # provider + model on status and share payloads
├── persistence/grounnel-store.ts # provider + model on the Redis meta hash
├── db/migrations/0018_*.sql     # NEW
├── jobs/eval-grounnel-run.ts    # provider parameter
└── scripts/
    ├── trigger-eval-grounnel.ts # --provider flag
    └── compare-providers.ts     # NEW — calls evaluateGrounnelRun; does not reimplement it
```

`tests/unit/providers/search/hybrid-provider.test.ts` asserts the persisted `error_message`, not only the log.

**biassemble (site repo)**

```text
frontend/src/
├── components/grounnel/ProviderPicker.tsx   # NEW — own-key only: Gemini, Qwen, DeepSeek
├── lib/providerKey.ts                       # NEW — session/remembered key in browser storage
├── components/StatsPage.tsx                 # comparison section
└── data/provider-comparison.json            # NEW — published comparison (generated, committed)
backend/src/
├── middleware.ts            # allow the two new request headers in CORS
└── services/grounnel.service.ts   # forward provider + key headers to core, never log them
```

## Key design decisions

### One provider object per run, not per process

Today `server.ts` builds one `GeminiProvider` at boot. Orchestrators stamp `env.GEMINI_MODEL` onto
`grounnel_llm_calls`, but the model that is actually called is read again inside `gemini.ts`
(`getGenerativeModel`). Both must use the per-run model. Passing a model only into the row would
publish a model that never ran. The process-wide default stays Gemini with the site key and
`env.GEMINI_MODEL`, so a request with no choice behaves exactly as today (SC-004).

### Shared provider errors

`RateLimitError` lives in `gemini.ts`. These files import it or branch on it, and Phase 1 changes
each import to `providers/types.ts`. There is no compatibility re-export from `gemini.ts`, so a
missed file fails typecheck instead of staying coupled to Gemini:

- `retry.ts`, `llm-json-call.ts`, `pipeline.service.ts`, `pipeline-helpers.ts`, `routes/grounnel.ts`
- `jobs/eval-grounnel-run.ts` (the comparison job)
- `audit/extract.service.ts`, `audit/verify.service.ts` — import path only. Audit behaviour does
  not change, and this does not pull feature 008's logic into the provider work.

A new provider that throws a plain `Error` misses the early stop:
a DeepSeek 429 would burn the retry budget, then every remaining batch would hit the limit again, on
the user's own key. Move the categories into `providers/types.ts`. Gemini's depleted-balance and
quota errors become `no_balance` and are not retried. A DeepSeek 429 is load-based and may be retried,
then the run stops. A 402 is `no_balance` and is not retried. A 401 is `invalid_key`. None of these
fall back to the site key. The eval job's abort uses the same type, so a comparison has a brake.

### max_tokens is per provider

One shared class cannot send one `max_tokens` policy. Qwen's structured-output docs say not to set
it (truncation breaks JSON). DeepSeek's say it must be set. Gemini keeps today's
`request.options.maxTokens`. The class takes that as a per-provider option.

### Search stays put

`HybridSearchProvider` keeps the site's Gemini key and model for URL discovery. Only the calls that
judge text — extraction, eligibility, rerank, verify, consistency and attribution checks — move to
the chosen provider. Moving search too would make the comparison measure two things at once.

### Keys travel in one header, live in one invocation

The browser sends the key in a request header to the site backend, which forwards it to core in a
header. Core builds the provider for that run and holds the key only in memory until the run ends.
It is never put in the run record, the Redis state, a log line, or an error message. The user sees a
category. The raw body is not logged and not written to `error_message`; what is written goes through
the scrubber first. `logger.ts` redacts named properties and does not see a key inside a string.

### DeepSeek and Qwen share one class

Both speak the OpenAI chat-completions shape. One `OpenAICompatibleProvider` takes a base URL,
model and key. Provider quirks (empty content, `max_tokens`, the error mapping) are handled there.
Comments point at `docs/decisions/033-multi-provider-keys.md`, which is written with this feature.
`research.md` is not a durable target: this repo deletes research notes after the decision is recorded.

### Cost per run comes from tokens × a price table

`grounnel_llm_calls` already records tokens, and discovery rows are inserted with `provider: "gemini"`
hardcoded even when the judge is Qwen or DeepSeek. Grouping that table by `provider` bills every
run's search to Gemini and leaves the other providers looking cheaper. Cost joins `run_id` to
`grounnel_runs.provider` for judging calls and keeps `stage = 'discovery'` as its own search line.
DeepSeek's cached input is about 50× cheaper than uncached. When the response reports cache tokens,
price them; otherwise publish the uncached price and say it is an upper bound. Qwen's tiers are per
request (research R3): $0.03 / $0.13 up to 32K, $0.10 / $0.40 through 256K, $0.20 / $0.80 through
1M, Singapore. A run's summed input does not select the tier. The table is list price.

### The Stats section is a committed snapshot

The comparison is run once or twice, not continuously. `scripts/compare-providers.ts` calls
`evaluateGrounnelRun` and reads gate-event counts. It is run with `tsx` from `scripts/`, not from
`dist/`. The JSON it writes is committed and rendered by the Stats page, with the date and pass
count on screen. No new public endpoint.

`POST /extract` keeps returning `{id, shareToken}`. The page that says which provider ran is
`GET /status/:id`, served from the Redis hash, and the share page, served from
`selectGrounnelRunByShareToken`. Both payloads and both schemas gain `provider` and `model`.
Writing the columns on `grounnel_runs` alone does not show them.

## Phases

| Phase | Delivers | Spec story |
|---|---|---|
| 1. Provider plumbing | per-run provider, `OpenAICompatibleProvider`, registry, pricing, migration 0018 | US1 prerequisite |
| 2. Comparison | eval job takes a provider; run golden ×1–2 + real texts on all three; `compare-providers.ts` report | US1 |
| 3. Site path | no provider picker; site-account runs stay on Gemini; provider name on the result and share page | US2 |
| 4. Own key | key field, picker of Gemini / Qwen / DeepSeek, browser-only storage, validation before first claim, data-location notice | US3 |
| 5. Stats section | generated JSON + Stats page section with date, passes and caveat | US4 |

Phase 2 is the gate for the own-key list, per provider (FR-010): zero golden-set false accusations,
and the reason-reading gates still overriding where they override Gemini. A silent gate is a fail
even when false accusations are zero. A provider that fails stays out of the picker and its result
still goes on Stats. The other provider is not blocked by that failure. A visitor never gets a
provider choice.

## Risks

- **Gates tuned on one model.** `reason_consistency`, `implicit_negation`, `reason_year` and
  `reason_ordinal` force `contradicted` from closed English phrases tuned on Gemini. A model that
  phrases the same reason differently makes those gates go quiet, false accusations fall, and a
  false-accusation-only gate would pass it. The comparison publishes the override counts. Per-case
  rates do not show this on their own, and g17's detection floor of 0 would hide `reason_ordinal`.
- **Time limit.** A slower provider may not fit 40 claims in 300 s; the cap comes from measurement.
- **Own-key runs consume the site's free search allowance** (1,500 grounded requests a day). FR-018
  keeps them inside the run limits.
