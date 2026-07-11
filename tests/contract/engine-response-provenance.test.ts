import { afterEach, describe, expect, it, vi } from "vitest";
import { RagEngineClient, normalizeSource } from "../../src/rag/engine-client.js";

// ── Contract: specs/005-bias-provenance-tracking/contracts/engine-response-v3.md ──
// Covers the "Parse acceptance criteria" table: per-bias `source` array normalization
// (incl. legacy scalar tolerance) + additive top-level llm_* metadata capture.

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

describe("normalizeSource (contract v3)", () => {
  it("passes an array of known values through, deduped", () => {
    expect(normalizeSource(["vector", "llm"])).toEqual(["vector", "llm"]);
    expect(normalizeSource(["vector"])).toEqual(["vector"]);
    expect(normalizeSource(["llm"])).toEqual(["llm"]);
    expect(normalizeSource(["vector", "vector"])).toEqual(["vector"]);
  });

  it("normalizes the legacy scalar form", () => {
    expect(normalizeSource("both")).toEqual(["vector", "llm"]);
    expect(normalizeSource("vector")).toEqual(["vector"]);
    expect(normalizeSource("llm")).toEqual(["llm"]);
  });

  it("returns null for absent / null / empty", () => {
    expect(normalizeSource(null)).toBeNull();
    expect(normalizeSource(undefined)).toBeNull();
    expect(normalizeSource([])).toBeNull();
  });

  it("drops unknown values; all-unknown normalizes to null", () => {
    expect(normalizeSource(["bogus"])).toBeNull();
    expect(normalizeSource(["vector", "bogus"])).toEqual(["vector"]);
    expect(normalizeSource("nonsense")).toBeNull();
  });
});

describe("RagEngineClient.retrieve parsing (contract v3)", () => {
  const client = new RagEngineClient("http://engine", "key", 500);

  it("parses a v2 response (no source, no llm_*): source per bias is null", async () => {
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
          { ...baseBias, id: "c", source: ["bogus"] },
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
    expect(res.data.biases[2].source ?? null).toBeNull();
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
        llm_model: "Qwen2.5-1.5B-Instruct",
        llm_latency_ms: 18234.1,
        truncated_story: false,
        llm_scores: { overconfidence_bias: 0.88 },
        vector_scores: { overconfidence_bias: 0.2 },
      }),
    );
    const res = await client.retrieve("story");
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.data.selection_strategy).toBe("llm_union");
    expect(res.data.llm_model).toBe("Qwen2.5-1.5B-Instruct");
    expect(res.data.llm_latency_ms).toBeCloseTo(18234.1);
    expect(res.data.truncated_story).toBe(false);
    expect(res.data.llm_scores).toEqual({ overconfidence_bias: 0.88 });
    expect(res.data.vector_scores).toEqual({ overconfidence_bias: 0.2 });
  });
});
