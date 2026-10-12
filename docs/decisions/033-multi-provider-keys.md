# D033 — Multi-provider checks and bring-your-own key

Status: **decided, not implemented.** Spec: `specs/020-multi-provider-keys/`.

## §1. What a visitor can choose

A check with no own key runs on Gemini. The form has no provider picker. Gemini, Qwen and DeepSeek
are selectable only after the visitor turns on own-key and supplies that provider's key.

The operator comparison may call Qwen and DeepSeek with keys stored on the core deployment. That
job builds the provider in-process. It does not go through `POST /extract`, whose missing-key rule
would reject both providers and produce an empty comparison.

## §2. Admitting a provider

Zero false accusations on the golden set is not enough. `reason_consistency`, `implicit_negation`,
`reason_year` and `reason_ordinal` force `contradicted` from English phrases tuned on Gemini. A
model that phrases the same reason differently makes those gates go quiet, and false accusations
fall because the backstop stopped firing. The comparison publishes each gate's override count from
`grounnel_gate_events`. A provider whose overrides disappear on cases where Gemini's still fire has
failed. Qwen and DeepSeek are admitted separately. g17's detection floor of 0 does not drop
`reason_ordinal` out of that count.

## §3. One error type, not Gemini's class

`RateLimitError` is defined in `gemini.ts` and is what the retry, pipeline, audit, and eval-job code
branches on. Each provider maps its own status onto one shared type in `providers/types.ts`: invalid
key, no balance, rate limited, unavailable. Every current import moves there. `gemini.ts` does not
keep a re-export. A 402 is not retried. A DeepSeek 429 may be retried, then the run stops. Nothing
falls back to the site key.

`max_tokens` is per provider. Qwen structured output must omit it. DeepSeek must set it.

The model recorded for a call is the model `getGenerativeModel` was given. Stamping `env.GEMINI_MODEL`
on the row while the client reads the env again will publish a model that did not run once those
two can differ.

## §4. Where provider is stored, and what it costs

Migration `0018` adds `provider`, `model` and `key_source` to `grounnel_runs` only.
`grounnel_llm_calls.provider` and `.model` already exist and are already written.

`POST /extract` still returns `{id, shareToken}`. The result page reads Redis via `GET /status/:id`,
and the share page reads `selectGrounnelRunByShareToken`. Both gain `provider` and `model`. Neither
returns `key_source` or the key. `key_source` is read by the comparison cost report.

Discovery rows are stored with `provider` hardcoded to `gemini` for every run. Judging cost joins
the call to `grounnel_runs.provider` and keeps `stage = 'discovery'` as its own search line.
DeepSeek input is priced at the cache rate when the response reports cached tokens, and at the
uncached rate otherwise, marked as an upper bound. Qwen's price tier is chosen per request, not
from a run's summed tokens. Singapore list: $0.03 / $0.13 up to 32K, $0.10 / $0.40 through 256K,
$0.20 / $0.80 through 1M.

## §5. Keys

A key stays in the browser and in the memory of the one invocation that runs the check. Pino
redacts named properties and will not see a key echoed inside a 401 body. Raw provider bodies are
dropped. Any string that is logged or written to `error_message` goes through a scrubber first.
Discovery already violates this: the Gemini URL carries the site key, and a failed request stores
`String(err)` while the adjacent log is sanitized. That write is fixed with the scrubber, and the
test asserts the stored text, not only the log.
