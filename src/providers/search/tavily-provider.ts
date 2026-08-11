import { logger } from "../../observability/logger.js";
import type { SearchProvider, SearchPassage } from "./search-provider.js";

const MODULE = "tavily-search-provider";
const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
// 16, not 3 — one Tavily API call either way, so this costs nothing extra; consumers already take
// the first "ok" result in ranked order, so a bigger pool needs no new grouping logic (D024 §2, T031).
const MAX_RESULTS = 16;
// Reviewed finding: this fetch had no timeout at all — the same class of bug hybrid-provider.ts's
// DIY fetches were fixed for after a real hang incident, now reachable here too since 16 full-content
// results (include_raw_content) means more server-side work per call than the original 3 ever did.
const TAVILY_TIMEOUT_MS = 20_000;

interface TavilyResult {
  url: string;
  title: string;
  content?: string;
  raw_content?: string | null;
}

interface TavilySearchResponse {
  results: TavilyResult[];
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// Reviewed finding (D026 §9) — Tavily occasionally returns a relative tracking/redirect link
// ("/goto?url=...") instead of a real absolute URL. Passed through unfiltered, it fails
// ClaimSource.url's format check downstream and 500s the whole /status response — not just this
// one claim. Same "drop it before it becomes a candidate" precedent hybrid-provider.ts's DIY
// discovery already applies via parseSafeUrl, just without the SSRF/private-host check we don't
// need here (we never fetch r.url ourselves; Tavily already supplied the content).
function isAbsoluteHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Shape checked against T001's real captured response (tests/mocks/tavily-search-response.fixture.json), not guessed. */
export class TavilySearchProvider implements SearchProvider {
  constructor(private readonly apiKey: string) {}

  async search(query: string): Promise<SearchPassage[]> {
    let response: Response;
    try {
      response = await fetch(TAVILY_SEARCH_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, max_results: MAX_RESULTS, include_raw_content: true }),
        signal: AbortSignal.timeout(TAVILY_TIMEOUT_MS),
      });
    } catch (err) {
      logger.warn({ module: MODULE, operation: "search", query, err }, "Tavily request failed");
      return [];
    }

    if (!response.ok) {
      logger.warn({ module: MODULE, operation: "search", query, status: response.status }, "Tavily returned a non-OK status");
      // 429 gets its own synthetic entry (real url, no page) so callers can tell "rate limited,
      // try later" apart from "genuinely found nothing" — a materially different client message.
      if (response.status === 429) {
        return [{ url: "https://tavily.com", title: "Tavily", domain: "tavily.com", status: "rate_limited", text: null }];
      }
      return [];
    }

    const data = (await response.json()) as TavilySearchResponse;
    const validResults = data.results.filter((r) => {
      const valid = isAbsoluteHttpUrl(r.url);
      if (!valid) {
        logger.warn({ module: MODULE, operation: "search", query, url: r.url }, "Dropping a Tavily result with a non-absolute URL");
      }
      return valid;
    });
    return validResults.map((r) => {
      const text = r.raw_content ?? r.content ?? null;
      return { url: r.url, title: r.title, domain: domainOf(r.url), status: text ? "ok" : "unreachable", text };
    });
  }
}
