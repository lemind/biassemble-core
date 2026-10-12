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
2. On `POST /extract`: `gemini` without a key → site key. `deepseek` or `qwen` without a key →
   `400 provider_requires_own_key`. The eval job does not call this route. It builds the provider
   in-process with the deployment keys, which is the FR-009 exception for the comparison.
3. Key present → validated against the chosen provider before the first claim. Each provider maps
   its own HTTP status onto one shared error type. The caller returns a category, never the raw body:
   `401 invalid_key`, `402 no_balance`, `429 provider_rate_limited`, `503 provider_unavailable`.
   A 402 is not retried. A DeepSeek 429 may be retried, and then the run stops. A Gemini quota or
   depleted-balance error is not retried. None of these fall back to the site key.
4. The key header is not logged. That is not sufficient. A provider body that echoes the key is
   dropped, and any stored or logged error string is scrubbed before the write.
5. `POST /extract` still returns `{id, shareToken}` only. `provider` and `model` are added to the
   Redis meta hash (what `GET /status/:id` renders), to `StatusResponseSchema`, to
   `SharedAssessmentSchema`, and to the column list in `selectGrounnelRunByShareToken`. Neither
   payload includes the key or `key_source`.

## CORS

The site backend adds both headers to `Access-Control-Allow-Headers`. The browser calls the site's
own origin, so no new origin is allowed.
