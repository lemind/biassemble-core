# D034 — Grounnel as an MCP server

Status: **decided, being implemented.** Spec: `specs/021-mcp-server/`.

## §1. Two tools and polling

`start_fact_check` starts a check and returns at once with a share token. `get_fact_check` reads it.
A check takes up to a few minutes, longer than an assistant should hold one tool call open. Native
MCP tasks are optional in revision 2026-07-28 and no measured client supports them, so the
assistant polls with `readAfterSeconds`.

## §2. Who pays

The user's config carries one key: their LLM provider key. It pays extraction and verification.
Search stays on the site's keys: Gemini grounding and Tavily. Every MCP check therefore costs the
site its search share. The per-key limit (§4) and the switch (§6) bound that spend; there is no
global spend ceiling in this slice. Decided 2026-11-02.

## §3. No queue

The start tool runs the same start path as `POST /extract`: preflight, extraction, reply, then
`waitUntil` for eligibility and the pipeline. The key stays in the memory of that one invocation and
is never written into a job payload, row, cache, log or stored error. A run the invocation does not
finish is settled by the stuck-run reaper (spec 018) as failed with `failure_reason = time_limit`.

## §4. Limits per key fingerprint

Claude's connectors and Cursor call from cloud addresses shared by all their users (spec research
R2), so a per-address limit would block everyone behind one heavy user. MCP starts are limited to
30 an hour per provider key, keyed by `HMAC-SHA-256(MCP_HMAC_SECRET, "key:" + provider + ":" + key)`.
The HMAC lives only as a Redis key name with a one-hour TTL. Several keys give several allowances;
accepted. Reads are limited per share token (360/h) and by a global ceiling (3000/60 s).

The website keeps its per-address limits and stores no fingerprint, so its "never stored, not even
hashed" promise stays true.

`MCP_HMAC_SECRET` must be the same on every instance and stable across deploys. Unset, every MCP
start is refused as `service_unavailable`; the service still boots. Rotating it resets allowances
and orphans open reservations, so a retry within an hour of a rotation can start a second check.

## §5. Request-token reservation

A start may carry a request token so a retried call does not start a second check. The
reservation is a 120 s `pending` lease with a random owner id (`SET NX`); only the owner advances or
releases it. When the run row exists, `startCheck` calls `onRunCreated` and the reservation becomes
`created` with the share token for an hour. A process that dies before the run exists lets the
lease expire; one that dies after leaves `created`, and the retry gets that share token.

## §6. Fail closed, and a switch

If Redis is unreachable, starts and reads return `service_unavailable`; no start runs without a
reserved allowance. The Redis key `grounnel:mcp:starts-disabled` turns MCP starts off without a
deploy (`scripts/mcp-starts.ts`).

## §7. Protocol

SDK v2 (`@modelcontextprotocol/server` 2.4.0) serves revision 2026-07-28 and, by default, falls back
to stateless 2025 serving. Every measured client (Claude Code, Cursor) still speaks 2025-11-25. The
SDK validates arguments against `inputSchema` before the handler and answers with its own generic
error, so the registered schemas are permissive and the handler checks lengths and patterns itself
to return our error codes.

## §8. Entry point and failure reason

`grounnel_runs.entry_point` (`website | mcp | eval`) records the door that started a run, separate
from `source`. Rows from before migration 0019 stay null: their origin can't be proven.

`failure_reason` is written once: when a run ends failed, or when the provider stops a run partway.
A stopped run still ends `done` with the rest of its claims unchecked, exactly as the website has
always shown it; only the reason is new (decided 2026-11-11). So `done` with a reason means
"stopped early", and the MCP read passes it on.

| Error | Reason |
|---|---|
| `RateLimitError` billing or daily, `ProviderError` no_balance | `provider_quota` |
| `RateLimitError` per-minute, `ProviderError` rate_limited | `provider_rate_limited` |
| `ProviderError` unavailable, invalid_key, model_access_denied; `TimeoutError` | `provider_unavailable` |
| `InjectionSuspectedError` | `provider_invalid_response` |
| run settled by the reaper | `time_limit` |
| anything else | `pipeline` |

A key that passed preflight and then fails as invalid or denied mid-run reads as the provider being
unavailable; the enum has no separate value for it.
