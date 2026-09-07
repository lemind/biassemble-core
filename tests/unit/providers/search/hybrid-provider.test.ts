import { describe, it, expect, vi, afterEach } from "vitest";
import { HybridSearchProvider } from "../../../../src/providers/search/hybrid-provider.js";
import type { SearchProvider, SearchPassage } from "../../../../src/providers/search/search-provider.js";
import { logger } from "../../../../src/observability/logger.js";
import { NoopGrounnelSearchCallStore } from "../../../mocks/noop-grounnel-search-call-store.js";
import { FakeGrounnelSearchCallStore } from "../../../mocks/fake-grounnel-search-call-store.js";

const LONG_TEXT = "Bukowski attended Los Angeles City College. ".repeat(30); // > 800 chars

function geminiGroundingResponse(urls: Array<{ uri: string; title: string }>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ groundingMetadata: { groundingChunks: urls.map((u) => ({ web: u })) } }],
    }),
  };
}

class StubFallback implements SearchProvider {
  queries: string[] = [];
  constructor(private results: SearchPassage[]) {}
  async search(query: string): Promise<SearchPassage[]> {
    this.queries.push(query);
    return this.results;
  }
}

describe("HybridSearchProvider (T008, D021)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the DIY-fetched passage when the first candidate succeeds, without calling the fallback", async () => {
    const fallback = new StubFallback([{ url: "https://fallback.example", title: "F", domain: "fallback.example", status: "ok", text: "x" }]);
    const fallbackSpy = vi.spyOn(fallback, "search");

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(geminiGroundingResponse([{ uri: "https://en.wikipedia.org/wiki/X", title: "X" }]));
      }
      return Promise.resolve({ ok: true, status: 200, url, text: async () => `<html><body>${LONG_TEXT}</body></html>` });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    const results = await provider.search("Bukowski attended Los Angeles City College.");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ url: "https://en.wikipedia.org/wiki/X", status: "ok" });
    expect(results[0]!.text).toContain("Bukowski attended");
    expect(fallbackSpy).not.toHaveBeenCalled();
  });

  it("prefers the fetched page's own <title> tag over discoverUrls()'s domain-derived fallback title", async () => {
    const fallback = new StubFallback([]);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        // No title in grounding metadata — discoverUrls() falls back to domainOf(uri).
        return Promise.resolve(geminiGroundingResponse([{ uri: "https://en.wikipedia.org/wiki/Charles_Bukowski", title: undefined as unknown as string }]));
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        url,
        text: async () => `<html><head><title>Charles Bukowski - Wikipedia</title></head><body>${LONG_TEXT}</body></html>`,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    const results = await provider.search("Bukowski attended Los Angeles City College.");

    expect(results[0]!.title).toBe("Charles Bukowski - Wikipedia");
  });

  it("falls back to the discovery-time title when the fetched page has no <title> tag at all", async () => {
    const fallback = new StubFallback([]);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(geminiGroundingResponse([{ uri: "https://example.com/page", title: "Discovery Title" }]));
      }
      return Promise.resolve({ ok: true, status: 200, url, text: async () => `<html><body>${LONG_TEXT}</body></html>` });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    const results = await provider.search("Bukowski attended Los Angeles City College.");

    expect(results[0]!.title).toBe("Discovery Title");
  });

  it("real bug, 2026-08-16: an HTML comment mentioning '<title>' in prose doesn't get mistaken for the real opening tag", async () => {
    const fallback = new StubFallback([]);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(geminiGroundingResponse([{ uri: "https://en.wikipedia.org/wiki/Charles_Bukowski", title: undefined as unknown as string }]));
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        url,
        text: async () =>
          `<html><head><!-- og:title falls back to the page <title>, per convention --><title>Charles Bukowski - Wikipedia</title></head><body>${LONG_TEXT}</body></html>`,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    const results = await provider.search("Bukowski attended Los Angeles City College.");

    expect(results[0]!.title).toBe("Charles Bukowski - Wikipedia");
  });

  it("D026 §13: context.maxCandidates widens how many discovered candidates get fetched, past the default of 3", async () => {
    const fallback = new StubFallback([]);
    const fetchedUrls: string[] = [];
    // 7 candidates discovered in one call — matches the real live-verified count for a typical
    // claim (2026-08-10 probe against the actual Gemini grounding API, D026 §13).
    const discovered = Array.from({ length: 7 }, (_, i) => ({ uri: `https://example${i}.com/page`, title: `Page ${i}` }));
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(geminiGroundingResponse(discovered));
      }
      fetchedUrls.push(url);
      return Promise.resolve({ ok: true, status: 200, url, text: async () => `<html><body>${LONG_TEXT}</body></html>` });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    await provider.search("Bukowski attended Los Angeles City College.", { runId: "r1", claimId: "c1", maxCandidates: 5 });

    expect(fetchedUrls).toHaveLength(5); // not the default 3
    expect(fetchedUrls).toEqual(discovered.slice(0, 5).map((d) => d.uri));
  });

  it("spec 017 T017: omitting context.maxCandidates targets the default 5 USABLE pages", async () => {
    const fallback = new StubFallback([]);
    const fetchedUrls: string[] = [];
    const discovered = Array.from({ length: 7 }, (_, i) => ({ uri: `https://example${i}.com/page`, title: `Page ${i}` }));
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(geminiGroundingResponse(discovered));
      }
      fetchedUrls.push(url);
      return Promise.resolve({ ok: true, status: 200, url, text: async () => `<html><body>${LONG_TEXT}</body></html>` });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    await provider.search("Bukowski attended Los Angeles City College.");

    // Every candidate here succeeds, so 5 attempts reach the target of 5 usable and it stops.
    expect(fetchedUrls).toHaveLength(5);
  });

  it("spec 017 T017: keeps fetching past failures until the target of usable pages is met", async () => {
    const fallback = new StubFallback([]);
    const fetchedUrls: string[] = [];
    const discovered = Array.from({ length: 9 }, (_, i) => ({ uri: `https://example${i}.com/page`, title: `Page ${i}` }));
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) return Promise.resolve(geminiGroundingResponse(discovered));
      fetchedUrls.push(url);
      // The real shape: the first wave is mostly blocked. Pre-T017 the run kept the survivors and
      // handed VERIFY one page; now it goes back for more.
      const blocked = ["example0", "example1", "example3"].some((b) => url.includes(b));
      if (blocked) return Promise.resolve({ ok: false, status: 403, url, text: async () => "" });
      return Promise.resolve({ ok: true, status: 200, url, text: async () => `<html><body>${LONG_TEXT}</body></html>` });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    const results = await provider.search("some claim", { runId: "r1", claimId: "c1" });

    expect(results.filter((r) => r.status === "ok")).toHaveLength(5);
    expect(fetchedUrls.length).toBeGreaterThan(5);
  });

  // Also the 429 case: statusFromHttpStatus maps everything but 403 to `unreachable`, so a
  // rate-limited host is indistinguishable from a dead one and the budget is the only backstop.
  it("spec 017 T017: stops at the attempt budget rather than fetching every candidate when nothing works", async () => {
    const fallback = new StubFallback([]);
    const fetchedUrls: string[] = [];
    const discovered = Array.from({ length: 30 }, (_, i) => ({ uri: `https://example${i}.com/page`, title: `Page ${i}` }));
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) return Promise.resolve(geminiGroundingResponse(discovered));
      fetchedUrls.push(url);
      return Promise.resolve({ ok: false, status: 403, url, text: async () => "" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    await provider.search("some claim", { runId: "r1", claimId: "c1" });

    // 5 usable wanted x FETCH_ATTEMPT_BUDGET_MULTIPLIER (2) — never all 30.
    expect(fetchedUrls).toHaveLength(10);
  });

  it("spec 017 T017: abandons a page that already failed earlier in the run, before downloading its body", async () => {
    const fallback = new StubFallback([]);
    let bodyReads = 0;
    const discovered = [{ uri: "https://redirect-a.example", title: "A" }, { uri: "https://redirect-b.example", title: "B" }];
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) return Promise.resolve(geminiGroundingResponse(discovered));
      // Both opaque discovery URLs resolve to the SAME real page — the grounding-redirect shape.
      return Promise.resolve({
        ok: true,
        status: 200,
        url: "https://blocked-site.example/article",
        text: async () => { bodyReads++; return `<html><body>${LONG_TEXT}</body></html>`; },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const failedUrlKeys = new Set<string>(["blocked-site.example/article"]);
    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    const results = await provider.search("some claim", { runId: "r1", claimId: "c1", failedUrlKeys });

    expect(bodyReads).toBe(0);
    expect(results.every((r) => r.status !== "ok")).toBe(true);
  });

  it("reviewed finding (D026 §10, T048): ranks DIY candidates by relevance to the claim, not just Gemini's discovery order — the real Napoleon variance", async () => {
    const claimText = "Napoleon Bonaparte was five feet two inches tall.";
    const irrelevantText = "The Great Wall of China spans thousands of miles. ".repeat(30);
    const relevantText = "Napoleon Bonaparte was estimated to have been five feet two inches tall in pre-metric French measures. ".repeat(10);

    const fallback = new StubFallback([]);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        // Discovery order deliberately puts the irrelevant page first — ranking must not just trust it.
        return Promise.resolve(
          geminiGroundingResponse([
            { uri: "https://irrelevant.example", title: "Irrelevant" },
            { uri: "https://relevant.example", title: "Relevant" },
          ])
        );
      }
      const text = url.includes("irrelevant.example") ? irrelevantText : relevantText;
      return Promise.resolve({ ok: true, status: 200, url, text: async () => `<html><body>${text}</body></html>` });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    const results = await provider.search(claimText);

    expect(results[0]).toMatchObject({ url: "https://relevant.example" });
  });

  it("preserves original discovery order when two DIY candidates tie in relevance score (stable sort)", async () => {
    const claimText = "Napoleon Bonaparte was five feet two inches tall.";
    const textA = "Napoleon Bonaparte is discussed here in some detail about his life. ".repeat(15);
    const textB = "Napoleon Bonaparte is discussed here in some detail about his campaigns. ".repeat(15);

    const fallback = new StubFallback([]);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(
          geminiGroundingResponse([
            { uri: "https://a.example", title: "A" },
            { uri: "https://b.example", title: "B" },
          ])
        );
      }
      const text = url.includes("a.example") ? textA : textB;
      return Promise.resolve({ ok: true, status: 200, url, text: async () => `<html><body>${text}</body></html>` });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    const results = await provider.search(claimText);

    expect(results.map((r) => r.url)).toEqual(["https://a.example", "https://b.example"]);
  });

  it("reviewed finding (g05-statue-of-liberty, T050 / D026 §20): a <nav> block is stripped entirely, not just boundary-separated, so it can't fuse onto or corrupt the next real sentence", async () => {
    const navJunk = "Sign In Blog Categories ALL CULTURE TRAVEL HISTORY";
    const donorSentence = "The Statue of Liberty, a gift from the people of France to the United States, arrived in 1885.";
    const filler = "It has stood on Liberty Island ever since welcoming visitors. ".repeat(15);
    const html = `<html><body><nav>${navJunk}</nav><p>${donorSentence} ${filler}</p></body></html>`;

    const fallback = new StubFallback([]);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(geminiGroundingResponse([{ uri: "https://liberty.example", title: "Liberty" }]));
      }
      return Promise.resolve({ ok: true, status: 200, url, text: async () => html });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    const results = await provider.search("The Statue of Liberty was a gift from Canada to the United States.");

    // D026 §20 — stronger than T050's original fix: <nav> content is removed entirely now, not
    // just kept-but-boundary-separated, so it never competes for a slot in any relevance scoring
    // downstream. The old assertion (nav junk present, just isolated) no longer applies.
    expect(results[0]!.text).not.toContain(navJunk);
    expect(results[0]!.text).toContain(donorSentence);
    const sentences = results[0]!.text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'“])|\n+/);
    const donorOnly = sentences.find((s: string) => s.includes(donorSentence));
    expect(donorOnly).toBe(donorSentence);
  });

  it("falls back to Tavily/Exa only when every DIY candidate fails, combining attempted + fallback results", async () => {
    const fallbackResult: SearchPassage = { url: "https://tavily-found.example", title: "T", domain: "tavily-found.example", status: "ok", text: "fallback text" };
    const fallback = new StubFallback([fallbackResult]);

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(
          geminiGroundingResponse([
            { uri: "https://blocked.example", title: "Blocked" },
            { uri: "https://gone.example", title: "Gone" },
          ])
        );
      }
      if (url.includes("blocked.example")) return Promise.resolve({ ok: false, status: 403, url });
      return Promise.resolve({ ok: false, status: 404, url });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    const results = await provider.search("some claim");

    expect(results).toHaveLength(3); // 2 failed DIY attempts + 1 fallback result
    expect(results.find((r) => r.domain === "blocked.example")).toMatchObject({ status: "blocked", text: null });
    expect(results.find((r) => r.domain === "gone.example")).toMatchObject({ status: "unreachable", text: null });
    expect(results).toContainEqual({ ...fallbackResult, retrievalMethod: "tavily_fallback" });
  });

  it("reviewed finding (T031/T039): caps Tavily's fallback results instead of storing/returning all 16 unfiltered, keeping any 'ok' result even if it's ranked late", async () => {
    // Simulates Tavily's real max_results:16 response — 15 unusable, one real "ok" result buried
    // at position 11. Before the T031 fix, all 16 were stored/returned (up to 19 total with 3 DIY
    // attempts); capped at FALLBACK_RETAINED_CANDIDATES (8, raised from 3 by T039 since the pool
    // is already-fetched and free to retain more of) — but must not lose the real one.
    const okResult: SearchPassage = { url: "https://real-source.example", title: "Real", domain: "real-source.example", status: "ok", text: "the real content" };
    const unusableResults: SearchPassage[] = Array.from({ length: 15 }, (_, i) => ({
      url: `https://unusable-${i}.example`,
      title: `Unusable ${i}`,
      domain: `unusable-${i}.example`,
      status: "unreachable",
      text: null,
    }));
    const sixteenResults = [...unusableResults.slice(0, 10), okResult, ...unusableResults.slice(10)];
    const fallback = new StubFallback(sixteenResults);

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(geminiGroundingResponse([{ uri: "https://blocked.example", title: "Blocked" }]));
      }
      return Promise.resolve({ ok: false, status: 403, url });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    const results = await provider.search("some claim");

    const fallbackResults = results.filter((r) => r.retrievalMethod === "tavily_fallback");
    expect(fallbackResults.length).toBeLessThanOrEqual(8); // capped, not all 16
    expect(fallbackResults).toContainEqual({ ...okResult, retrievalMethod: "tavily_fallback" }); // but the real one survives the cut
  });

  it("T039 (D026 §6): ranks 'ok' fallback results by relevance to the claim, not just Tavily's raw order", async () => {
    const claimText = "Apple's market capitalization surpassed $3.5 trillion in 2024.";
    const topicalOnly: SearchPassage = {
      url: "https://topical.example",
      title: "Topical",
      domain: "topical.example",
      status: "ok",
      text: "Apple released several new products in 2024, including updated iPads.",
    };
    const numericMatch: SearchPassage = {
      url: "https://numeric.example",
      title: "Numeric",
      domain: "numeric.example",
      status: "ok",
      text: "Apple's market cap crossed $3.5 trillion in 2024, according to filings.",
    };
    // Raw Tavily order deliberately puts the merely-topical result first — ranking must not just
    // trust that order, the way the pre-T039 status-only sort did.
    const fallback = new StubFallback([topicalOnly, numericMatch]);

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(geminiGroundingResponse([{ uri: "https://blocked.example", title: "Blocked" }]));
      }
      return Promise.resolve({ ok: false, status: 403, url });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    const results = await provider.search(claimText);

    const fallbackResults = results.filter((r) => r.retrievalMethod === "tavily_fallback");
    expect(fallbackResults[0]).toMatchObject({ url: "https://numeric.example" });
  });

  it("reviewed finding (D026 §8): sends a keyword query to the Tavily fallback but the full claim sentence to Gemini's own discovery call", async () => {
    const claimText = "Apple's market capitalization surpassed $3.5 trillion in 2024.";
    const fallback = new StubFallback([]);

    let geminiRequestText = "";
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        geminiRequestText = JSON.parse(init!.body as string).contents[0].parts[0].text;
        return Promise.resolve(geminiGroundingResponse([{ uri: "https://blocked.example", title: "Blocked" }]));
      }
      return Promise.resolve({ ok: false, status: 403, url });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    await provider.search(claimText);

    // discoverUrls embeds the query in "check this claim: ..." — a keyword fragment there would
    // degrade Gemini's own grounding-search reasoning, so it must still get the full sentence.
    expect(geminiRequestText).toContain(claimText);
    // The real Tavily API call, by contrast, should get the keyword-rewritten query, not the raw sentence.
    expect(fallback.queries).toEqual(["Apple's market capitalization surpassed $3.5 trillion 2024"]);
  });

  it("marks a suspiciously short 200 response as paywalled, not ok", async () => {
    const fallback = new StubFallback([]);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(geminiGroundingResponse([{ uri: "https://paywall.example", title: "Paywall" }]));
      }
      return Promise.resolve({ ok: true, status: 200, url, text: async () => "<html><body>Subscribe to continue reading.</body></html>" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    const results = await provider.search("some claim");

    expect(results[0]).toMatchObject({ status: "paywalled", text: null });
  });

  it("falls back immediately when Gemini discovery itself returns zero candidates", async () => {
    const fallbackResult: SearchPassage = { url: "https://tavily.example", title: "T", domain: "tavily.example", status: "ok", text: "x" };
    const fallback = new StubFallback([fallbackResult]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(geminiGroundingResponse([]))
    );

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    const results = await provider.search("some claim");

    expect(results).toEqual([{ ...fallbackResult, retrievalMethod: "tavily_fallback" }]);
  });

  it("retries the Gemini discovery call once on failure before giving up", async () => {
    let calls = 0;
    const fallback = new StubFallback([]);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        calls++;
        if (calls === 1) return Promise.resolve({ ok: false, status: 429 });
        return Promise.resolve(geminiGroundingResponse([{ uri: "https://found-on-retry.example", title: "Found" }]));
      }
      return Promise.resolve({ ok: true, status: 200, url, text: async () => `<html><body>${LONG_TEXT}</body></html>` });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    const results = await provider.search("some claim");

    expect(calls).toBe(2);
    expect(results[0]).toMatchObject({ url: "https://found-on-retry.example", status: "ok" });
  }, 10000);

  it("never logs the Gemini API key when a discovery request fails to parse", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    const fallback = new StubFallback([]);
    // A key containing characters that break URL parsing forces fetch()'s URL-parse-failure path.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to parse URL from https://x?key=AIzaSECRET123 not-a-url")));

    const provider = new HybridSearchProvider("AIzaSECRET123", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    await provider.search("some claim");

    // Error.message is non-enumerable — JSON.stringify silently drops it, so check it directly.
    const loggedMessages = warnSpy.mock.calls.map((call) => (call[0] as { err?: Error })?.err?.message).filter(Boolean);
    expect(loggedMessages.some((m) => m!.includes("AIzaSECRET123"))).toBe(false);
    expect(loggedMessages.some((m) => m!.includes("[REDACTED]"))).toBe(true);
  });

  it("drops a candidate URL pointing at a private/loopback address instead of fetching it", async () => {
    const fallback = new StubFallback([{ url: "https://tavily.example", title: "T", domain: "tavily.example", status: "ok", text: "x" }]);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(geminiGroundingResponse([{ uri: "http://169.254.169.254/latest/meta-data/", title: "Metadata" }]));
      }
      throw new Error("must not fetch a blocked-hostname URL");
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    const results = await provider.search("some claim");

    expect(fetchMock).toHaveBeenCalledTimes(1); // only the Gemini discovery call, never the blocked URL
    expect(results).toEqual([{ url: "https://tavily.example", title: "T", domain: "tavily.example", status: "ok", text: "x", retrievalMethod: "tavily_fallback" }]);
  });

  it("logs a warning when an individual candidate fetch fails", async () => {
    const warnSpy = vi.spyOn(logger, "warn");
    const fallback = new StubFallback([]);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(geminiGroundingResponse([{ uri: "https://blocked.example", title: "Blocked" }]));
      }
      return Promise.resolve({ ok: false, status: 403, url });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    await provider.search("some claim");

    expect(warnSpy.mock.calls.some((call) => JSON.stringify(call).includes("blocked.example"))).toBe(true);
  });

  it("retries a 500 on a candidate fetch but does not retry a 403", async () => {
    const fallback = new StubFallback([]);
    let blockedCalls = 0;
    let flakyCalls = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(
          geminiGroundingResponse([
            { uri: "https://blocked.example", title: "Blocked" },
            { uri: "https://flaky.example", title: "Flaky" },
          ])
        );
      }
      if (url.includes("blocked.example")) {
        blockedCalls++;
        return Promise.resolve({ ok: false, status: 403, url });
      }
      flakyCalls++;
      if (flakyCalls === 1) return Promise.resolve({ ok: false, status: 500, url });
      return Promise.resolve({ ok: true, status: 200, url, text: async () => `<html><body>${LONG_TEXT}</body></html>` });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    const results = await provider.search("some claim");

    expect(blockedCalls).toBe(1); // 403 never retried
    expect(flakyCalls).toBe(2); // 500 retried once, then succeeded
    expect(results.find((r) => r.domain === "flaky.example")).toMatchObject({ status: "ok" });
  });

  it("does not leak raw JS from an unclosed <script> tag into the extracted text", async () => {
    const fallback = new StubFallback([]);
    const malformedHtml = `<html><body>${LONG_TEXT}<script>var leaked = "should not appear in evidence";`;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(geminiGroundingResponse([{ uri: "https://malformed.example", title: "M" }]));
      }
      return Promise.resolve({ ok: true, status: 200, url, text: async () => malformedHtml });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    const results = await provider.search("some claim");

    expect(results[0]!.text).not.toContain("leaked");
    expect(results[0]!.text).not.toContain("should not appear in evidence");
  });

  it("D026 §16: strips a data-mw citation-template JSON blob (Parsoid/Wikipedia) whose embedded '>' would otherwise defeat the generic tag stripper", async () => {
    const fallback = new StubFallback([]);
    // Real production shape: a citation <sup> whose data-mw value contains an unescaped '>' inside
    // its JSON, so a naive `<[^>]+>` stripper closes the "tag" early at that inner '>' and leaks the
    // rest of the attribute — including raw `{{cite journal|...}}` wikitext — as visible text.
    const malformedHtml =
      `<html><body>${LONG_TEXT}` +
      `<sup id="cite_note-1" data-mw='{"parts":[{"template":{"target":{"wt":"cite journal"},"params":{"title":{"wt":"A > B study"}}}}],"i":0}'>` +
      `[1]</sup>${LONG_TEXT}</body></html>`;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(geminiGroundingResponse([{ uri: "https://en.wikipedia.org/wiki/Example", title: "E" }]));
      }
      return Promise.resolve({ ok: true, status: 200, url, text: async () => malformedHtml });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    const results = await provider.search("some claim");

    expect(results[0]!.text).not.toContain("cite journal");
    expect(results[0]!.text).not.toContain("data-mw");
    expect(results[0]!.text).not.toContain('"parts"');
  });

  it("D026 §20: strips <footer>/<aside> content entirely, same treatment as <nav> — but deliberately NOT <header>, which can legitimately hold an article's own title/byline", async () => {
    const headerContent = "The blue whale story — by a Marine Biologist"; // simulates a real <article><header> title/byline, not site chrome
    const footerJunk = "© 2026 Acme News. Privacy Policy. Terms of Service.";
    const asideJunk = "Related: 10 Ocean Facts You Never Knew";
    const donorSentence = "The blue whale is the largest animal known to have ever existed.";
    const html = `<html><body><header>${headerContent}</header><aside>${asideJunk}</aside><p>${donorSentence} ${LONG_TEXT}</p><footer>${footerJunk}</footer></body></html>`;
    const fallback = new StubFallback([]);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(geminiGroundingResponse([{ uri: "https://example.com/blue-whale", title: "Blue whale" }]));
      }
      return Promise.resolve({ ok: true, status: 200, url, text: async () => html });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());
    const results = await provider.search("some claim");

    expect(results[0]!.text).not.toContain(footerJunk);
    expect(results[0]!.text).not.toContain(asideJunk);
    expect(results[0]!.text).toContain(headerContent);
    expect(results[0]!.text).toContain(donorSentence);
  });

  it("D026 §20: the stored excerpt is relevance-selected, not a character prefix — finds the claim-relevant sentence even buried deep in a long page", async () => {
    const donorSentence = "Nauru has a resident population of approximately 12,000 people.";
    // Thousands of characters of unrelated filler BEFORE the relevant sentence — a blind
    // `.slice(0, N)` prefix would never reach it; relevance-based selection doesn't care where
    // in the page it sits.
    const unrelatedFiller = "This paragraph discusses unrelated topics like weather patterns and shipping routes. ".repeat(80);
    const html = `<html><body><p>${unrelatedFiller}${donorSentence} ${unrelatedFiller}</p></body></html>`;
    const fallback = new StubFallback([]);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(geminiGroundingResponse([{ uri: "https://example.com/nauru", title: "Nauru" }]));
      }
      return Promise.resolve({ ok: true, status: 200, url, text: async () => html });
    });
    vi.stubGlobal("fetch", fetchMock);

    const searchCallStore = new FakeGrounnelSearchCallStore();
    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, searchCallStore);
    await provider.search("Nauru has a resident population of approximately 12,000 people.", { runId: "r1", claimId: "c1" });

    const call = searchCallStore.calls.find((c) => c.status === "ok")!;
    expect(call.excerpt).toContain(donorSentence);
    // Well past the old 3000-char cap — proves this isn't a lucky prefix hit.
    expect(unrelatedFiller.length).toBeGreaterThan(3000);
  });

  it("T026/D023 §6: writes zero grounnel_search_calls rows when no context is given (backward compatible)", async () => {
    const fallback = new StubFallback([]);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(geminiGroundingResponse([{ uri: "https://en.wikipedia.org/wiki/X", title: "X" }]));
      }
      return Promise.resolve({ ok: true, status: 200, url, text: async () => `<html><body>${LONG_TEXT}</body></html>` });
    });
    vi.stubGlobal("fetch", fetchMock);

    const searchCallStore = new FakeGrounnelSearchCallStore();
    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, searchCallStore);
    await provider.search("Bukowski attended Los Angeles City College.");

    expect(searchCallStore.calls).toHaveLength(0);
  });

  it("T026/D023 §6: writes one diy_fetch row per attempted candidate when context is given", async () => {
    const fallbackResult: SearchPassage = { url: "https://tavily-found.example", title: "T", domain: "tavily-found.example", status: "ok", text: "fallback text" };
    const fallback = new StubFallback([fallbackResult]);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(
          geminiGroundingResponse([
            { uri: "https://blocked.example", title: "Blocked" },
            { uri: "https://gone.example", title: "Gone" },
          ])
        );
      }
      if (url.includes("blocked.example")) return Promise.resolve({ ok: false, status: 403, url });
      return Promise.resolve({ ok: false, status: 404, url });
    });
    vi.stubGlobal("fetch", fetchMock);

    const searchCallStore = new FakeGrounnelSearchCallStore();
    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, searchCallStore);
    await provider.search("some claim", { runId: "r1", claimId: "c1" });

    const diyCalls = searchCallStore.calls.filter((c) => c.callType === "diy_fetch");
    const fallbackCalls = searchCallStore.calls.filter((c) => c.callType === "tavily_fallback");
    expect(diyCalls).toHaveLength(2);
    expect(diyCalls.every((c) => c.runId === "r1" && c.claimId === "c1")).toBe(true);
    expect(diyCalls.find((c) => c.url === "https://blocked.example")).toMatchObject({ status: "blocked" });
    expect(diyCalls.find((c) => c.url === "https://gone.example")).toMatchObject({ status: "unreachable" });
    expect(fallbackCalls).toHaveLength(1);
    expect(fallbackCalls[0]).toMatchObject({ runId: "r1", claimId: "c1", url: null, status: "ok", resultCount: 1 });
  });

  it("D026 §19: logs a 'not_attempted' row for every discovered candidate beyond fetchCap, not just the ones actually fetched", async () => {
    const fallback = new StubFallback([]);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(
          geminiGroundingResponse([
            { uri: "https://one.example", title: "One" },
            { uri: "https://two.example", title: "Two" },
            { uri: "https://three.example", title: "Three" },
            { uri: "https://four.example", title: "Four" },
            { uri: "https://five.example", title: "Five" },
            { uri: "https://six.example", title: "Six" },
            { uri: "https://seven.example", title: "Seven" },
          ])
        );
      }
      return Promise.resolve({ ok: true, status: 200, url, text: async () => `<html><body>${LONG_TEXT}</body></html>` });
    });
    vi.stubGlobal("fetch", fetchMock);

    const searchCallStore = new FakeGrounnelSearchCallStore();
    // Target is 5 usable and all 5 succeed in one wave, so the loop never reaches candidates 6-7:
    // those stay visible as not_attempted (the T053 trigger gap, still queryable after T017).
    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, searchCallStore);
    await provider.search("some claim", { runId: "r1", claimId: "c1" });

    const notAttempted = searchCallStore.calls.filter((c) => c.status === "not_attempted");
    expect(notAttempted).toHaveLength(2);
    expect(notAttempted.map((c) => c.url).sort()).toEqual(["https://seven.example", "https://six.example"]);
    expect(notAttempted.every((c) => c.durationMs === 0 && c.excerpt === undefined)).toBe(true);
    // The 5 the loop needed were genuinely attempted, not also logged as not_attempted.
    expect(searchCallStore.calls.filter((c) => c.status === "ok")).toHaveLength(5);
  });

  it("D026 §19: stores the cleaned excerpt actually extracted for a successful DIY fetch, not for a failed one", async () => {
    const fallback = new StubFallback([]);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(
          geminiGroundingResponse([
            { uri: "https://ok.example", title: "OK" },
            { uri: "https://blocked.example", title: "Blocked" },
          ])
        );
      }
      if (url.includes("blocked.example")) return Promise.resolve({ ok: false, status: 403, url });
      return Promise.resolve({ ok: true, status: 200, url, text: async () => `<html><body>${LONG_TEXT}</body></html>` });
    });
    vi.stubGlobal("fetch", fetchMock);

    const searchCallStore = new FakeGrounnelSearchCallStore();
    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, searchCallStore);
    await provider.search("some claim", { runId: "r1", claimId: "c1" });

    const okCall = searchCallStore.calls.find((c) => c.url === "https://ok.example")!;
    const blockedCall = searchCallStore.calls.find((c) => c.url === "https://blocked.example")!;
    expect(okCall.excerpt).toContain("Bukowski attended Los Angeles City College");
    expect(blockedCall.excerpt).toBeUndefined();
  });

  it("T026/D023 §6: no tavily_fallback row is written when the first DIY candidate already succeeds", async () => {
    const fallback = new StubFallback([]);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(geminiGroundingResponse([{ uri: "https://en.wikipedia.org/wiki/X", title: "X" }]));
      }
      return Promise.resolve({ ok: true, status: 200, url, text: async () => `<html><body>${LONG_TEXT}</body></html>` });
    });
    vi.stubGlobal("fetch", fetchMock);

    const searchCallStore = new FakeGrounnelSearchCallStore();
    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, searchCallStore);
    await provider.search("Bukowski attended Los Angeles City College.", { runId: "r1", claimId: "c1" });

    expect(searchCallStore.calls).toHaveLength(1);
    expect(searchCallStore.calls[0]).toMatchObject({ callType: "diy_fetch", status: "ok" });
  });

  it("searchFlow: tavily skips DIY fetch entirely, even when the first candidate would have succeeded", async () => {
    const fallback = new StubFallback([{ url: "https://fallback.example", title: "F", domain: "fallback.example", status: "ok", text: "x" }]);
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return Promise.resolve(geminiGroundingResponse([{ uri: "https://en.wikipedia.org/wiki/X", title: "X" }]));
      }
      return Promise.resolve({ ok: true, status: 200, url, text: async () => `<html><body>${LONG_TEXT}</body></html>` });
    });
    vi.stubGlobal("fetch", fetchMock);

    const searchCallStore = new FakeGrounnelSearchCallStore();
    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, searchCallStore);
    const results = await provider.search("Bukowski attended Los Angeles City College.", {
      runId: "r1",
      claimId: "c1",
      searchFlow: "tavily",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(results).toEqual([{ url: "https://fallback.example", title: "F", domain: "fallback.example", status: "ok", text: "x", retrievalMethod: "tavily_fallback" }]);
    expect(searchCallStore.calls).toHaveLength(1);
    expect(searchCallStore.calls[0]).toMatchObject({ callType: "tavily_fallback", status: "ok" });
  });

  it("D026 §22/T064, real bug found in self-review: context.maxCandidates widens the Tavily fallback's retained results past the default 8, so escalation tiers actually get more evidence under the forced-Tavily flow", async () => {
    // Before the fix, runFallback's own narrower context type silently dropped maxCandidates — every
    // escalation tier under searchFlow: "tavily" retained the identical fixed top-8, making D026 §13's
    // 3->5->8 escalation a complete no-op for this flow. 10 "ok" results, all real content so all rank
    // above nothing (no non-ok filler needed) — the default cap (8) must drop 2 of them; maxCandidates: 10 must not.
    const tenResults: SearchPassage[] = Array.from({ length: 10 }, (_, i) => ({
      url: `https://source-${i}.example`,
      title: `Source ${i}`,
      domain: `source-${i}.example`,
      status: "ok",
      text: "some real content",
    }));
    const fallback = new StubFallback(tenResults);
    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback, new NoopGrounnelSearchCallStore());

    const defaultRetention = await provider.search("some claim", { runId: "r1", claimId: "c1", searchFlow: "tavily" });
    const widenedRetention = await provider.search("some claim", { runId: "r1", claimId: "c1", searchFlow: "tavily", maxCandidates: 10 });

    expect(defaultRetention).toHaveLength(8);
    expect(widenedRetention).toHaveLength(10);
  });
});
