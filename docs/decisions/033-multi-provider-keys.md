# D033 — Multi-provider checks and bring-your-own key

Status: **decided, not implemented.** Spec: `specs/020-multi-provider-keys/`.

## §1. What a visitor can choose

A check with no own key runs on Gemini. The form has no provider picker. DeepSeek and Qwen are the
two providers being added. With an own key the visitor can select Gemini now. Qwen and DeepSeek
stay off the form, and the public check rejects them, until the manual reading in §2 looks
acceptable for that provider. There is no experimental label.

There is no comparison feature in this slice. Nothing generates a table or a Stats section.

## §2. When a new provider is listed

Building the provider is not blocked by a comparison. Listing it is.

The reading uses the existing deployed evaluation job, with a provider argument and the deployment
key. That job already stores `source: "eval"`, so the runs stay out of production statistics. The
public check stores `source: "production"` and is not the reading path. The operator reads the job
output and `grounnel_gate_events` by hand. No new script.

Zero false accusations on the golden set is not enough. `reason_consistency`, `implicit_negation`,
`reason_year` and `reason_ordinal` force `contradicted` from English phrases tuned on Gemini. A
model that phrases the same reason differently makes those gates go quiet, and false accusations
fall because the backstop stopped firing. The reading looks at each gate's override count. A
provider whose overrides disappear on cases where Gemini's still fire is not listed. Qwen and
DeepSeek are read separately. g17's detection floor of 0 does not drop `reason_ordinal` out of
that count. Gemini with an own key does not wait: it is the model those gates were tuned on.

The same reading also looks for known false claims meeting the floor already on that case, an
unresolved rate no higher than Gemini's on the same pass, and output that still parses, finishes,
and keeps citations. Those bars are not software.

## §3. One error type, classified by status and code

`RateLimitError` is defined in `gemini.ts` and is what the retry, pipeline, audit, and eval-job code
branches on. Each provider maps its response onto one shared type in `providers/types.ts`:
`invalid_key`, `no_balance`, `rate_limited`, `unavailable`, `model_access_denied`. Every current
import moves there. `gemini.ts` does not keep a re-export.

Classification uses the HTTP status and the provider's structured error code. Status alone is wrong
for Qwen: a 429 can be throttling or an exhausted quota, and a 403 for a model that was not
purchased is `model_access_denied`, not `invalid_key`. DeepSeek does line up: 401, 402, 429, 500,
503. A 402 is not retried. A DeepSeek 429 may be retried, then the run stops. Nothing falls back
to the site key. The user sees the category and a short message. The raw body is dropped.

A visitor's Gemini key is classified from the response. The deployment key is an authorization key.
A visitor's key is not assumed to be one. A standard key Google rejects is `invalid_key`.

Before any claim, and before the article is sent, one preflight runs. DeepSeek calls
`GET /user/balance`. Gemini and Qwen send one tiny completion with a fixed prompt. That is the
10-second bound. The balance amounts are not stored. A passed preflight does not promise the rest
of the run.

`max_tokens` is per provider. Qwen structured output must omit it. DeepSeek must set it.

The model recorded for a call is the model `getGenerativeModel` was given. Stamping `env.GEMINI_MODEL`
on the row while the client reads the env again will publish a model that did not run once those
two can differ.

## §4. Where provider is stored, and what it costs

Migration `0018` adds `provider`, `model` and `key_source` to `grounnel_runs` only.
`grounnel_llm_calls.provider` and `.model` already exist and are already written.

`POST /extract` still returns `{id, shareToken}`. The result page reads Redis via `GET /status/:id`,
and the share page reads `selectGrounnelRunByShareToken`. Both gain `provider` and `model`. Neither
returns `key_source` or the key. This slice does not build a cost report. `key_source` stays on the
row for a later reading.

Discovery rows are stored with `provider` hardcoded to `gemini` for every run. A later cost reading
joins the call to `grounnel_runs.provider` and keeps `stage = 'discovery'` as its own search line.
That reading prices each call from that call's input length, cache split, and time, then sums.
Qwen's tier is the call's input length, not the run total. Singapore list: $0.03 / $0.13 up to 32K,
$0.10 / $0.40 through 256K, $0.20 / $0.80 through 1M. DeepSeek uses the reported cache split and the
peak or off-peak rate for the call time. Peak is Monday–Friday 01:00–04:00 and 06:00–10:00 UTC,
excluding Chinese public holidays. A missing split or a missing time uses the peak uncached rate
and is marked an upper bound. A flat rate per model cannot implement this. `pricing.ts` is not in
this slice.

## §5. Keys

The user types the key in the browser. The browser sends it to Grounnel for that check. The server
holds it in memory only while it calls the selected provider, then drops it. It is not a private or
local-only mode: Google still discovers web sources, and the share link is readable by anyone who
opens it. The page says so before the first own-key check. The site default stays Gemini.

Pino redacts named properties and will not see a key echoed inside a 401 body. Raw provider bodies are
dropped. Any string that is logged or written to `error_message` goes through a scrubber first.
Discovery already violates this: the Gemini URL carries the site key, and a failed request stores
`String(err)` while the adjacent log is sanitized. That write is fixed with the scrubber, and the
test asserts the stored text, not only the log.

## §6. JSON-object calls

DeepSeek and Qwen use JSON-object mode, not schema mode. Qwen's schema mode is unavailable in
Singapore. Every such request includes the word JSON and an example of the object. If the shared
prompt lacks them, they are appended on that request only, so Gemini's prompt stays as it is.
Zod validation and the existing repair path stay. Empty content is retried, then the claim is
unchecked. It is not a guessed verdict. A successful authentication call is not evidence that a
real Grounnel call parses.

## §7. What the later reading is measuring

Search, the evidence set, and the gate chain stay the same for every provider. The adapters do not.
Structured-output mode, token limits, response handling, and repair differ. The reading measures
the model and that integration together. It does not claim the only difference is the model.
