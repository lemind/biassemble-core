# Data Model: Grounnel as an MCP Server

**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## Postgres: `grounnel.grounnel_runs` (migration 0019)

| Column | Change | Values | Notes |
|---|---|---|---|
| `entry_point` | new, nullable text enum | `website`, `mcp`, `eval` | Set by the server at run creation. Existing rows stay null (FR-019): their origin can't be proven. Independent of `source` (`production`/`eval`). |
| `failure_reason` | new, nullable text enum | `provider_quota`, `provider_rate_limited`, `provider_unavailable`, `provider_invalid_response`, `time_limit`, `pipeline` | Written once, when a run ends `failed`. Null for `done` runs and for historical rows. |
| `truncated` | unchanged | boolean | Already the cap flag. Now also returned to MCP readers. |

No column holds a key, a key fingerprint, or a request token.

## Redis (Upstash), all with TTL

| Key | Value | TTL | Purpose |
|---|---|---|---|
| `ratelimit:mcp-start:{keyHmac}` | counter | 3600 s, fixed window | 30 MCP starts per provider key per hour (FR-014). `keyHmac` = HMAC-SHA-256(`MCP_HMAC_SECRET`, `"key:" + provider + ":" + key`), hex. |
| `ratelimit:mcp-read:{shareToken}` | counter | 3600 s | Per-check read limit (FR-015). |
| `ratelimit:mcp-read-global` | counter | 60 s | Global read ceiling (FR-015). |
| `mcp:reqtok:{provider}:{keyHmac}:{requestToken}` | JSON `{ state, owner, textHmac, shareToken? }` | 120 s while `pending`, 3600 s once `created` | Retry-token reservation (FR-003a). Created with `SET NX`. `owner` is a random id; only the owner advances or releases it. `textHmac` = HMAC-SHA-256(`MCP_HMAC_SECRET`, `"text:" + exact UTF-8 text`), hex. |
| `grounnel:mcp:starts-disabled` | `"1"` when present | none | Emergency switch (FR-014b). Absent means starts are on. |

The `"key:"` and `"text:"` prefixes keep the two HMAC purposes apart under one secret.

### Reservation states

```
(absent) --SET NX, 120 s lease--> pending --run row written--> created {shareToken}, 3600 s
                                     |--failure before the run exists--> (deleted by owner)
                                     \--owner died, lease ran out--> (absent)
```

- A second start that finds `pending` gets `in_progress` (retryable).
- One that finds `created` with the same `textHmac` gets the stored share token and uses no
  allowance, even if the first process died after creating the run.
- One that finds any state with a different `textHmac` gets `token_conflict`.
- Rotating `MCP_HMAC_SECRET` orphans every reservation along with the limit buckets.

## New environment variables

| Name | Where | Notes |
|---|---|---|
| `MCP_HMAC_SECRET` | core, Production and Preview | 32+ random bytes, the same everywhere, stable across deploys. Rotating it resets all allowances and orphans open reservations (FR-014a). |
