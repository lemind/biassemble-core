import { describe, it, expect } from "vitest";
import { buildBiasContext } from "../../../src/rag/context-builder.js";
import { BiasCatalogService } from "../../../src/catalog/bias-catalog.js";
import type { BiasResult, EngineResponse, RagClientResult } from "../../../src/rag/engine-client.js";

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

describe("buildBiasContext — engineSources provenance map (D015)", () => {
  it("maps hyphenated ids to their engine signals; falls back to ['vector'] when source is null but score>0", () => {
    const ctx = buildBiasContext(
      ok([
        bias({ id: "confirmation_bias", retrieval_score: 0.9, source: ["vector", "llm"] }),
        bias({ id: "anchoring", retrieval_score: 0.7, source: ["llm"] }),
        bias({ id: "sunk_cost_fallacy", retrieval_score: 0.6, source: null }), // fallback
        bias({ id: "halo_effect", retrieval_score: 0, source: ["vector"] }), // excluded (score 0)
      ]),
      catalog,
    );

    expect(ctx.ragCase).toBe("retrieved");
    expect(ctx.engineSources.get("confirmation-bias")).toEqual(["vector", "llm"]);
    expect(ctx.engineSources.get("anchoring")).toEqual(["llm"]);
    expect(ctx.engineSources.get("sunk-cost-fallacy")).toEqual(["vector"]); // R3 fallback
    expect(ctx.engineSources.has("halo-effect")).toBe(false); // retrieval_score 0 → not retrieved
    // ids are normalized underscore→hyphen, consistent with retrievedIds
    expect([...ctx.retrievedIds]).toEqual(
      expect.arrayContaining(["confirmation-bias", "anchoring", "sunk-cost-fallacy"]),
    );
  });

  it("returns an empty map for roster_fallback (all scores 0)", () => {
    const ctx = buildBiasContext(
      ok([bias({ id: "confirmation_bias", retrieval_score: 0, source: ["vector"] })]),
      catalog,
    );
    expect(ctx.ragCase).toBe("roster_fallback");
    expect(ctx.engineSources.size).toBe(0);
  });

  it("returns an empty map when the engine is unavailable", () => {
    const ctx = buildBiasContext({ status: "unavailable" }, catalog);
    expect(ctx.ragCase).toBe("unavailable");
    expect(ctx.engineSources.size).toBe(0);
  });
});
