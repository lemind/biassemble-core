import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { TavilySearchProvider } from "../../../../src/providers/search/tavily-provider.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(__dirname, "../../../../tests/mocks/tavily-search-response.fixture.json"), "utf-8")
);

describe("TavilySearchProvider (T008)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps T001's real captured response shape into SearchPassage[]", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => fixture })
    );
    const provider = new TavilySearchProvider("fake-key");

    const results = await provider.search("Charles Bukowski education Los Angeles City College");

    expect(results).toHaveLength(fixture.results.length);
    expect(results[0]).toMatchObject({
      url: fixture.results[0].url,
      title: fixture.results[0].title,
      domain: "en.wikipedia.org",
      status: "ok",
    });
    expect(results[0]!.text).toBe(fixture.results[0].raw_content);
  });

  it("sends the query, max_results, and include_raw_content in the request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ results: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new TavilySearchProvider("fake-key");

    await provider.search("some query");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.tavily.com/search");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ query: "some query", max_results: 3, include_raw_content: true });
    expect(init.headers.Authorization).toBe("Bearer fake-key");
  });

  it("returns an empty array (not a throw) when Tavily returns a non-OK status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }));
    const provider = new TavilySearchProvider("bad-key");

    const results = await provider.search("query");
    expect(results).toEqual([]);
  });

  it("returns an empty array (not a throw) when the network request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const provider = new TavilySearchProvider("fake-key");

    const results = await provider.search("query");
    expect(results).toEqual([]);
  });

  it("marks a result with no content/raw_content as unreachable, not a false ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ results: [{ url: "https://example.com", title: "Example" }] }),
      })
    );
    const provider = new TavilySearchProvider("fake-key");

    const results = await provider.search("query");
    expect(results[0]).toMatchObject({ status: "unreachable", text: null });
  });
});
