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
    expect(fallback.queries).toEqual(["Apple's $3.5 2024"]);
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
});
