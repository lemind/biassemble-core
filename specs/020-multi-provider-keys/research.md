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

- Gemini today: schema-enforced output (`responseSchema`).
- DeepSeek: only `response_format: {type: "json_object"}`. The prompt must contain the word "json"
  and an example; the API "may occasionally return empty content" — treat empty content as a
  retryable failure.
- Qwen: `json_object` on most models; `json_schema` on the 3.7/3.8 series, **but not in the
  Singapore region** — only Beijing. Using Beijing would send text to mainland China, so it is
  rejected. Do not set `max_tokens` with structured output (truncation breaks JSON). Use
  non-thinking mode for reliable JSON.
- DeepSeek requires `max_tokens`. The shared class takes this as a per-provider option: omitted for
  Qwen, set for DeepSeek, left as today's `request.options.maxTokens` for Gemini. One value for
  both new providers is wrong.

**Consequence**: more malformed answers are possible than with Gemini. The comparison counts them
(unresolved rate) rather than assuming they are rare.

## R3 — Models and prices (list, USD per 1M tokens)

| Provider | Model | Input | Output | Notes |
|---|---|--:|--:|---|
| Gemini | 2.5 Flash-Lite | 0.10 | 0.40 | today's model |
| DeepSeek | V4.1 Flash | 0.30 peak / 0.15 off-peak | 1.20 / 0.60 | off-peak = outside 01–04 and 06–10 UTC, weekdays. Cached input is about 1/50 of the uncached input price |
| Qwen | 3.7-flash, Singapore | 0.03 (≤32K per request) | 0.13 | 0.10/0.40 for 32K–256K per request; 0.20/0.80 for 256K–1M per request |

Tiers are per request, not per run. A ~382K run total is many calls, about 12 per case, and does
not put those calls in the 256K–1M band. A verify call is ~11K input, so the $0.03 tier applies to
almost every call. The top tier stays in the table because one EXTRACT call sends the whole text
with no length cap, so a single request can reach it. Price each call by its own input size. Do not
sum a run and then pick a tier. Singapore international list, checked 2026-10-11: 256K–1M is $0.20
input / $0.80 output per 1M tokens. Beijing prices differ and are not used. When a DeepSeek response
does not split cached input tokens, price the whole input at the uncached rate and mark the figure
an upper bound. R4's $0.21 / $0.62 / $0.06 round uses the uncached list prices and the $0.03 Qwen tier.

## R4 — Comparison cost

Measured since 2026-09-11: golden case ≈ 43K in / 3K out; real run ≈ 76K / 6K.
Golden set (28 cases) once ≈ 1.2M in / 0.09M out per provider.

| One round: golden ×1 + 5 real texts | Gemini | DeepSeek (peak) | Qwen |
|---|--:|--:|--:|
| Tokens ≈ 1.58M in / 0.12M out | $0.21 | $0.62 | $0.06 |

Two rounds on all three ≈ **$1.80**, well inside SC-002 ($10). Allow 1.5× for longer outputs.

## R5 — Where the key lives

**Decision**: browser `sessionStorage` by default; `localStorage` only if the user ticks "remember on
this device". Sent per request in a header; never in the URL (URLs end up in logs and history).

Runs execute in the same Vercel invocation (`waitUntil`), so core needs the key only in memory for
that invocation. No Inngest event, Redis field or DB column ever carries it.

## R6 — Validating a key before the run

**Decision**: a cheap authenticated call before the first claim is processed (e.g. listing models or
a 1-token completion). It separates "invalid key" and "no balance" from a pipeline failure and
satisfies SC-005's 10-second error. Cost per validation is negligible.

## R7 — Error categories shown to the user

Provider errors are mapped inside each provider onto one shared type: invalid key, no balance,
rate limited, provider unavailable, malformed output. The type lives next to `Provider`, not in
`gemini.ts`. Raw bodies are never shown, logged, or stored. A scrubber runs on any error string
before it reaches a log or `error_message`, because an OpenAI-shaped 401 echoes the key and pino's
property redaction does not catch that.
