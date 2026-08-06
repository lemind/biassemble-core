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
// D021 "Do not" — real rate-limit handling required, not skipped. Minimal, named form: the
// discovery call is the one D021's own research actually hit 429s on.
const DISCOVERY_ATTEMPTS = 2;
const DISCOVERY_RETRY_DELAY_MS = 500;

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

function statusFromHttpStatus(status: number): SourceStatus {
  return status === 403 ? "blocked" : "unreachable";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Strips <script>/<style> and tags, decodes a handful of common entities — no HTML-parsing
// dependency added for this; D021's research script used Python's BeautifulSoup, this is the
// dependency-free TS equivalent (good enough for MVP text extraction, not a general HTML parser).
function extractTextFromHtml(html: string): string {
  const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
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
    const attempted: SearchPassage[] = [];
    for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
      attempted.push(await this.fetchCandidate(candidate));
    }

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
          if (attempt < DISCOVERY_ATTEMPTS) await sleep(DISCOVERY_RETRY_DELAY_MS);
          continue;
        }
        const data = await response.json();
        const chunks: GroundingChunk[] = data?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
        return chunks.filter((c) => c.web?.uri).map((c) => ({ url: c.web!.uri!, title: c.web?.title ?? domainOf(c.web!.uri!) }));
      } catch (err) {
        lastError = err;
        logger.warn({ module: MODULE, operation: "discoverUrls", query, attempt, err }, "Gemini grounding request failed — retrying");
        if (attempt < DISCOVERY_ATTEMPTS) await sleep(DISCOVERY_RETRY_DELAY_MS);
      }
    }
    logger.warn({ module: MODULE, operation: "discoverUrls", query, err: lastError }, "Gemini grounding failed after retries — zero candidates");
    return [];
  }

  private async fetchCandidate(candidate: { url: string; title: string }): Promise<SearchPassage> {
    let response: Response;
    try {
      response = await fetch(candidate.url, { headers: { "User-Agent": FETCH_USER_AGENT }, redirect: "follow" });
    } catch {
      return { url: candidate.url, title: candidate.title, domain: domainOf(candidate.url), status: "unreachable", text: null };
    }
    if (!response.ok) {
      const finalUrl = response.url || candidate.url;
      return { url: finalUrl, title: candidate.title, domain: domainOf(finalUrl), status: statusFromHttpStatus(response.status), text: null };
    }
    const html = await response.text();
    const text = extractTextFromHtml(html);
    const finalUrl = response.url || candidate.url;
    if (text.length < MIN_TEXT_LENGTH) {
      return { url: finalUrl, title: candidate.title, domain: domainOf(finalUrl), status: "paywalled", text: null };
    }
    return { url: finalUrl, title: candidate.title, domain: domainOf(finalUrl), status: "ok", text };
  }
}
