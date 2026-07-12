import { describe, it, expect } from "vitest";
import { buildBiasWorkspace, buildSourceListsFromWorkspace } from "../../../src/rag/workspace-builder.js";
import { BiasCatalogService } from "../../../src/catalog/bias-catalog.js";
import type { BiasResult, EngineResponse, RagClientResult } from "../../../src/rag/engine-client.js";

// Extracted from assessment.service.ts's inline loop so the backfill path (comparison-recorder.ts)
// can reuse the exact same derivation instead of a second, divergence-prone copy.

const catalog = new BiasCatalogService().getAll();

function bias(partial: Partial<BiasResult> & { id: string; retrieval_score: number }): BiasResult {
  return {
    name: partial.id,
    indicators: "i",
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

describe("buildSourceListsFromWorkspace", () => {
  it("groups candidate names by source, a two-signal bias appears under both keys", () => {
    const workspace = buildBiasWorkspace(
      ok([
        bias({ id: "confirmation_bias", name: "Confirmation Bias", retrieval_score: 0.9, source: ["vector", "llm"] }),
        bias({ id: "anchoring", name: "Anchoring Bias", retrieval_score: 0.7, source: ["llm"] }),
      ]),
      catalog,
    );
    const sourceLists = buildSourceListsFromWorkspace(workspace);

    expect(sourceLists.vector).toEqual(["Confirmation Bias"]);
    expect(sourceLists.llm).toEqual(["Confirmation Bias", "Anchoring Bias"]);
    expect(sourceLists.both).toBeUndefined();
  });

  it("returns an empty object when the workspace is unavailable", () => {
    const workspace = buildBiasWorkspace({ status: "unavailable" }, catalog);
    expect(buildSourceListsFromWorkspace(workspace)).toEqual({});
  });
});
