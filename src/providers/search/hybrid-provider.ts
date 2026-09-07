import { logger } from "../../observability/logger.js";
import { extractKeyTerms, scoreKeyTermMatches, buildSearchQuery } from "../../lib/claim-terms.js";
// D026 §20 — a shared, dependency-free utility (only imports from lib/claim-terms.js itself,
// nothing orchestrator-specific), reused here rather than duplicated: same relevance-selection
// logic pipeline.service.ts's rerankPassages uses for its own LLM-facing excerpt.
import { buildPassageSentences } from "../../orchestrators/grounnel/passage-sentences.js";
import { normalizeUrlKey } from "../../orchestrators/grounnel/pipeline-helpers.js";
import type { SearchProvider, SearchPassage, SourceStatus } from "./search-provider.js";
import type { GrounnelSearchCallStore } from "../../persistence/grounnel-search-call-store.js";

const MODULE = "hybrid-search-provider";
const GEMINI_GENERATE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
// spec 017 T017 — a TARGET of usable pages, not a number of attempts. Fetching exactly N and
// keeping whatever survived left VERIFY with 1-2 pages while 39% of discovered URLs went untried.
const MAX_CANDIDATES = 5;
// Bounds the cost of chasing that target: at most this many attempts per usable page wanted.
const FETCH_ATTEMPT_BUDGET_MULTIPLIER = 2;
// D026 §6 — Tavily's results are already fetched with text (T031), free to retain more than
// MAX_CANDIDATES, which still gates DIY's real per-URL network fetches.
const FALLBACK_RETAINED_CANDIDATES = 8;
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

// Block-level tags whose edges are real content boundaries — a nav/menu block has no terminal
// punctuation, so without a boundary marker here it merges into the next paragraph as one giant
// "sentence" that buries the real content (confirmed in production, g05-statue-of-liberty: the
// donor-attribution sentence landed fused to a page's nav menu text, deprioritizing it downstream).
const BLOCK_BOUNDARY_RE = /<\/(?:p|div|li|h[1-6]|header|nav|footer|section|article|tr|td|th|blockquote)>|<(?:br|hr)\s*\/?>/gi;

// D026 §16 — Parsoid (MediaWiki's REST HTML API, e.g. Wikipedia) embeds full citation-template
// wikitext as a JSON blob in data-mw="..."/data-parsoid="..." attributes on citation <span>/<sup>
// elements (confirmed in production: raw `{{cite journal|...}}` + escaped JSON leaking into a
// claim's evidence text). That JSON value can contain a literal '>', which defeats the generic
// `<[^>]+>` stripper below — it stops at the first '>' it sees, leaving the rest of the attribute
// (and the tag's real close) as visible text. Strip these attributes first, by quote delimiter
// rather than by '>', so the generic stripper only ever sees '>'-free attributes afterward.
const DATA_MW_ATTR_RE = /\sdata-(?:mw|parsoid)\s*=\s*("[^"]*"|'[^']*')/gi;

// D026 §20 — chrome tags, not content: stripped with their content entirely (same treatment as
// script/style below), not just their own tag boundary. Without this, nav/footer/sidebar text
// competes for a slot in buildPassageSentences' relevance-scored pool on equal footing with the
// real article, and dominates any excerpt built from "the first N characters of the page".
// Reviewed finding: deliberately excludes <header> — semantic HTML5 uses <header> for both
// site-level chrome AND an article's own title+byline (<article><header><h1>...`), and stripping
// it unconditionally risks deleting exactly the high-relevance text this fix exists to surface.
// nav/footer/aside don't carry that same risk in practice.
const CHROME_TAGS = "nav|footer|aside";
const CHROME_BLOCK_RE = new RegExp(`<(?:${CHROME_TAGS})[^>]*>[\\s\\S]*?<\\/(?:${CHROME_TAGS})>`, "gi");
const CHROME_UNCLOSED_RE = new RegExp(`<(?:${CHROME_TAGS})[^>]*>[\\s\\S]*$`, "gi");

// Strips <script>/<style>/chrome tags and tags, decodes common entities — no HTML-parsing dependency added; the dependency-free TS equivalent of D021's BeautifulSoup script (MVP-good, not a general parser).
function extractTextFromHtml(html: string): string {
  const withoutScripts = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*$/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*$/gi, " ")
    .replace(CHROME_BLOCK_RE, " ")
    .replace(CHROME_UNCLOSED_RE, " ")
    .replace(DATA_MW_ATTR_RE, "");
  const withBlockBoundaries = withoutScripts.replace(BLOCK_BOUNDARY_RE, "\n");
  const withoutTags = withBlockBoundaries.replace(/<[^>]+>/g, " ");
  return withoutTags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n+ */g, "\n")
    .trim();
}

// Real page title beats discoverUrls()'s domainOf() fallback (2026-08-13 — was always the domain).
function extractTitleFromHtml(html: string): string | null {
  // Strip comments first — a dev comment mentioning "<title>" in prose was mistaken for a real
  // opening tag (real bug, 2026-08-16). Unterminated comments aren't caught — accepted gap.
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(withoutComments);
  if (!match) return null;
  const decoded = match[1]!
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return decoded.length > 0 ? decoded : null;
}

/** D021 — Gemini's google_search for URL discovery only, never content/verdicts (D019 §3 still applies). DIY-fetches top candidates; falls back to `fallback` only when every DIY attempt fails. */
export class HybridSearchProvider implements SearchProvider {
  constructor(
    private readonly geminiApiKey: string,
    private readonly geminiModel: string,
    private readonly fallback: SearchProvider,
    private readonly searchCallStore: GrounnelSearchCallStore
  ) {}

  async search(query: string, context?: { runId: string; claimId: string; searchFlow?: "defaultFlow" | "tavily"; maxCandidates?: number; failedUrlKeys?: Set<string> }): Promise<SearchPassage[]> {
    if (context?.searchFlow === "tavily") {
      return this.runFallback(query, context);
    }

    const candidates = await this.discoverUrls(query);
    // D026 §13 — escalation-only override of MAX_CANDIDATES; a fresh discoverUrls() call above,
    // so a higher tier may surface different/more candidates than a prior tier's discovery did
    // (live search isn't deterministic — same reason every other variance in this pipeline exists).
    const usableTarget = context?.maxCandidates ?? MAX_CANDIDATES;
    const attemptBudget = Math.min(candidates.length, usableTarget * FETCH_ATTEMPT_BUDGET_MULTIPLIER);

    // spec 017 T017 — waves, not one flat slice: parallel batches sized to the shortfall until
    // `usableTarget` pages actually resolve to text, bounded by attemptBudget. Fetching a fixed N
    // and keeping the survivors is what left VERIFY with 1-2 pages (D026 §19's own gap).
    const attempted: SearchPassage[] = [];
    let cursor = 0;
    let usable = 0;
    while (usable < usableTarget && cursor < candidates.length && attempted.length < attemptBudget) {
      const waveSize = Math.min(usableTarget - usable, candidates.length - cursor, attemptBudget - attempted.length);
      const wave = candidates.slice(cursor, cursor + waveSize);
      cursor += waveSize;
      // Granularity, decided (D023 §6): one row per attempted DIY candidate — real per-URL
      // status/timing, matching this method's own "returns every attempted source" contract.
      const results = await Promise.all(
        wave.map(async (candidate) => {
          const t0 = Date.now();
          const result: SearchPassage = { ...(await this.fetchCandidate(candidate, context?.failedUrlKeys)), retrievalMethod: "diy_fetch" };
          if (context) {
            // D026 §20 — reviewed finding: a blind `.slice(0, N)` character prefix captured mostly
            // nav chrome on long pages (Wikipedia's "Jump to content / Main menu" before any real
            // text). Select by relevance instead — the same claim-key-term sentence scoring VERIFY's
            // own passage pooling uses — bounded by sentence count, never by character position.
            const excerpt =
              result.status === "ok" && result.text
                ? buildPassageSentences(query, result.text)
                    .map((s) => s.text)
                    .join(" ")
                : undefined;
            this.searchCallStore.recordSearchCall({
              runId: context.runId,
              claimId: context.claimId,
              query,
              callType: "diy_fetch",
              url: result.url,
              resultCount: 1,
              // Review finding — a memo skip is NOT a fresh 403. Recording it as one would inflate
              // the blocked rate in the very census used to judge whether this change worked.
              status: result.memoSkipped ? "not_attempted" : result.status,
              durationMs: Date.now() - t0,
              excerpt,
            });
          }
          // spec 017 T017 (review finding) — memoize ONLY permanent failures. `unreachable` is a
          // mixed bag: 404, 429, 5xx and timeouts all land there, and a timeout keeps the opaque
          // redirect url, which could never match anyway. Losing a good page costs more than a refetch.
          if (context?.failedUrlKeys && (result.status === "blocked" || result.status === "paywalled")) {
            context.failedUrlKeys.add(normalizeUrlKey(result.url));
          }
          return result;
        })
      );
      attempted.push(...results);
      usable += results.filter((r) => r.status === "ok" && r.text).length;
    }

    // D026 §19 — candidates the loop never needed stay visible, so "discovery found 10, we used 4"
    // is still answerable from telemetry.
    if (context) {
      for (const skipped of candidates.slice(cursor)) {
        this.searchCallStore.recordSearchCall({
          runId: context.runId,
          claimId: context.claimId,
          query,
          callType: "diy_fetch",
          url: skipped.url,
          resultCount: 1,
          status: "not_attempted",
          durationMs: 0,
        });
      }
    }

    // D026 §10 — rank before picking, same as runFallback (D026 §6): discovery order isn't a
    // relevance signal, just whatever order Gemini's grounding search happened to return.
    const ranked = this.rankByRelevance(query, attempted);

    if (ranked.some((p) => p.status === "ok")) {
      return ranked;
    }

    logger.info(
      { module: MODULE, operation: "search", query, attempted: ranked.length },
      "DIY fetch failed for every candidate — falling back"
    );
    const fallbackResults = await this.runFallback(query, context);
    return [...ranked, ...fallbackResults];
  }

  /** Sorts by relevance to `query` ("ok" first, then key-term score, stable). Shared by both search paths (D026 §10). */
  private rankByRelevance(query: string, results: SearchPassage[]): SearchPassage[] {
    const terms = extractKeyTerms(query);
    const scored = results.map((r) => ({ r, score: r.status === "ok" && r.text ? scoreKeyTermMatches(terms, r.text) : 0 }));
    return scored
      .sort((a, b) => {
        const okDelta = Number(b.r.status === "ok") - Number(a.r.status === "ok");
        return okDelta !== 0 ? okDelta : b.score - a.score;
      })
      .map(({ r }) => r);
  }

  /**
   * Shared by the natural "every DIY candidate failed" path and `forceFallback` (test/debug escape
   * hatch). D026 §22/T064, real bug found in self-review: `maxCandidates` was silently dropped by
   * this narrower context type — every escalation tier under a forced-Tavily flow re-issued the
   * identical call and retained the identical fixed top-8, making D026 §13's 3→5→8 escalation a
   * complete no-op here. Tavily already returns up to `MAX_RESULTS` (16) in one call, so widening
   * how many of THOSE get retained (instead of a fixed cap) is the correct analogue of the DIY
   * path's "fetch more" — there's no cheaper way to get more from a single search API response.
   */
  private async runFallback(
    query: string,
    context?: { runId: string; claimId: string; maxCandidates?: number }
  ): Promise<SearchPassage[]> {
    const fallbackT0 = Date.now();
    // D026 §8 (T046, reviewed finding) — a keyword query for the real Tavily search API call only;
    // `query` itself stays the full claim text for telemetry/ranking and for discoverUrls' Gemini
    // "check this claim" framing (a keyword fragment there degrades Gemini's own grounding search).
    const allResults: SearchPassage[] = (await this.fallback.search(buildSearchQuery(query))).map((p) => ({ ...p, retrievalMethod: "tavily_fallback" }));
    if (context) {
      // One row for the whole fallback call, resultCount reflecting everything Tavily actually
      // returned (T031: up to 16) — telemetry, not what gets stored/returned below.
      const fallbackStatus: SourceStatus = allResults.some((p) => p.status === "rate_limited")
        ? "rate_limited"
        : allResults.some((p) => p.status === "ok")
          ? "ok"
          : "unreachable";
      this.searchCallStore.recordSearchCall({
        runId: context.runId,
        claimId: context.claimId,
        query,
        callType: "tavily_fallback",
        url: null,
        resultCount: allResults.length,
        status: fallbackStatus,
        durationMs: Date.now() - fallbackT0,
      });
    }
    // D026 §6 — rank "ok" results by relevance to this claim, not just Tavily's raw order.
    return this.rankByRelevance(query, allResults).slice(0, context?.maxCandidates ?? FALLBACK_RETAINED_CANDIDATES);
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

  private async fetchCandidate(candidate: { url: string; title: string }, failedUrlKeys?: Set<string>): Promise<SearchPassage> {
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

      const resolvedUrl = response.url || candidate.url;
      // spec 017 T017 — the discovery URL is an opaque grounding redirect, so this is the FIRST
      // point the real page is known. Bail before downloading a body already known to be unusable.
      if (failedUrlKeys?.has(normalizeUrlKey(resolvedUrl))) {
        logger.info({ module: MODULE, operation: "fetchCandidate", url: resolvedUrl }, "Skipping a page that already failed earlier in this run");
        return { url: resolvedUrl, title: candidate.title, domain: domainOf(resolvedUrl), status: "blocked", text: null, memoSkipped: true };
      }
      const html = await response.text();
      const text = extractTextFromHtml(html);
      const finalUrl = resolvedUrl;
      // The real fetched page's own <title> tag beats discoverUrls()'s domain-derived guess —
      // real HTML is only in hand here, not at discovery time.
      const title = extractTitleFromHtml(html) ?? candidate.title;
      if (text.length < MIN_TEXT_LENGTH) {
        return { url: finalUrl, title, domain: domainOf(finalUrl), status: "paywalled", text: null };
      }
      return { url: finalUrl, title, domain: domainOf(finalUrl), status: "ok", text };
    }
    logger.warn(
      { module: MODULE, operation: "fetchCandidate", url: candidate.url, err: sanitizeErrorForLogging(lastNetworkError) },
      "Candidate fetch failed after retries"
    );
    return { url: candidate.url, title: candidate.title, domain: domainOf(candidate.url), status: "unreachable", text: null };
  }
}
