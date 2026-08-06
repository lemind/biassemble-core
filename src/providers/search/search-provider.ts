/**
 * SearchProvider — D019 §2 "provider abstraction scope": consumers depend on this narrow
 * interface (return relevant passage text for a query), never on a specific vendor's API.
 * D021 amends what implements it (hybrid Gemini-discovery/DIY-fetch/Tavily-fallback instead
 * of a single vendor call) without changing this contract.
 */

import type { z } from "zod";
import type { SourceStatusEnum } from "../../contracts/grounnel.schemas.js";

// Derived from grounnel.schemas.ts's SourceStatusEnum, not hand-duplicated — one definition, no drift risk.
export type SourceStatus = z.infer<typeof SourceStatusEnum>;

export interface SearchPassage {
  url: string;
  title: string;
  domain: string;
  status: SourceStatus;
  /** null whenever status !== "ok" — a failed fetch has no usable text. */
  text: string | null;
}

export interface SearchProvider {
  /**
   * Resolves a claim/query to real, independently-fetched passage text. Returns every
   * attempted source (not just the successful one) so failures are counted/shown, never
   * silently dropped (initial-context.md §4.4) — callers pick the first `status: "ok"`
   * result as evidence and keep the rest for the "sources tried" record.
   */
  search(query: string): Promise<SearchPassage[]>;
}
