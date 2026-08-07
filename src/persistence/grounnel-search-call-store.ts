import { insertGrounnelSearchCall } from "../db/queries.js";
import { logger } from "../observability/logger.js";
import type { SourceStatus } from "../providers/search/search-provider.js";

const MODULE = "grounnel-search-call-store";

export interface GrounnelSearchCallStore {
  /** Fire-and-forget (D023 §7) — never awaited by the caller, never throws. */
  recordSearchCall(data: {
    runId: string;
    claimId: string;
    query: string;
    callType: "diy_fetch" | "tavily_fallback";
    url: string | null;
    resultCount: number;
    status: SourceStatus;
    durationMs: number;
  }): void;
}

/** D023 §6 — closes the real gap this session found: Tavily-fallback usage previously had no durable tracking at all, only short-retention Vercel logs. */
export class DrizzleGrounnelSearchCallStore implements GrounnelSearchCallStore {
  recordSearchCall(data: Parameters<GrounnelSearchCallStore["recordSearchCall"]>[0]): void {
    void insertGrounnelSearchCall(data).catch((err) => {
      logger.warn({ module: MODULE, operation: "recordSearchCall", runId: data.runId, err }, "Failed to write grounnel_search_calls row — Redis remains authoritative (D023 §7)");
    });
  }
}
