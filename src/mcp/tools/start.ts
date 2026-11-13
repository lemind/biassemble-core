import type { CallToolResult } from "@modelcontextprotocol/server";
import { logger } from "../../observability/logger.js";
import type { Provider, ProviderErrorCategory } from "../../providers/types.js";
import type { SharedAssessment } from "../../contracts/grounnel.schemas.js";
import type { StartCheckInput, StartCheckResult } from "../../orchestrators/grounnel/start-check.js";
import { mcpError, mcpResult } from "../errors.js";
import { keyHmac, textHmac } from "../fingerprint.js";
import { reservationKey, type RequestTokenReservations } from "../reservation.js";
import { mcpStartsDisabled, type SwitchRedisClient } from "../switch.js";

const MODULE = "mcp-start";
const PROVIDERS = ["gemini", "deepseek", "qwen"] as const;
export const MAX_TEXT_CHARS = 20_000;
const REQUEST_TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/;
const READ_AFTER_SECONDS = 15;
const IN_PROGRESS_RETRY_SECONDS = 5;
export const SHARE_URL_BASE = "https://grounnel.n30sk.cc/check/";

const UNAVAILABLE = "Grounnel can't start checks right now. Try again shortly.";

export interface StartToolDeps {
  secret: string | undefined;
  switchRedis: SwitchRedisClient;
  reservations: RequestTokenReservations;
  startLimiter: { consume(id: string): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> };
  buildProvider: (id: (typeof PROVIDERS)[number], key: string) => Provider;
  startCheck: (input: StartCheckInput) => Promise<StartCheckResult>;
  readAssessment: (shareToken: string) => Promise<SharedAssessment | null>;
}

function header(headers: Headers | undefined, name: string): string | undefined {
  const value = headers?.get(name)?.trim();
  return value ? value : undefined;
}

function preflightCode(category: ProviderErrorCategory) {
  if (category === "no_balance") return "preflight_no_balance" as const;
  if (category === "rate_limited") return "preflight_provider_rate_limited" as const;
  if (category === "unavailable") return "preflight_provider_unavailable" as const;
  return "preflight_invalid_key" as const;
}

function started(shareToken: string, status: "running" | "done", phase: "extracting" | "verifying" | null, claimsFound: number): CallToolResult {
  return mcpResult({
    shareToken,
    shareUrl: `${SHARE_URL_BASE}${shareToken}`,
    status,
    phase,
    claimsFound,
    readAfterSeconds: status === "done" ? null : READ_AFTER_SECONDS,
  });
}

/** A retry that finds its check already created gets that check back, with no new allowance. */
async function replay(deps: StartToolDeps, shareToken: string): Promise<CallToolResult> {
  const run = await deps.readAssessment(shareToken);
  if (!run) return started(shareToken, "running", "extracting", 0);
  const running = run.status === "extracting" || run.status === "verifying";
  return started(shareToken, running ? "running" : "done", running ? run.status as "extracting" | "verifying" : null, run.claims.length);
}

/** start_fact_check, in the plan's order (plan.md "Order inside start_fact_check"). The key never reaches a log or a result. */
export async function handleStartFactCheck(
  args: { text?: unknown; requestToken?: unknown },
  headers: Headers | undefined,
  deps: StartToolDeps,
): Promise<CallToolResult> {
  // 1. Headers and input: no Redis, no spend. No HTTP context counts as missing headers.
  const key = header(headers, "x-grounnel-provider-key");
  if (!key) return mcpError("key_required", "Set your own provider key in the X-Grounnel-Provider-Key connection header.");
  const providerId = header(headers, "x-grounnel-provider");
  if (!providerId) return mcpError("provider_not_chosen", "Set X-Grounnel-Provider to gemini, deepseek or qwen in the connection settings.");
  if (!(PROVIDERS as readonly string[]).includes(providerId)) {
    return mcpError("unsupported_provider", "X-Grounnel-Provider must be gemini, deepseek or qwen.");
  }
  const provider = providerId as (typeof PROVIDERS)[number];

  const text = typeof args.text === "string" ? args.text : "";
  if (text.trim().length === 0) return mcpError("empty_text", "There is no text to check.");
  if (text.length > MAX_TEXT_CHARS) return mcpError("text_too_large", `The text is over ${MAX_TEXT_CHARS} characters.`);
  const requestToken = args.requestToken;
  if (requestToken !== undefined && (typeof requestToken !== "string" || !REQUEST_TOKEN_RE.test(requestToken))) {
    return mcpError("invalid_request_token", "requestToken must be 1-128 letters, digits, '-' or '_'.");
  }
  if (!deps.secret) return mcpError("service_unavailable", UNAVAILABLE);

  const kh = keyHmac(deps.secret, provider, key);
  let lease: { key: string; owner: string } | undefined;
  try {
    // 2. Switch. 3. Reservation. 4. Allowance. Any Redis error fails closed (D034 §6).
    if (await mcpStartsDisabled(deps.switchRedis)) return mcpError("service_unavailable", UNAVAILABLE);

    if (typeof requestToken === "string") {
      const rk = reservationKey(provider, kh, requestToken);
      const outcome = await deps.reservations.reserve(rk, textHmac(deps.secret, text));
      if (outcome.kind === "conflict") return mcpError("token_conflict", "This request token was already used for a different text. Use a new token for a new check.");
      if (outcome.kind === "in_progress") return mcpError("in_progress", "A start with this request token is still running.", IN_PROGRESS_RETRY_SECONDS);
      if (outcome.kind === "created") return await replay(deps, outcome.shareToken);
      lease = { key: rk, owner: outcome.owner };
    }

    const allowance = await deps.startLimiter.consume(kh);
    if (!allowance.allowed) {
      if (lease) await deps.reservations.release(lease.key, lease.owner);
      return mcpError("rate_limited", "This key has used its hourly allowance of checks.", allowance.retryAfterSeconds);
    }
  } catch (err) {
    logger.error({ module: MODULE, operation: "start_fact_check", err }, "Redis unavailable before start — refusing");
    return mcpError("service_unavailable", UNAVAILABLE);
  }

  // 5. The website's own start path. The reservation turns created the moment the run row exists.
  const held = lease;
  let result: StartCheckResult;
  try {
    result = await deps.startCheck({
      text,
      sessionId: null,
      searchEngine: "defaultFlow",
      provider: deps.buildProvider(provider, key),
      keySource: "own",
      entryPoint: "mcp",
      ownKey: key,
      ...(held ? { onRunCreated: async (shareToken: string) => void (await deps.reservations.markCreated(held.key, held.owner, shareToken)) } : {}),
    });
  } catch (err) {
    logger.error({ module: MODULE, operation: "start_fact_check", provider, err }, "Start path threw");
    result = { ok: false, kind: "extraction_failed", error: err };
  }

  if (!result.ok) {
    if (held) await deps.reservations.release(held.key, held.owner).catch(() => undefined);
    logger.warn({ module: MODULE, operation: "start_fact_check", provider, kind: result.kind }, "MCP start refused");
    if (result.kind === "preflight") return mcpError(preflightCode(result.failure.category), result.failure.message);
    if (result.kind === "rate_limited") return mcpError("extraction_failed", "The provider rate-limited the key while reading the text. Try again later.");
    return mcpError("extraction_failed", "Grounnel couldn't read claims from the text. No check was created.");
  }

  // 6. Reply. Eligibility and the pipeline already run after this, inside startCheck.
  const checkable = result.pendingClaims.length;
  // "extracting" until the pipeline marks the run verifying, the same phase the first read reports.
  return started(result.shareToken, checkable > 0 ? "running" : "done", checkable > 0 ? "extracting" : null, checkable);
}
