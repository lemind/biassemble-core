# Implementation Plan: Choice of AI Provider and Bring-Your-Own Key

**Branch**: `020-multi-provider-keys` | **Date**: 2026-10-13 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/020-multi-provider-keys/spec.md`

## Summary

Add DeepSeek and Qwen next to Gemini. The existing `Provider` interface is only `{mode, completeJson}`
and cannot carry this: rate-limit and billing control flow today depends on `RateLimitError`, a class
defined in `gemini.ts` and `instanceof`-checked from provider-agnostic code. Move a shared provider
error into `providers/types.ts`. Each adapter classifies from the HTTP status and the provider's
error code: invalid key, no balance, rate limited, unavailable, and model access denied. Make the
provider a per-run choice instead of a process-wide singleton, and record provider, model and key
source on every run.

The site default stays Gemini, with no picker. With an own key the user can select Gemini now.
Qwen and DeepSeek stay off the form until a small manual reading of the existing evaluation job.
This slice does not build a comparison script or a Stats section. The public check is not the
reading path: it always stores a production run. The existing evaluation job already stores an
evaluation run.

Web search does not change. URL discovery stays on Gemini's Google Search grounding with the site's
key, for every provider and every key source. The gate chain stays too. A later reading measures
the model and that provider's integration together (FR-003). It does not isolate the model.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), Node on Vercel, as today.

**Primary Dependencies**: Existing only. DeepSeek and Qwen both expose an OpenAI-compatible chat
API, so one new provider class covers both over `fetch` — no new SDK (research R1).

**Storage**: Postgres via Drizzle — migration `0018` (next free after `0017_steady_boomer`) adds
`provider`, `model` and `key_source` to `grounnel.grounnel_runs` only. `grounnel_llm_calls.provider`
and `.model` already exist, `notNull`, and are written on every call (migration `0011`); do not add
them again. Redis meta, `GET /status/:id` and the share payload gain `provider` and `model`. No key
is ever stored.

**Testing**: Per CLAUDE.md: no new tests for prompt or model behaviour. The later reading on the
evaluation job is that check, and it is not software in this slice. Unit tests cover
provider-selection, error classification, the preflight, and key-handling control flow. Price
arithmetic is specified below and is not built in this slice.

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
- **Structured output differs.** Gemini enforces our schema. DeepSeek offers only JSON-object mode
  and requires `response_format: {type: "json_object"}`, the word JSON in the prompt, an example,
  and a set `max_tokens`. It can return empty content. Qwen's Singapore region has JSON-object mode,
  not JSON Schema; the prompt must contain the word JSON, and the mode guarantees valid JSON, not
  our schema. Both new providers use JSON-object mode plus the existing Zod validation and repair.
  Empty or unusable output is retried, then the claim is unchecked. It is not a guessed verdict.
  The JSON word and example are appended on the DeepSeek or Qwen request when the shared prompt
  lacks them, so Gemini's prompt text stays as it is.
- **Data location.** Qwen through the international (Singapore) endpoint only. For a visitor, Qwen
  and DeepSeek are own-key only, and only after that provider is listed (FR-009, FR-010, FR-017).
  The later reading uses deployment keys inside the existing evaluation job. It does not call
  `POST /extract`. DeepSeek processes in China.
- **Evals run deployed.** Gemini is region-blocked from the dev machine. The later reading is the
  deployed evaluation job, the same job current evaluations use. `POST /extract` always stores
  `source: "production"` and is not the reading path.
- **Migration against the shared live DB** needs explicit sign-off before it is applied.

**Scale/Scope**: 3 providers, 1 model each. The later reading, not this slice, is 28 golden cases
× 1–2 passes + ~5 real texts, per provider, inside the deferred $10 ceiling. Measured: a golden
case ≈ 43k input / 3k output tokens; an average real run ≈ 76k / 6k; the largest run ≈ 382k input
across many calls, not one request.

## Constitution Check

`.specify/memory/constitution.md` is an unfilled template, so there are no constitutional gates. The
rules that govern this repo are in `CLAUDE.md`; the ones that bear here:

| Rule | Bearing |
|---|---|
| One-line commits, `feat(020-T20NN): …`, never commit without request | All tasks. IDs are `T2001`–`T2099`: spec `20` plus the two-digit task |
| Comments ≤ ~200 chars, rationale in the decision doc | Provider class, key handling |
| No new tests for LLM behaviour; golden-set run is the check | The later reading is that check. This slice does not add a report |
| `gates.ts` kept exhaustive | Gate code stays as it is. It is not provider-proof: four reason-reading gates force `contradicted` from Gemini-tuned English. The later reading looks at their override counts (FR-006, FR-010) |
| No AI attribution | All commits |

Passes. Post-design re-check: the gate chain is not edited. The later reading uses `grounnel_gate_events` so a gate that stops matching is visible. That reading gates the form listing, not the build.

## Project Structure

### Documentation (this feature)

```text
specs/020-multi-provider-keys/
├── spec.md
├── plan.md              # this file
├── research.md          # R1–R7
├── data-model.md        # provider columns, provider options, deferred reading notes
├── quickstart.md        # keys, then a Gemini check; the later reading is the eval job
├── contracts/
│   └── provider-selection.md   # request headers between site and core
├── checklists/
│   └── requirements.md
└── tasks.md
```

`docs/decisions/033-multi-provider-keys.md` records the decisions comments point at.

### Source code

**biassemble-core (this repo)**

```text
src/
├── providers/
│   ├── types.ts                 # shared ProviderError: invalid_key, no_balance, rate_limited, unavailable, model_access_denied
│   ├── gemini.ts                # per-run model and optional key; getGenerativeModel uses that model
│   ├── openai-compatible.ts     # NEW — DeepSeek and Qwen, JSON-object mode, per-provider max_tokens, code-aware errors
│   ├── registry.ts              # NEW — ProviderOption table + resolveProvider(choice, key); Qwen and DeepSeek unlisted
│   └── pricing.ts               # LATER — not this slice. Interface below; a flat rate cannot implement it
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
    └── check-provider-keys.ts  # NEW — one authenticated call per provider, nothing else
```

`tests/unit/providers/search/hybrid-provider.test.ts` asserts the persisted `error_message`, not only the log.

**biassemble (site repo)**

```text
frontend/src/
├── components/grounnel/ProviderPicker.tsx   # NEW — own-key only; lists a provider only when the registry says it is listed
└── lib/providerKey.ts                       # NEW — key in page memory only, not localStorage
backend/src/
├── middleware.ts            # allow the two new request headers in CORS
└── services/grounnel.service.ts   # forward provider + key headers to core, never log them
```

## Key design decisions

### One provider object per run, not per process

Today `server.ts` builds one `GeminiProvider` at boot. Orchestrators stamp `env.GEMINI_MODEL` onto
`grounnel_llm_calls`, but the model that is actually called is read again inside `gemini.ts`
(`getGenerativeModel`). Both must use the per-run model. Passing a model only into the row would
publish a model that never ran. A request with no choice uses Gemini on the site key (FR-008).

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
the user's own key. Move the categories into `providers/types.ts`. Classification uses the status
and the structured code.

DeepSeek's codes line up with the status: 401 authentication is `invalid_key`, 402 insufficient
balance is `no_balance` and is not retried, 429 rate limit is `rate_limited` and may be retried
then the run stops, 500 and 503 are `unavailable`. A 400 or 422 is a bad request, not a key error,
and the claim is unchecked.

Qwen does not line up. A 401 `invalid_api_key` is `invalid_key`, including a key created in another
region: the message says the key was rejected for this endpoint. A 429 is `rate_limited` when the
code is throttling, and `no_balance` when the code is quota, arrears, or an exhausted balance. A
403 for a model that was not purchased or not authorized is `model_access_denied`, not
`invalid_key`. Overload is `unavailable`.

Gemini's depleted balance and quota are `no_balance` and are not retried. A visitor's Gemini key
is classified from the response. A standard key Google rejects is `invalid_key`. The deployment
key is an authorization key; a visitor's key is not assumed to be one.

None of these fall back to the site key. The user sees the category and a short message. The raw
body is dropped. The eval job's abort uses the same type.

### max_tokens is per provider

One shared class cannot send one `max_tokens` policy. Qwen's structured-output docs say not to set
it (truncation breaks JSON). DeepSeek's say it must be set. Gemini keeps today's
`request.options.maxTokens`. The class takes that as a per-provider option.

### Search stays put

`HybridSearchProvider` keeps the site's Gemini key and model for URL discovery. Only the calls that
judge text — extraction, eligibility, rerank, verify, consistency and attribution checks — move to
the chosen provider. Search, the evidence set, and the gate chain stay. The provider integration
does not: JSON-object mode, `max_tokens`, and repair differ, and the later reading includes that.

### Keys travel in one header, live in one invocation

The browser sends the key in a request header to the site backend, which forwards it to core in a
header. Before any claim, core makes one preflight that does not contain the user's article or any
claim. DeepSeek calls `GET /user/balance`: 401 is `invalid_key`, and `is_available: false` is
`no_balance`. Gemini and Qwen send one tiny completion with a fixed prompt, and the same classifier
reads the response. The preflight must return within 10 seconds (SC-005). The balance amounts are
not stored or logged. A passed preflight does not promise the rest of the run; FR-016 still handles
a mid-run failure.

Core then builds the provider for that run and holds the key only in memory until the run ends.
It is never put in the run record, the Redis state, a log line, or an error message. The user sees a
category. The raw body is not logged and not written to `error_message`; what is written goes through
the scrubber first. `logger.ts` redacts named properties and does not see a key inside a string.
The deployment key-check script is a different call. It does not validate a visitor's key.

### DeepSeek and Qwen share one class

Both speak the OpenAI chat-completions shape. One `OpenAICompatibleProvider` takes a base URL,
model and key. Provider quirks (empty content, `max_tokens`, the error mapping) are handled there.
JSON-object calls send `response_format: {type: "json_object"}`. If the shared prompt does not
already contain the word JSON and an example, the adapter appends both on that request only.
Comments point at `docs/decisions/033-multi-provider-keys.md`, which is written with this feature.
`research.md` is not a durable target: this repo deletes research notes after the decision is recorded.

### Cost, later, is per call

Not built in this slice. `pricing.ts` is not a flat input/output pair per model. When it is built,
`priceCall` takes that call's provider, model, input tokens, cached input tokens, output tokens,
and the call time. It returns a dollar amount, the tier or rate it used, and whether the figure is
an upper bound. A run's cost is the sum of its calls. Qwen's tier comes from that call's input
length: $0.03 / $0.13 up to 32K, $0.10 / $0.40 through 256K, $0.20 / $0.80 through 1M, Singapore.
The run's summed tokens do not pick the tier.

DeepSeek splits cached and uncached input when the response reports both. Peak list rates apply
Monday–Friday 01:00–04:00 and 06:00–10:00 UTC, excluding Chinese public holidays; every other hour
is off-peak, at half the peak rate. The call time selects the rate. A missing cache split or a
missing call time uses the peak uncached rate and is marked an upper bound.

`grounnel_llm_calls` already records tokens, and discovery rows are inserted with `provider: "gemini"`
hardcoded even when the judge is Qwen or DeepSeek. A later cost reading joins `run_id` to
`grounnel_runs.provider` for judging calls and keeps `stage = 'discovery'` as its own search line.
This slice does not emit that reading.

### No comparison feature in this slice

The later reading is the existing evaluation job, with a provider argument and the deployment key
for that provider. It already writes `source: "eval"`. The operator triggers it the way evaluations
are triggered today and reads the job output and `grounnel_gate_events` by hand. No comparison
script, no generated JSON, no Stats section. `POST /extract` stays production-only. Curling it
would count as a visitor run.

`POST /extract` keeps returning `{id, shareToken}`. The page that says which provider ran is
`GET /status/:id`, served from the Redis hash, and the share page, served from
`selectGrounnelRunByShareToken`. Both payloads and both schemas gain `provider` and `model`.
Writing the columns on `grounnel_runs` alone does not show them.

## Phases

| Phase | Delivers | Spec story |
|---|---|---|
| 1. Keys | one authenticated call for Gemini, DeepSeek, and Qwen | — |
| 2. Provider plumbing | per-run provider, shared errors, JSON-object prompts, registry, migration 0018, eval job takes a provider | US2, US3 |
| 3. Site path | no picker; site runs stay on Gemini; provider name on the result and share page | US2 |
| 4. Own key | key field, preflight, page memory, notice. The form lists Gemini. Qwen and DeepSeek stay unlisted | US3 |

The hand reading is after this. It is not a phase and not a script. It uses the evaluation job
from phase 2. A visitor never gets a provider choice. Qwen and DeepSeek are not on the own-key
form until that reading looks acceptable for that provider. The public route rejects an unlisted
provider. The evaluation job does not use that route, so the reading can run first.

## Risks

- **Gates tuned on one model.** `reason_consistency`, `implicit_negation`, `reason_year` and
  `reason_ordinal` force `contradicted` from closed English phrases tuned on Gemini. A model that
  phrases the same reason differently makes those gates go quiet, false accusations fall, and a
  false-accusation-only gate would pass it. The later reading looks at the override counts before
  that provider is listed. Per-case rates do not show this on their own, and g17's detection floor
  of 0 would hide `reason_ordinal`. Listing the provider before that reading is the risk this
  decision refuses.
- **Time limit.** A slower provider may not fit 40 claims in 300 s; the cap comes from measurement.
- **Own-key runs consume the site's free search allowance** (1,500 grounded requests a day). FR-018
  keeps them inside the run limits.
