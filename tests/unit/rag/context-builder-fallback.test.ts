import { describe, it, expect } from "vitest";
import { buildBiasContext } from "../../../src/rag/context-builder.js";
import { BiasCatalogService } from "../../../src/catalog/bias-catalog.js";
import type { BiasResult, EngineResponse, RagClientResult } from "../../../src/rag/engine-client.js";

// US2 — backward compat: responses WITHOUT a `source` field (vector_only / nli_union, and legacy
// v1/v2 engines) must resolve provenance via the retained retrieval_score inference rule (R3).

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

describe("buildBiasContext — source-less fallback (US2)", () => {
  it("infers ['vector'] for every retrieved bias when no bias carries a source", () => {
    const ctx = buildBiasContext(
      ok([
        bias({ id: "confirmation_bias", retrieval_score: 0.9 }), // no source
        bias({ id: "anchoring", retrieval_score: 0.4 }), // no source
        bias({ id: "halo_effect", retrieval_score: 0 }), // excluded
      ]),
      catalog,
    );

    expect(ctx.ragCase).toBe("retrieved");
    expect(ctx.engineSources.get("confirmation-bias")).toEqual(["vector"]);
    expect(ctx.engineSources.get("anchoring")).toEqual(["vector"]);
    expect(ctx.engineSources.has("halo-effect")).toBe(false);
  });
});
