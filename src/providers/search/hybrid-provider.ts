import { logger } from "../../observability/logger.js";
import type { SearchProvider, SearchPassage, SourceStatus } from "./search-provider.js";
import type { GrounnelSearchCallStore } from "../../persistence/grounnel-search-call-store.js";

const MODULE = "hybrid-search-provider";
const GEMINI_GENERATE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_CANDIDATES = 3;
// D021's research methodology bar — below this, a 200 is more likely a paywall/consent-wall
// stub than real content (a common pattern: short "subscribe to continue" pages still return 200).
const MIN_TEXT_LENGTH = 800;
const FETCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
// D021 "Do not" — real rate-limit handling required. Applies to both the Gemini discovery call
// and individual page fetches (D021 names a third-party rate-limit hit too, not just Gemini's).
const DISCOVERY_ATTEMPTS = 2;
const CANDIDATE_FETCH_ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;
// No timeout previously — a hanging (not erroring, not timing out at the TCP level) candidate
// URL blocked Promise.all indefinitely, up to Vercel's 300s hard kill. Confirmed in production.
const DISCOVERY_TIMEOUT_MS = 15_000;
const CANDIDATE_FETCH_TIMEOUT_MS = 10_000;

// Blocks obvious private/loopback/link-local targets before a server-side fetch — not a full SSRF defense (no DNS resolution), but closes the direct-IP-literal case for an LLM-returned URL.
const BLOCKED_HOSTNAME_RE =
  /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|::1)$/i;

interface GroundingChunk {
  web?: { uri?: string; title?: string };
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Parses and validates a candidate URL is safe to fetch — returns null if malformed or blocked. */
function parseSafeUrl(url: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (BLOCKED_HOSTNAME_RE.test(parsed.hostname)) return null;
  return parsed;
}

function statusFromHttpStatus(status: number): SourceStatus {
  return status === 403 ? "blocked" : "unreachable";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Strips a key embedded in a Gemini URL from an error message — a fetch() failure otherwise leaks the full key in err.message, past pino's redact. D021's research leaked a key this exact way once.
function sanitizeErrorForLogging(err: unknown): unknown {
  if (err instanceof Error) {
    const sanitized = new Error(err.message.replace(/key=[^&\s"]+/gi, "key=[REDACTED]"));
    sanitized.name = err.name;
    return sanitized;
  }
  return err;
}

// Strips <script>/<style> and tags, decodes common entities — no HTML-parsing dependency added; the dependency-free TS equivalent of D021's BeautifulSoup script (MVP-good, not a general parser).
function extractTextFromHtml(html: string): string {
  const withoutScripts = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*$/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*$/gi, " ");
  const withoutTags = withoutScripts.replace(/<[^>]+>/g, " ");
  return withoutTags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** D021 — Gemini's google_search for URL discovery only, never content/verdicts (D019 §3 still applies). DIY-fetches top candidates; falls back to `fallback` only when every DIY attempt fails. */
export class HybridSearchProvider implements SearchProvider {
  constructor(
    private readonly geminiApiKey: string,
    private readonly geminiModel: string,
    private readonly fallback: SearchProvider,
    private readonly searchCallStore: GrounnelSearchCallStore
  ) {}

  async search(query: string, context?: { runId: string; claimId: string; searchFlow?: "defaultFlow" | "tavily" }): Promise<SearchPassage[]> {
    if (context?.searchFlow === "tavily") {
      return this.runFallback(query, context);
    }

    const candidates = await this.discoverUrls(query);
    // Granularity, decided (D023 §6): one row per attempted DIY candidate — real per-URL
    // status/timing, matching this method's own "returns every attempted source" contract.
    const attempted = await Promise.all(
      candidates.slice(0, MAX_CANDIDATES).map(async (candidate) => {
        const t0 = Date.now();
        const result = await this.fetchCandidate(candidate);
        if (context) {
          this.searchCallStore.recordSearchCall({
            runId: context.runId,
            claimId: context.claimId,
            query,
            callType: "diy_fetch",
            url: result.url,
            resultCount: 1,
            status: result.status,
            durationMs: Date.now() - t0,
          });
        }
        return result;
      })
    );

    if (attempted.some((p) => p.status === "ok")) {
      return attempted;
    }

    logger.info(
      { module: MODULE, operation: "search", query, attempted: attempted.length },
      "DIY fetch failed for every candidate — falling back"
    );
    const fallbackResults = await this.runFallback(query, context);
    return [...attempted, ...fallbackResults];
  }

  /** Shared by the natural "every DIY candidate failed" path and `forceFallback` (test/debug escape hatch). */
  private async runFallback(
    query: string,
    context?: { runId: string; claimId: string }
  ): Promise<SearchPassage[]> {
    const fallbackT0 = Date.now();
    const fallbackResults = await this.fallback.search(query);
    if (context) {
      // One row for the whole fallback call — Tavily's own HTTP call already returns multiple
      // results per call, not per-URL attempts the way DIY fetches are (D023 §6/T026).
      const fallbackStatus: SourceStatus = fallbackResults.some((p) => p.status === "rate_limited")
        ? "rate_limited"
        : fallbackResults.some((p) => p.status === "ok")
          ? "ok"
          : "unreachable";
      this.searchCallStore.recordSearchCall({
        runId: context.runId,
        claimId: context.claimId,
        query,
        callType: "tavily_fallback",
        url: null,
        resultCount: fallbackResults.length,
        status: fallbackStatus,
        durationMs: Date.now() - fallbackT0,
      });
    }
    return fallbackResults;
  }

  private async discoverUrls(query: string): Promise<Array<{ url: string; title: string }>> {
    const url = `${GEMINI_GENERATE_URL}/${this.geminiModel}:generateContent?key=${this.geminiApiKey}`;
    const body = {
      contents: [{ parts: [{ text: `Use the google_search tool to search the web and check this claim: "${query}"` }] }],
      tools: [{ google_search: {} }],
    };

    let lastError: unknown;
    for (let attempt = 1; attempt <= DISCOVERY_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        });
        if (!response.ok) {
          logger.warn(
            { module: MODULE, operation: "discoverUrls", query, attempt, status: response.status },
            "Gemini grounding returned a non-OK status — retrying"
          );
          lastError = new Error(`Gemini grounding returned ${response.status}`);
          if (attempt < DISCOVERY_ATTEMPTS) await sleep(RETRY_DELAY_MS);
          continue;
        }
        const data = await response.json();
        const chunks: GroundingChunk[] = data?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
        const rawCandidates = chunks
          .filter((c) => c.web?.uri)
          .map((c) => ({ url: c.web!.uri!, title: c.web?.title ?? domainOf(c.web!.uri!) }));
        // Drop malformed/unsafe URLs here rather than fetching them or returning ClaimSourceSchema-breaking data — a malformed string has no valid url to report, so it's dropped, not included broken.
        const safe = rawCandidates.filter((c) => {
          const ok = parseSafeUrl(c.url) !== null;
          if (!ok) {
            logger.warn({ module: MODULE, operation: "discoverUrls", query, url: c.url }, "Dropping malformed/unsafe candidate URL");
          }
          return ok;
        });
        return safe;
      } catch (err) {
        lastError = err;
        logger.warn(
          { module: MODULE, operation: "discoverUrls", query, attempt, err: sanitizeErrorForLogging(err) },
          "Gemini grounding request failed — retrying"
        );
        if (attempt < DISCOVERY_ATTEMPTS) await sleep(RETRY_DELAY_MS);
      }
    }
    logger.warn(
      { module: MODULE, operation: "discoverUrls", query, err: sanitizeErrorForLogging(lastError) },
      "Gemini grounding failed after retries — zero candidates"
    );
    return [];
  }

  private async fetchCandidate(candidate: { url: string; title: string }): Promise<SearchPassage> {
    let lastNetworkError: unknown;
    for (let attempt = 1; attempt <= CANDIDATE_FETCH_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await fetch(candidate.url, {
          headers: { "User-Agent": FETCH_USER_AGENT },
          redirect: "follow",
          signal: AbortSignal.timeout(CANDIDATE_FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        lastNetworkError = err;
        logger.warn(
          { module: MODULE, operation: "fetchCandidate", url: candidate.url, attempt, err: sanitizeErrorForLogging(err) },
          "Candidate fetch failed (network error)"
        );
        if (attempt < CANDIDATE_FETCH_ATTEMPTS) await sleep(RETRY_DELAY_MS);
        continue;
      }

      if (!response.ok) {
        const finalUrl = response.url || candidate.url;
        const status = statusFromHttpStatus(response.status);
        // 403/blocked won't succeed on retry; only retry transient-looking failures (429, 5xx).
        if (status === "blocked" || response.status < 500 || attempt === CANDIDATE_FETCH_ATTEMPTS) {
          logger.warn(
            { module: MODULE, operation: "fetchCandidate", url: finalUrl, httpStatus: response.status, mappedStatus: status },
            "Candidate fetch returned a non-OK status"
          );
          return { url: finalUrl, title: candidate.title, domain: domainOf(finalUrl), status, text: null };
        }
        logger.warn(
          { module: MODULE, operation: "fetchCandidate", url: finalUrl, httpStatus: response.status, attempt },
          "Candidate fetch returned a retryable status — retrying"
        );
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      const html = await response.text();
      const text = extractTextFromHtml(html);
      const finalUrl = response.url || candidate.url;
      if (text.length < MIN_TEXT_LENGTH) {
        return { url: finalUrl, title: candidate.title, domain: domainOf(finalUrl), status: "paywalled", text: null };
      }
      return { url: finalUrl, title: candidate.title, domain: domainOf(finalUrl), status: "ok", text };
    }
    logger.warn(
      { module: MODULE, operation: "fetchCandidate", url: candidate.url, err: sanitizeErrorForLogging(lastNetworkError) },
      "Candidate fetch failed after retries"
    );
    return { url: candidate.url, title: candidate.title, domain: domainOf(candidate.url), status: "unreachable", text: null };
  }
}
