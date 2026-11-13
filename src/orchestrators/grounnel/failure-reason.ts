import { ProviderError, RateLimitError, TimeoutError } from "../../providers/types.js";
import { InjectionSuspectedError } from "../audit/injection-guard.js";
import type { GrounnelFailureReason } from "../../db/schema.js";

/** Maps the error that ended a run to its stored failure_reason. Anything unrecognised is `pipeline` (D034). */
export function failureReasonOf(err: unknown): GrounnelFailureReason {
  if (err instanceof RateLimitError) return err.limitType === "per-minute" ? "provider_rate_limited" : "provider_quota";
  if (err instanceof ProviderError) {
    if (err.category === "no_balance") return "provider_quota";
    if (err.category === "rate_limited") return "provider_rate_limited";
    return "provider_unavailable";
  }
  if (err instanceof TimeoutError) return "provider_unavailable";
  if (err instanceof InjectionSuspectedError) return "provider_invalid_response";
  return "pipeline";
}
