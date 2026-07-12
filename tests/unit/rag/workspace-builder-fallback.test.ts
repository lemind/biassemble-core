import { describe, it, expect } from "vitest";
import { buildBiasWorkspace } from "../../../src/rag/workspace-builder.js";
import { BiasCatalogService } from "../../../src/catalog/bias-catalog.js";
import type { BiasResult, EngineResponse, RagClientResult } from "../../../src/rag/engine-client.js";

// D017 Decision 1's "do not remove the retrieval_score fallback" — US2. A response with NO
// per-bias source at all (e.g. vector_only/nli_union retrieval configs) must resolve provenance
// entirely via the retrieval_score>0 -> ["vector"] inference rule, unchanged from pre-D017
// behavior.

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

describe("buildBiasWorkspace — full fallback when no bias carries source (US2)", () => {
  it("yields ['vector'] for every retrieval_score>0 bias, excludes retrieval_score=0 biases", () => {
    const ws = buildBiasWorkspace(
      ok([
        bias({ id: "confirmation_bias", retrieval_score: 0.9 }), // no source field
        bias({ id: "anchoring", retrieval_score: 0.7 }), // no source field
        bias({ id: "halo_effect", retrieval_score: 0 }), // excluded
      ]),
      catalog,
    );

    expect(ws.workspaceCase).toBe("retrieved");
    expect(ws.engineSources.get("confirmation-bias")).toEqual(["vector"]);
    expect(ws.engineSources.get("anchoring")).toEqual(["vector"]);
    expect(ws.engineSources.has("halo-effect")).toBe(false);
    expect(ws.engineSources.size).toBe(2);
  });
});
