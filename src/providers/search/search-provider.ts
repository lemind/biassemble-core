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
}

export interface SearchProvider {
  /**
   * Resolves a claim/query to real, independently-fetched passage text. Returns every attempted
   * source, not just the successful one — failures are counted/shown, never silently dropped (§4.4).
   *
   * `context` (D023 §6) is additive/optional — a plain (string) implementation still satisfies
   * this interface unchanged; only `HybridSearchProvider` (the concrete class Grounnel's pipeline
   * actually uses) reads it, to attribute `grounnel_search_calls` rows to the real run/claim.
   */
  search(query: string, context?: { runId: string; claimId: string }): Promise<SearchPassage[]>;
}
