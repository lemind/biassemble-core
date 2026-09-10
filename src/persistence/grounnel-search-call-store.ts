import { waitUntil } from "@vercel/functions";
import { insertGrounnelLlmCall, insertGrounnelSearchCall, insertGrounnelSearchPage } from "../db/queries.js";
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
    // D026 §19 — "not_attempted" is telemetry-only, deliberately not part of the public-facing
    // SourceStatus union; logged for a discoverUrls() candidate beyond fetchCap that was never fetched.
    status: SourceStatus | "not_attempted";
    durationMs: number;
    // D026 §19 — the cleaned excerpt actually extracted, "ok" DIY fetches only. Stored in a
    // separate table (grounnel_search_pages, see schema.ts) — stripped out before the
    // grounnel_search_calls insert below, not a column on that table.
    excerpt?: string;
  }): void;

  /** Grounding calls bypass callLlmForJson, so their tokens were invisible — 37% of the September
   *  bill. Fire-and-forget like the above; never awaited, never throws. */
  recordDiscoveryCall(data: {
    runId: string;
    claimId: string;
    model: string;
    /** false once the maxOutputTokens cap returned no candidates and we retried without it. */
    capped: boolean;
    status: "success" | "error";
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    startedAt: Date;
    endedAt: Date;
    durationMs: number;
    errorMessage: string | null;
  }): void;
}

/** D023 §6 — closes the real gap this session found: Tavily-fallback usage previously had no durable tracking at all, only short-retention Vercel logs. */
export class DrizzleGrounnelSearchCallStore implements GrounnelSearchCallStore {
  recordSearchCall(data: Parameters<GrounnelSearchCallStore["recordSearchCall"]>[0]): void {
    try {
      this.write(data);
    } catch (err) {
      // Telemetry must never reach the caller: one call site runs inside Promise.all, where a
      // synchronous throw rejects the whole wave and costs the claim every candidate.
      logger.warn({ module: MODULE, operation: "recordSearchCall", runId: data.runId, err }, "Search-call telemetry failed — continuing");
    }
  }

  private write(data: Parameters<GrounnelSearchCallStore["recordSearchCall"]>[0]): void {
    const { excerpt, ...callData } = data;
    waitUntil(
      insertGrounnelSearchCall(callData).catch((err) => {
        logger.warn({ module: MODULE, operation: "recordSearchCall", runId: data.runId, err }, "Failed to write grounnel_search_calls row — Redis remains authoritative (D023 §7)");
      })
    );
    if (excerpt && data.url) {
      waitUntil(
        insertGrounnelSearchPage({ runId: data.runId, claimId: data.claimId, url: data.url, excerpt }).catch((err) => {
          logger.warn({ module: MODULE, operation: "recordSearchCall", runId: data.runId, err }, "Failed to write grounnel_search_pages row");
        })
      );
    }
  }

  recordDiscoveryCall(data: Parameters<GrounnelSearchCallStore["recordDiscoveryCall"]>[0]): void {
    const { capped, model, ...rest } = data;
    waitUntil(
      insertGrounnelLlmCall({
        ...rest,
        stage: "discovery",
        callType: capped ? "url_discovery" : "url_discovery_uncapped",
        provider: "gemini",
        model,
        promptVersion: "n/a",
        rawResponse: null,
        parsedOutput: null,
        failureType: data.status === "error" ? "provider_error" : null,
      }).catch((err) => {
        logger.warn({ module: MODULE, operation: "recordDiscoveryCall", runId: data.runId, err }, "Failed to write grounnel_llm_calls row for a discovery call");
      })
    );
  }
}
