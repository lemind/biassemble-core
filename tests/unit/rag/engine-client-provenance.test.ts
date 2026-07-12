import { afterEach, describe, expect, it, vi } from "vitest";
import { RagEngineClient, normalizeSource } from "../../../src/rag/engine-client.js";

// Contract: docs/decisions/017-engine-provenance-tracking.md Decision 1.
// source is an array — "both" is only ever a legacy input spelling that gets expanded,
// never a value that survives into the output.

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const baseBias = {
  id: "overconfidence_bias",
  name: "Overconfidence Bias",
  retrieval_score: 0.83,
  definition: "d",
  examples: "e",
  indicators: "i",
  false_positives: "f",
  related_biases: "r",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeSource (D017 Decision 1)", () => {
  it("passes an array of known values through, deduped", () => {
    expect(normalizeSource(["vector", "llm"])).toEqual(["vector", "llm"]);
    expect(normalizeSource(["vector"])).toEqual(["vector"]);
    expect(normalizeSource(["llm"])).toEqual(["llm"]);
    expect(normalizeSource(["vector", "vector"])).toEqual(["vector"]);
  });

  it("expands the legacy scalar 'both' — never stores it as a value", () => {
    expect(normalizeSource("both")).toEqual(["vector", "llm"]);
    expect(normalizeSource("vector")).toEqual(["vector"]);
    expect(normalizeSource("llm")).toEqual(["llm"]);
  });

  it("returns null for absent / null / empty / unknown", () => {
    expect(normalizeSource(null)).toBeNull();
    expect(normalizeSource(undefined)).toBeNull();
    expect(normalizeSource([])).toBeNull();
    expect(normalizeSource(["bogus"])).toBeNull();
    expect(normalizeSource(["vector", "bogus"])).toEqual(["vector"]);
  });
});

describe("RagEngineClient.retrieve parsing", () => {
  const client = new RagEngineClient("http://engine", "key", 500);

  it("parses a response with no source, no llm_*: source per bias is null", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        biases: [{ ...baseBias }],
        retrieved_chunks: 3,
        taxonomy_version: "t",
        embedding_model: "m",
        request_id: "r1",
      }),
    );
    const res = await client.retrieve("story");
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.data.biases[0].source ?? null).toBeNull();
    expect(res.data.llm_model).toBeUndefined();
  });

  it("normalizes array + legacy scalar source per bias", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        biases: [
          { ...baseBias, id: "a", source: ["vector", "llm"] },
          { ...baseBias, id: "b", source: "both" },
        ],
        retrieved_chunks: 3,
        taxonomy_version: "t",
        embedding_model: "m",
        request_id: "r2",
      }),
    );
    const res = await client.retrieve("story");
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.data.biases[0].source).toEqual(["vector", "llm"]);
    expect(res.data.biases[1].source).toEqual(["vector", "llm"]);
  });

  it("captures additive top-level llm_* / *_scores metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        biases: [{ ...baseBias, source: ["llm"] }],
        retrieved_chunks: 12,
        taxonomy_version: "t",
        embedding_model: "m",
        request_id: "r3",
        selection_strategy: "llm_union",
        llm_model: "google_gemma-3-4b-it",
        llm_latency_ms: 18234.1,
        truncated_story: false,
        llm_scores: { overconfidence_bias: 0.88 },
        vector_scores: { overconfidence_bias: 0.2 },
      }),
    );
    const res = await client.retrieve("story");
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.data.llm_model).toBe("google_gemma-3-4b-it");
    expect(res.data.llm_scores).toEqual({ overconfidence_bias: 0.88 });
  });
});
