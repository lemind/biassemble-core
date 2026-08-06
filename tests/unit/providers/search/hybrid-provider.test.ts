import { describe, it, expect, vi, afterEach } from "vitest";
import { HybridSearchProvider } from "../../../../src/providers/search/hybrid-provider.js";
import type { SearchProvider, SearchPassage } from "../../../../src/providers/search/search-provider.js";

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
  constructor(private results: SearchPassage[]) {}
  async search(): Promise<SearchPassage[]> {
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

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback);
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

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback);
    const results = await provider.search("some claim");

    expect(results).toHaveLength(3); // 2 failed DIY attempts + 1 fallback result
    expect(results.find((r) => r.domain === "blocked.example")).toMatchObject({ status: "blocked", text: null });
    expect(results.find((r) => r.domain === "gone.example")).toMatchObject({ status: "unreachable", text: null });
    expect(results).toContainEqual(fallbackResult);
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

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback);
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

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback);
    const results = await provider.search("some claim");

    expect(results).toEqual([fallbackResult]);
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

    const provider = new HybridSearchProvider("gemini-key", "gemini-2.5-flash-lite", fallback);
    const results = await provider.search("some claim");

    expect(calls).toBe(2);
    expect(results[0]).toMatchObject({ url: "https://found-on-retry.example", status: "ok" });
  }, 10000);
});
