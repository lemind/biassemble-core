import { describe, it, expect } from "vitest";
import { toStorableEngineResponse, type EngineResponse } from "../../../src/rag/engine-client.js";

// The stored response (runs.rag_result) is only ever read back by workspace-builder.ts,
// which uses id/name/retrieval_score/indicators/source per bias plus top-level metadata.
// definition/examples/false_positives/related_biases are multi-paragraph engine text that
// made up the bulk of a stored row's size for zero downstream benefit.

const fullResponse: EngineResponse = {
  biases: [
    {
      id: "confirmation_bias",
      name: "Confirmation Bias",
      retrieval_score: 0.5,
      indicators: "seeks only confirming evidence",
      source: ["llm"],
      definition: "A very long multi-paragraph definition...".repeat(50),
      examples: "Many paragraphs of examples...".repeat(50),
      false_positives: "Notes on false positives...".repeat(50),
      related_biases: "Anchoring Bias, Halo Effect",
    },
  ],
  retrieved_chunks: 23,
  taxonomy_version: "2026-07-06.1",
  embedding_model: "all-MiniLM-L6-v2",
  request_id: "req-1",
  selection_strategy: "llm_union",
  llm_model: "google_gemma-3-4b-it",
  llm_latency_ms: 33616.7,
  truncated_story: false,
  llm_scores: { confirmation_bias: 0.5 },
  vector_scores: {},
};

describe("toStorableEngineResponse", () => {
  it("drops the bulky unused text fields per bias", () => {
    const storable = toStorableEngineResponse(fullResponse);
    const bias = storable.biases[0] as Record<string, unknown>;

    expect(bias.definition).toBeUndefined();
    expect(bias.examples).toBeUndefined();
    expect(bias.false_positives).toBeUndefined();
    expect(bias.related_biases).toBeUndefined();
  });

  it("keeps the fields workspace-builder.ts actually reads", () => {
    const storable = toStorableEngineResponse(fullResponse);
    const bias = storable.biases[0];

    expect(bias.id).toBe("confirmation_bias");
    expect(bias.name).toBe("Confirmation Bias");
    expect(bias.retrieval_score).toBe(0.5);
    expect(bias.indicators).toBe("seeks only confirming evidence");
    expect(bias.source).toEqual(["llm"]);
  });

  it("passes top-level metadata through unchanged", () => {
    const storable = toStorableEngineResponse(fullResponse);

    expect(storable.selection_strategy).toBe("llm_union");
    expect(storable.llm_model).toBe("google_gemma-3-4b-it");
    expect(storable.taxonomy_version).toBe("2026-07-06.1");
    expect(storable.request_id).toBe("req-1");
  });

  it("shrinks the actual serialized size substantially", () => {
    const before = JSON.stringify(fullResponse).length;
    const after = JSON.stringify(toStorableEngineResponse(fullResponse)).length;
    expect(after).toBeLessThan(before * 0.3);
  });

  it("does not mutate the input", () => {
    const before = JSON.stringify(fullResponse);
    toStorableEngineResponse(fullResponse);
    expect(JSON.stringify(fullResponse)).toBe(before);
  });
});
