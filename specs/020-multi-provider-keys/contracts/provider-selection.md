# Contract: Provider Selection Between Site and Core

Applies to `POST /extract` (core) and the site backend route that proxies it.

## Request headers

| Header | Values | Required | Notes |
|---|---|---|---|
| `X-Grounnel-Provider` | `gemini` \| `deepseek` \| `qwen` | no | absent = `gemini` |
| `X-Grounnel-Provider-Key` | the user's key | no | absent = site key |

Body is unchanged.

## Rules

1. No provider header and no key header → Gemini on the site key. Identical to today.
2. On `POST /extract`: no provider and no key → Gemini on the site key. `gemini` without a key →
   site key. `deepseek` or `qwen` without a key → `400 provider_requires_own_key`, unless the hidden
   site choice is that provider, in which case the site key for that provider is used. The hidden
   choice is not a request header. It stays `gemini`. A visitor cannot set it. The later reading
   does not use this route. It uses the existing evaluation job with the deployment key.
3. A listed provider with a key is preflighted before the first claim and before the article is
   sent. DeepSeek: `GET /user/balance`. Gemini and Qwen: one tiny completion with a fixed prompt.
   The caller returns a category and a short message, never the raw body. Classification uses the
   status and the provider error code.

   | Category | Meaning |
   |---|---|
   | `invalid_key` | DeepSeek 401. Qwen 401 `invalid_api_key`, including a key from another region. A Gemini key the API rejects, including a standard key. |
   | `no_balance` | DeepSeek 402. DeepSeek balance `is_available: false`. Qwen quota, arrears, or exhausted balance, including when the status is 429. Gemini quota or depleted balance. Not retried. |
   | `rate_limited` | DeepSeek 429. Qwen 429 only when the code says throttling. May be retried, then the run stops. |
   | `unavailable` | 500, 503, or overload. |
   | `model_access_denied` | Qwen 403 when the model is not purchased or not authorized. Not `invalid_key`. |

   None of these fall back to the site key. A passed preflight does not promise the rest of the run.
4. The key header is not logged. That is not sufficient. A provider body that echoes the key is
   dropped, and any stored or logged error string is scrubbed before the write.
5. `POST /extract` still returns `{id, shareToken}` only. `provider` and `model` are added to the
   Redis meta hash (what `GET /status/:id` renders), to `StatusResponseSchema`, to
   `SharedAssessmentSchema`, and to the column list in `selectGrounnelRunByShareToken`. Neither
   payload includes the key or `key_source`.

## CORS

The site backend adds both headers to `Access-Control-Allow-Headers`. The browser calls the site's
own origin, so no new origin is allowed.
