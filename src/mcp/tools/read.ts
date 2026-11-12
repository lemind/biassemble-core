import type { CallToolResult } from "@modelcontextprotocol/server";
import { logger } from "../../observability/logger.js";
import { isShareTokenShape } from "../../lib/share-token.js";
import type { SharedAssessment } from "../../contracts/grounnel.schemas.js";
import { mcpError, mcpResult } from "../errors.js";
import { SHARE_URL_BASE } from "./start.js";

const MODULE = "mcp-read";
const READ_AFTER_SECONDS = 10;
const UNAVAILABLE = "Grounnel can't read checks right now. Try again shortly.";

type Limiter = { consume(id: string): Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }> };

export interface ReadToolDeps {
  tokenLimiter: Limiter;
  globalLimiter: Limiter;
  readAssessment: (shareToken: string) => Promise<SharedAssessment | null>;
}

/** Postgres status → the contract's status and phase. A failed run is a normal result, not an error. */
export function mapStatus(status: SharedAssessment["status"]): { status: "running" | "done" | "failed"; phase: "extracting" | "verifying" | null } {
  if (status === "extracting" || status === "verifying") return { status: "running", phase: status };
  return { status, phase: null };
}

/** The share page's payload in the contract's shape (contracts/mcp-tools.md). */
export function projectAssessment(shareToken: string, run: SharedAssessment): Record<string, unknown> {
  const { status, phase } = mapStatus(run.status);
  return {
    status,
    phase,
    // Claims are stored as they finish, so the total is only known at the end; start_fact_check reported claimsFound.
    progress: { finished: run.claims.length, total: status === "running" ? null : run.claims.length },
    readAfterSeconds: status === "running" ? READ_AFTER_SECONDS : null,
    failureReason: run.failureReason ?? null,
    provider: run.provider,
    model: run.model,
    capHit: run.truncated ?? false,
    counts: run.counts ?? null,
    tokens: run.ownKeyTokens,
    shareUrl: `${SHARE_URL_BASE}${shareToken}`,
    claims: run.claims.map((c) => ({
      text: c.text,
      status: c.status,
      verdict: c.verdict,
      confidence: c.confidence,
      reason: c.reason,
      sources: c.sources,
      citations: c.citations,
    })),
  };
}

/** get_fact_check: read limits (fail closed), then the share route's own read. */
export async function handleGetFactCheck(args: { shareToken?: unknown }, deps: ReadToolDeps): Promise<CallToolResult> {
  const shareToken = typeof args.shareToken === "string" ? args.shareToken.trim() : "";
  if (!isShareTokenShape(shareToken)) return mcpError("not_found", "No check has this share token.");

  try {
    const global = await deps.globalLimiter.consume("");
    if (!global.allowed) return mcpError("rate_limited", "Grounnel is busy. Try again shortly.", global.retryAfterSeconds);
    const perToken = await deps.tokenLimiter.consume(shareToken);
    if (!perToken.allowed) return mcpError("rate_limited", "This check has been read too often this hour.", perToken.retryAfterSeconds);
  } catch (err) {
    logger.error({ module: MODULE, operation: "get_fact_check", err }, "Redis unavailable before read — refusing");
    return mcpError("service_unavailable", UNAVAILABLE);
  }

  let run: SharedAssessment | null;
  try {
    run = await deps.readAssessment(shareToken);
  } catch (err) {
    logger.error({ module: MODULE, operation: "get_fact_check", err }, "Shared assessment read failed");
    return mcpError("service_unavailable", UNAVAILABLE);
  }
  if (!run) return mcpError("not_found", "No check has this share token.");
  return mcpResult(projectAssessment(shareToken, run));
}
