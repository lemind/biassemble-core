import { describe, it, expect } from "vitest";
import { failureReasonOf } from "../../../../src/orchestrators/grounnel/failure-reason.js";
import { ProviderError, RateLimitError, TimeoutError } from "../../../../src/providers/types.js";
import { InjectionSuspectedError } from "../../../../src/orchestrators/audit/injection-guard.js";

describe("failureReasonOf", () => {
  it.each([
    [new RateLimitError("x", "billing"), "provider_quota"],
    [new RateLimitError("x", "daily"), "provider_quota"],
    [new RateLimitError("x", "per-minute"), "provider_rate_limited"],
    [new ProviderError("no_balance", "x"), "provider_quota"],
    [new ProviderError("rate_limited", "x"), "provider_rate_limited"],
    [new ProviderError("unavailable", "x"), "provider_unavailable"],
    [new ProviderError("invalid_key", "x"), "provider_unavailable"],
    [new ProviderError("model_access_denied", "x"), "provider_unavailable"],
    [new TimeoutError("x"), "provider_unavailable"],
    [new InjectionSuspectedError("verify"), "provider_invalid_response"],
    [new Error("boom"), "pipeline"],
    ["not an error", "pipeline"],
  ])("maps %s to %s", (err, reason) => {
    expect(failureReasonOf(err)).toBe(reason);
  });
});
