import { describe, it, expect } from "vitest";
import { buildBiasWorkspace, renderWorkspaceToPrompt } from "../../../src/rag/workspace-builder.js";
import type { BiasEntry } from "../../../src/catalog/bias-catalog.js";
import type { RagClientResult, EngineResponse } from "../../../src/rag/engine-client.js";

const mockCatalog: BiasEntry[] = [
  {
    id: "confirmation-bias",
    name: "Confirmation Bias",
    category: "information-processing",
    definition: "Seeking or interpreting information that confirms existing beliefs.",
    detectionSignals: ["only looked for supporting evidence"],
  },
  {
    id: "anchoring",
    name: "Anchoring Bias",
    category: "decision-making",
    definition: "Over-relying on the first piece of information.",
    detectionSignals: ["first number drove decision"],
  },
];

function engineResponse(biases: EngineResponse["biases"]): EngineResponse {
  return {
    biases,
    retrieved_chunks: biases.length,
    taxonomy_version: "v1",
    embedding_model: "mock-embed",
    request_id: "req-1",
  };
}

describe("buildBiasWorkspace", () => {
  it("retrieved case: builds candidates from biases with retrieval_score > 0", () => {
    const result: RagClientResult = {
      status: "ok",
      data: engineResponse([
        {
          id: "confirmation_bias",
          name: "Confirmation Bias",
          retrieval_score: 0.82,
          definition: "def",
          examples: "ex",
          indicators: "only sought confirming evidence",
          false_positives: "fp",
          related_biases: "rb",
        },
      ]),
    };

    const workspace = buildBiasWorkspace(result, mockCatalog);

    expect(workspace.workspaceCase).toBe("retrieved");
    expect(workspace.candidates).toHaveLength(1);
    expect(workspace.candidates[0]).toEqual({
      bias_id: "confirmation_bias",
      name: "Confirmation Bias",
      confidence: 0.82,
      evidence: "only sought confirming evidence",
      source: "retrieved",
    });
    // engine underscore id converted to catalog hyphen format
    expect(workspace.retrievedIds.has("confirmation-bias")).toBe(true);
  });

  it("unavailable case: status !== ok yields empty candidates", () => {
    const workspace = buildBiasWorkspace({ status: "unavailable" }, mockCatalog);

    expect(workspace.workspaceCase).toBe("unavailable");
    expect(workspace.candidates).toEqual([]);
    expect(workspace.retrievedIds.size).toBe(0);
  });

  it("roster_fallback case: all biases at retrieval_score=0.0 maps to unavailable", () => {
    const result: RagClientResult = {
      status: "ok",
      data: engineResponse([
        {
          id: "confirmation_bias",
          name: "Confirmation Bias",
          retrieval_score: 0.0,
          definition: "def",
          examples: "",
          indicators: "",
          false_positives: "",
          related_biases: "",
        },
        {
          id: "anchoring",
          name: "Anchoring Bias",
          retrieval_score: 0.0,
          definition: "def",
          examples: "",
          indicators: "",
          false_positives: "",
          related_biases: "",
        },
      ]),
    };

    const workspace = buildBiasWorkspace(result, mockCatalog);

    expect(workspace.workspaceCase).toBe("unavailable");
    expect(workspace.candidates).toEqual([]);
    expect(workspace.retrievedIds.size).toBe(0);
  });

  it("mixed scores: only biases with retrieval_score > 0 become candidates", () => {
    const result: RagClientResult = {
      status: "ok",
      data: engineResponse([
        {
          id: "confirmation_bias",
          name: "Confirmation Bias",
          retrieval_score: 0.0,
          definition: "def",
          examples: "",
          indicators: "",
          false_positives: "",
          related_biases: "",
        },
        {
          id: "anchoring",
          name: "Anchoring Bias",
          retrieval_score: 0.82,
          definition: "def",
          examples: "ex",
          indicators: "first number drove the decision",
          false_positives: "fp",
          related_biases: "rb",
        },
      ]),
    };

    const workspace = buildBiasWorkspace(result, mockCatalog);

    expect(workspace.workspaceCase).toBe("retrieved");
    expect(workspace.candidates).toHaveLength(1);
    expect(workspace.candidates[0]?.bias_id).toBe("anchoring");
    expect(workspace.retrievedIds.has("anchoring")).toBe(true);
    expect(workspace.retrievedIds.has("confirmation-bias")).toBe(false);
  });
});

describe("renderWorkspaceToPrompt", () => {
  it("retrieved case: renders candidate table plus full roster", () => {
    const workspace = buildBiasWorkspace(
      {
        status: "ok",
        data: engineResponse([
          {
            id: "confirmation_bias",
            name: "Confirmation Bias",
            retrieval_score: 0.82,
            definition: "def",
            examples: "ex",
            indicators: "only sought confirming evidence",
            false_positives: "fp",
            related_biases: "rb",
          },
        ]),
      },
      mockCatalog,
    );

    const rendered = renderWorkspaceToPrompt(workspace, mockCatalog);

    expect(rendered).toContain("Candidate Biases");
    expect(rendered).toContain("Confirmation Bias");
    expect(rendered).toContain("0.82");
    expect(rendered).toContain("only sought confirming evidence");
    // roster still present for both catalog entries
    expect(rendered).toContain("Anchoring Bias");
  });

  it("unavailable case: renders roster-only, no candidate section", () => {
    const workspace = buildBiasWorkspace({ status: "unavailable" }, mockCatalog);

    const rendered = renderWorkspaceToPrompt(workspace, mockCatalog);

    expect(rendered).not.toContain("Candidate Biases");
    expect(rendered).toContain("Confirmation Bias");
    expect(rendered).toContain("Anchoring Bias");
  });
});
