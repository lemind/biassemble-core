import { describe, it, expect } from "vitest";
import { buildBiasWorkspace } from "../../../src/rag/workspace-builder.js";
import { BiasCatalogService } from "../../../src/catalog/bias-catalog.js";
import type { BiasResult, EngineResponse, RagClientResult } from "../../../src/rag/engine-client.js";

// D017 Decision 2 — BiasWorkspace.engineSources: hyphenated catalog id -> engine signal array.
// No "both" special-casing anywhere: a two-signal bias is just an array of length 2.

const catalog = new BiasCatalogService().getAll();

function bias(partial: Partial<BiasResult> & { id: string; retrieval_score: number }): BiasResult {
  return {
    name: partial.id,
    definition: "d",
    examples: "e",
    indicators: "i",
    false_positives: "f",
    related_biases: "r",
    ...partial,
  };
}

function ok(biases: BiasResult[]): RagClientResult {
  const data: EngineResponse = {
    biases,
    retrieved_chunks: biases.length,
    taxonomy_version: "t",
    embedding_model: "m",
    request_id: "req",
  };
  return { status: "ok", data };
}

describe("buildBiasWorkspace — engineSources provenance map (D017)", () => {
  it("maps hyphenated ids to their engine signals; falls back to ['vector'] when source is null but score>0", () => {
    const ws = buildBiasWorkspace(
      ok([
        bias({ id: "confirmation_bias", retrieval_score: 0.9, source: ["vector", "llm"] }),
        bias({ id: "anchoring", retrieval_score: 0.7, source: ["llm"] }),
        bias({ id: "sunk_cost_fallacy", retrieval_score: 0.6, source: null }), // fallback
        bias({ id: "halo_effect", retrieval_score: 0, source: ["vector"] }), // excluded (score 0)
      ]),
      catalog,
    );

    expect(ws.workspaceCase).toBe("retrieved");
    expect(ws.engineSources.get("confirmation-bias")).toEqual(["vector", "llm"]);
    expect(ws.engineSources.get("anchoring")).toEqual(["llm"]);
    expect(ws.engineSources.get("sunk-cost-fallacy")).toEqual(["vector"]); // fallback rule
    expect(ws.engineSources.has("halo-effect")).toBe(false);
  });

  it("returns an empty map when unavailable (roster fallback or network error)", () => {
    const ws1 = buildBiasWorkspace(
      ok([bias({ id: "confirmation_bias", retrieval_score: 0, source: ["vector"] })]),
      catalog,
    );
    expect(ws1.workspaceCase).toBe("unavailable");
    expect(ws1.engineSources.size).toBe(0);

    const ws2 = buildBiasWorkspace({ status: "unavailable" }, catalog);
    expect(ws2.workspaceCase).toBe("unavailable");
    expect(ws2.engineSources.size).toBe(0);
  });

  it("resolves each bias independently in a mixed response (some with source, some without)", () => {
    const ws = buildBiasWorkspace(
      ok([
        bias({ id: "confirmation_bias", retrieval_score: 0.9, source: ["llm"] }),
        bias({ id: "anchoring", retrieval_score: 0.5 }), // no source field at all
      ]),
      catalog,
    );
    expect(ws.engineSources.get("confirmation-bias")).toEqual(["llm"]);
    expect(ws.engineSources.get("anchoring")).toEqual(["vector"]);
  });
});
