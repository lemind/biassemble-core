/** SearchProvider — D019 §2's provider abstraction scope: consumers depend on this narrow interface, never a vendor API. D021 amends the implementation, not this contract. */

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
  /** Which path produced this passage — lets an API consumer tell DIY vs Tavily apart without querying grounnel_search_calls. Optional: only HybridSearchProvider stamps it. */
  retrievalMethod?: "diy_fetch" | "tavily_fallback";
}

export interface SearchProvider {
  /**
   * Every attempted source, not just the successful one (§4.4). `context` is additive/optional —
   * only `HybridSearchProvider` reads it (D023 §6). `searchFlow: "tavily"` skips DIY fetch entirely
   * and goes straight to the fallback provider — lets a caller actually exercise that path on
   * demand (POST /extract's `searchEngine` param) instead of gambling on which URLs a live
   * grounding search happens to return.
   */
  /** `maxCandidates` (D026 §13, semantics changed by spec 017 T017) — how many USABLE pages to
   * fetch toward, not how many attempts to make; only
   * `HybridSearchProvider` reads it, escalation-only (default MAX_CANDIDATES when omitted). Tavily's
   * fallback already retains FALLBACK_RETAINED_CANDIDATES (8) regardless, so it ignores this field. */
  /** `failedUrlKeys` (spec 017 T017) — run-scoped set of pages already known unusable; only
   *  `HybridSearchProvider` reads it, and only after a redirect resolves. Optional and mutated in
   *  place: the provider adds every new failure it sees. */
  search(query: string, context?: { runId: string; claimId: string; searchFlow?: "defaultFlow" | "tavily"; maxCandidates?: number; failedUrlKeys?: Set<string> }): Promise<SearchPassage[]>;
}
