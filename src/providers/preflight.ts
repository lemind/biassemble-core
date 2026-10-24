/** Own-key probe before the article or any claim is sent. A pass does not change later claim handling (D033 §3). */
import { logger } from "../observability/logger.js";
import { ProviderError, RateLimitError, TimeoutError, type Provider, type ProviderErrorCategory } from "./types.js";

const MODULE = "preflight";

/** SC-005. The probe returns inside this bound even when the provider call does not. */
export const PREFLIGHT_TIMEOUT_MS = 10_000;

/** Fixed text. It is not the visitor's article and not a claim (D033 §3). */
export const PREFLIGHT_PROMPT = "Reply with ok.";

const UNAVAILABLE = "The provider is unavailable.";

export interface PreflightFailure {
  category: ProviderErrorCategory;
  message: string;
}

/** Null means the key was accepted. A missing probe fails closed so the article is not sent. */
export async function preflightOwnKey(provider: Provider): Promise<PreflightFailure | null> {
  if (!provider.preflight) {
    logger.warn({ module: MODULE, operation: "preflightOwnKey", provider: provider.mode }, "preflight is not implemented");
    return { category: "unavailable", message: UNAVAILABLE };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      provider.preflight(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError("provider call timed out")), PREFLIGHT_TIMEOUT_MS);
      }),
    ]);
    return null;
  } catch (err) {
    return toPreflightFailure(err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function preflightHttpStatus(category: ProviderErrorCategory): 400 | 429 | 503 {
  if (category === "rate_limited") return 429;
  if (category === "unavailable") return 503;
  return 400;
}

function toPreflightFailure(err: unknown): PreflightFailure {
  if (err instanceof ProviderError) return { category: err.category, message: err.message };
  if (err instanceof RateLimitError) return { category: "rate_limited", message: err.message };
  return { category: "unavailable", message: UNAVAILABLE };
}
