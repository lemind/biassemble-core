import { logger } from "../../observability/logger.js";
import type { SearchProvider, SearchPassage, SourceStatus } from "./search-provider.js";

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

// Blocks the obvious private/loopback/link-local targets before a server-side fetch — not a
// full SSRF defense (doesn't resolve DNS to catch a hostname that rebinds to a private IP),
// but closes the direct-IP-literal case for a URL an LLM could return.
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

// Strips a key embedded in a Gemini request URL from an error's message before it's ever
// logged — a fetch() URL-parse failure otherwise puts the full key-bearing URL in err.message,
// which pino's redact (object key paths only, not string content) does not catch. D021's own
// research already leaked a key this exact way once (via a Python exception message).
function sanitizeErrorForLogging(err: unknown): unknown {
  if (err instanceof Error) {
    const sanitized = new Error(err.message.replace(/key=[^&\s"]+/gi, "key=[REDACTED]"));
    sanitized.name = err.name;
    return sanitized;
  }
  return err;
}

// Strips <script>/<style> (closed or unclosed — an unclosed tag left raw JS/CSS in the output
// before) and tags, decodes a handful of common entities — no HTML-parsing dependency added for
// this; D021's research script used Python's BeautifulSoup, this is the dependency-free TS
// equivalent (good enough for MVP text extraction, not a general HTML parser).
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

/**
 * D021 — Gemini's google_search tool for URL discovery only, never content/verdicts (D019 §3's
 * disqualification of native search stands unchanged). DIY-fetches the top candidates; falls
 * back to `fallback` (e.g. TavilySearchProvider) only when every DIY attempt for this claim
 * fails — not a single-vendor call. Raw REST call to Gemini, not the shared Provider/
 * completeJson path (audit's GeminiProvider) — that path doesn't expose the google_search tool.
 */
export class HybridSearchProvider implements SearchProvider {
  constructor(
    private readonly geminiApiKey: string,
    private readonly geminiModel: string,
    private readonly fallback: SearchProvider
  ) {}

  async search(query: string): Promise<SearchPassage[]> {
    const candidates = await this.discoverUrls(query);
    const attempted = await Promise.all(
      candidates.slice(0, MAX_CANDIDATES).map((candidate) => this.fetchCandidate(candidate))
    );

    if (attempted.some((p) => p.status === "ok")) {
      return attempted;
    }

    logger.info(
      { module: MODULE, operation: "search", query, attempted: attempted.length },
      "DIY fetch failed for every candidate — falling back"
    );
    const fallbackResults = await this.fallback.search(query);
    return [...attempted, ...fallbackResults];
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
        // Drop malformed/unsafe URLs here rather than fetching them or returning them as
        // ClaimSourceSchema-breaking data — a genuinely malformed string has no valid url to
        // report at all, so it's dropped, not included with a broken field.
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
        response = await fetch(candidate.url, { headers: { "User-Agent": FETCH_USER_AGENT }, redirect: "follow" });
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
