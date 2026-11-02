# Contract: Grounnel MCP tools

**Endpoint**: `POST https://mcp.grounnel.n30sk.cc/mcp` (served by biassemble-core; see plan)
**Protocol**: MCP 2026-07-28 Streamable HTTP, stateless, with the SDK's stateless fallback for
2025-era clients. `server/discover` answered. Origin header, when present, must be on the
allow-list (empty by default, so browser-originated calls are refused).

**Connection headers** (set once in the client):

| Header | Required | Values |
|---|---|---|
| `X-Grounnel-Provider` | for `start_fact_check` | `gemini`, `deepseek`, `qwen` |
| `X-Grounnel-Provider-Key` | for `start_fact_check` | the user's own provider key |

Tool listing, discovery and `get_fact_check` work without either header. These are the only keys
a client sends: search (Gemini grounding, Tavily) runs on Grounnel's own keys and is paid by
Grounnel.

## Tool `start_fact_check`

Annotations: `readOnlyHint: false`, `idempotentHint: false`, `openWorldHint: true`.

Description (sent to the assistant, wording per FR-013/FR-008): starts a fact-check of a text and
returns at once; read the result with `get_fact_check` after `readAfterSeconds`. The text goes to
the provider chosen in the connection settings and to Grounnel's own Google (Gemini) and Tavily
accounts for search; the text and results are published at a permanent link anyone with it can
open. Confirm with the user before checking anything sensitive. A check takes up to a few minutes.
Generate a unique request token for each new check. If the start call times out and you retry that
same check, reuse the same token and the exact same text. Never reuse a token for a different check.

The registered input schema is deliberately loose (`text: string`, `requestToken?: string`): the SDK
would answer a schema failure with its own generic error, so the length and pattern rules below are
checked by the handler, which returns the codes in the error table.

**Input**
```json
{ "text": "string, 1–20000 chars", "requestToken": "optional, ^[A-Za-z0-9_-]{1,128}$" }
```

**Output** (`structuredContent`, also serialised as one text block)
```json
{ "shareToken": "string", "shareUrl": "https://grounnel.n30sk.cc/check/<token>",
  "status": "running", "phase": "verifying", "claimsFound": 7, "readAfterSeconds": 15 }
```
`claimsFound` is 0 and `status` is `done` when the text had no checkable claims.

## Tool `get_fact_check`

Annotations: `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false`.

**Input**: `{ "shareToken": "string" }`

**Output**
```json
{
  "status": "running | done | failed",
  "phase": "extracting | verifying | null",
  "progress": { "finished": 3, "total": 7 },
  "readAfterSeconds": 10,
  "failureReason": "null | provider_quota | provider_rate_limited | provider_unavailable | provider_invalid_response | time_limit | pipeline",
  "provider": "qwen", "model": "qwen3.7-flash",
  "capHit": false,
  "counts": { "supported": 2, "contradicted": 1, "...": 0 },
  "tokens": { "input": 96021, "output": 5255 },
  "shareUrl": "https://grounnel.n30sk.cc/check/<token>",
  "claims": [{
    "text": "…", "status": "done | failed", "verdict": "supported | partially_supported | unsupported | contradicted | unverifiable | excluded | null",
    "confidence": 0.9, "reason": "…",
    "sources": [{ "title": "…", "domain": "…", "url": "…", "status": "ok" }],
    "citations": [{ "source": "S1", "sentence": 4, "url": "…", "text": "the exact sentence" }]
  }]
}
```
`readAfterSeconds` is null once `status` is `done` or `failed`. A `failed` check is a successful
read (no `isError`), with `failureReason` and every finished claim.

## Errors

Every tool-level failure is a `CallToolResult` with `isError: true` and this structured content:
```json
{ "code": "string", "message": "one plain sentence", "retryAfterSeconds": null }
```

| Code | Tool | When |
|---|---|---|
| `key_required` | start | no `X-Grounnel-Provider-Key` |
| `provider_not_chosen` | start | no `X-Grounnel-Provider` |
| `unsupported_provider` | start | provider header not one of the three |
| `empty_text` / `text_too_large` / `invalid_request_token` | start | input checks |
| `token_conflict` | start | same request token, different text |
| `in_progress` | start | same request token, first start still running (`retryAfterSeconds` 5) |
| `rate_limited` | start, read | Grounnel's own limit (`retryAfterSeconds` = seconds left in the window, from the counter's TTL) |
| `preflight_invalid_key` / `preflight_no_balance` / `preflight_provider_rate_limited` / `preflight_provider_unavailable` | start | key preflight |
| `extraction_failed` | start | extraction errored; no check exists |
| `service_unavailable` | start, read | Redis unreachable (both tools fail closed); for start also MCP starts switched off, or `MCP_HMAC_SECRET` not set |
| `not_found` | read | unknown share token |

Malformed JSON-RPC, unknown methods and protocol-version mismatches are protocol errors, answered by
the SDK as the specification defines.
