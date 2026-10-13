# Research: Choice of AI Provider and Bring-Your-Own Key

Checked 2026-10-12 against the providers' own documentation.

## R1 — How to call DeepSeek and Qwen

**Decision**: one `OpenAICompatibleProvider` over `fetch`, configured per provider.

- DeepSeek: base URL `https://api.deepseek.com`, OpenAI-compatible chat completions.
- Qwen: international (Singapore) endpoint
  `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`.

**Rationale**: both use the same request and response shape; no SDK is needed.
**Rejected**: the OpenAI SDK (a new dependency for two `fetch` calls).

## R2 — Structured output

**Decision**: JSON-object mode for both new providers, plus the existing Zod validation and repair.
A key check passing does not prove these calls work.

- Gemini today: schema-enforced output (`responseSchema`). Those prompt texts stay as they are.
- DeepSeek: only `response_format: {type: "json_object"}`. The prompt must contain the word "json"
  and an example, and `max_tokens` must be set so the object is not cut off. The API may return
  empty content. Empty content is retried, then the claim is unchecked. It is not a guessed verdict.
- Qwen: `json_object` on the Singapore endpoint. `json_schema` exists on the 3.7 series **but not
  in Singapore** — only Beijing. Beijing is rejected. The prompt must contain the word JSON. The
  mode guarantees valid JSON, not our schema. Do not set `max_tokens` with structured output
  (truncation breaks JSON). Use non-thinking mode for reliable JSON.
- If a shared Grounnel prompt lacks the word JSON and an example, append both on the DeepSeek or
  Qwen request only.
- DeepSeek requires `max_tokens`. The shared class takes this as a per-provider option: omitted for
  Qwen, set for DeepSeek, left as today's `request.options.maxTokens` for Gemini. One value for
  both new providers is wrong.

**Consequence**: more malformed answers are possible than with Gemini. The later reading counts
them (unresolved rate) rather than assuming they are rare. Unusable output is an unchecked claim.

## R3 — Models and prices (list, USD per 1M tokens)

| Provider | Model | Input | Output | Notes |
|---|---|--:|--:|---|
| Gemini | `gemini-2.5-flash-lite` | 0.10 | 0.40 | today's model. The deployment key is an authorization key. A visitor's key is validated as sent; a standard key Google rejects is an authentication error |
| DeepSeek | `deepseek-flash` (version DeepSeek-V4.1-Flash) | 0.30 peak / 0.15 off-peak | 1.20 / 0.60 | Base URL `https://api.deepseek.com`. Do not send `deepseek-v4-flash`; that alias is retired and only routed here for now. Call with thinking off. Cache-hit input is $0.006 peak / $0.003 off-peak. Peak is Mon–Fri 01:00–04:00 and 06:00–10:00 UTC, excluding Chinese public holidays. Other hours, including weekends and those holidays, are off-peak |
| Qwen | `qwen3.7-flash`, Singapore | 0.03 (≤32K per request) | 0.13 | 0.10/0.40 for 32K–256K per request; 0.20/0.80 for 256K–1M per request |

Tiers are per request, not per run. A ~382K run total is many calls, about 12 per case, and does
not put those calls in the 256K–1M band. A verify call is ~11K input, so the $0.03 tier applies to
almost every call. The top tier stays in the table because one EXTRACT call sends the whole text
with no length cap, so a single request can reach it. Price each call by its own input size. Do not
sum a run and then pick a tier. Singapore international list, checked 2026-10-11: 256K–1M is $0.20
input / $0.80 output per 1M tokens. Beijing prices differ and are not used. When a DeepSeek response
does not split cached input tokens, or the call time is missing, price the whole input at the peak
uncached rate and mark the figure an upper bound. Otherwise use the peak or off-peak rate for that
call's time. R4's $0.21 / $0.62 / $0.06 round uses the uncached peak list prices and the $0.03 Qwen
tier. It is background for the deferred $10 ceiling. This slice does not price a run. The interface
that will, `priceCall(provider, model, inputTokens, cachedInputTokens, outputTokens, at)`, prices
one call. A table of one rate per model cannot.

## R4 — Later reading cost (not built)

Measured since 2026-09-11: golden case ≈ 43K in / 3K out; real run ≈ 76K / 6K.
Golden set (28 cases) once ≈ 1.2M in / 0.09M out per provider.

| One round: golden ×1 + 5 real texts | Gemini | DeepSeek (peak) | Qwen |
|---|--:|--:|--:|
| Tokens ≈ 1.58M in / 0.12M out | $0.21 | $0.62 | $0.06 |

Two rounds on all three ≈ **$1.80**, well inside SC-002 ($10). Allow 1.5× for longer outputs.

## R5 — Where the key lives

**Decision**: the key stays in page memory for the session. This release does not write it to
`localStorage` or `sessionStorage`. The browser sends it per request in a header, over HTTPS, never
in the URL.

The server receives the key. That is required to call the provider. It holds the key in memory for
that invocation only (`waitUntil`). No Inngest event, Redis field, DB column, log, or trace carries
it. Remembering the key on the device is out of scope until people show they need it.

## R6 — Validating a key before the run

**Decision**: a preflight before the article or any claim is sent. It is the SC-005 10-second bound.
The deployment key script does not satisfy it for a visitor's key. A passed preflight does not
promise the rest of the run.

- DeepSeek: `GET https://api.deepseek.com/user/balance`. 401 is `invalid_key`. `is_available: false`
  is `no_balance`. The balance amounts are not stored or logged.
- Gemini and Qwen: one tiny completion with a fixed prompt that is not the user's text. The same
  classifier as a real call reads the status and the error code.

## R7 — Error categories shown to the user

Each adapter classifies from the HTTP status and the provider's structured error code. Status alone
is wrong for Qwen: a 429 can be throttling or an exhausted quota, and a 403 can mean the model was
not purchased. Categories: `invalid_key`, `no_balance`, `rate_limited`, `unavailable`,
`model_access_denied`. The last one is not reported as a bad key. The type lives next to
`Provider`, not in `gemini.ts`. The user sees the category and a short message. Raw bodies are
never shown, logged, or stored. A scrubber runs on any error string before it reaches a log or
`error_message`, because an OpenAI-shaped 401 echoes the key and pino's property redaction does
not catch that.

DeepSeek, from its error-code page: 401 authentication, 402 insufficient balance, 429 rate limit,
500 server error, 503 overloaded. 400 and 422 are bad requests, not key errors.

Checked 2026-10-13 against DeepSeek's error-code, JSON-output, pricing, and balance pages, and
against Alibaba's Singapore OpenAI-compatible and rate-limit pages.
