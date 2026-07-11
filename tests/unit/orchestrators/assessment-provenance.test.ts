import { describe, it, expect, vi } from "vitest";
import { AssessmentService } from "../../../src/orchestrators/reflection/assessment.service.js";
import { MockProvider } from "../../mocks/mock-provider.js";
import { PromptRegistry } from "../../../src/prompts/registry.js";
import { BiasCatalogService } from "../../../src/catalog/bias-catalog.js";
import type { LlmCallStore, RunStore, TraceStore } from "../../../src/persistence/ports.js";
import type { EngineResponse, RagEngineClient, BiasResult } from "../../../src/rag/engine-client.js";

function engineBias(partial: Partial<BiasResult> & { id: string; retrieval_score: number }): BiasResult {
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

function makeService(storedRag: EngineResponse | null) {
  const llmCallStore: LlmCallStore = {
    recordCall: vi.fn().mockResolvedValue({ id: "llm-1" }),
    getCallsBySession: vi.fn().mockResolvedValue([]),
    getCallsByStage: vi.fn().mockResolvedValue([]),
    getCallsByProvider: vi.fn().mockResolvedValue([]),
    getCallsBySessionAndStage: vi.fn().mockResolvedValue([]),
    updateParsedOutput: vi.fn().mockResolvedValue(undefined),
    updateFailure: vi.fn().mockResolvedValue(undefined),
    getCallsForMetrics: vi.fn().mockResolvedValue([]),
  };
  const runStore: RunStore = {
    createRun: vi.fn().mockResolvedValue({ id: "run-1" }),
    getRunsBySession: vi.fn().mockResolvedValue([]),
    storeRagResult: vi.fn().mockResolvedValue(undefined),
    getRagResultForSession: vi.fn().mockResolvedValue(storedRag),
  };
  const traceStore: TraceStore = {
    persistTrace: vi.fn().mockResolvedValue(undefined),
    getTrace: vi.fn().mockResolvedValue(null),
  };
  const provider = new MockProvider();
  // ragClient only needs to be truthy — runFullAssessment reconstructs from the stored result.
  const ragClient = {} as unknown as RagEngineClient;
  const service = new AssessmentService(
    provider, new PromptRegistry(), new BiasCatalogService(), "mock-model",
    llmCallStore, runStore, traceStore, ragClient,
  );
  return { service, provider };
}

function storedResponse(biases: BiasResult[]): EngineResponse {
  return { biases, retrieved_chunks: biases.length, taxonomy_version: "t", embedding_model: "m", request_id: "req" };
}

const providerBias = (name: string) => ({
  name,
  explanation: "This is a sufficiently long explanation of the bias for the parser.",
  storyConnection: "In your story you did the thing that shows this.",
  alternativePerspective: "Consider the opposite perspective for balance.",
});

describe("AssessmentService — per-bias engineSources derivation (D015)", () => {
  it("engine=retrieved: copies engine sources; a bias the LLM named alone gets [] (distinguishable via ragCase)", async () => {
    const { service, provider } = makeService(
      storedResponse([
        engineBias({ id: "confirmation_bias", retrieval_score: 0.9, source: ["vector", "llm"] }),
        engineBias({ id: "anchoring", retrieval_score: 0.7, source: ["vector"] }),
      ]),
    );
    provider.setDefault({
      biases: [providerBias("Confirmation Bias"), providerBias("Sunk Cost Fallacy")],
      reflectionPrompt: "Reflect on your reasoning here in a meaningful way.",
    });

    const { output, ragCase } = await service.runFullAssessment("sess-1", "the story", [], [], "req-1");

    expect(ragCase).toBe("retrieved");
    const byName = Object.fromEntries(output.biases.map((b) => [b.name, b]));
    // engine surfaced this → copied straight from the engine source array
    expect(byName["Confirmation Bias"].engineSources).toEqual(["vector", "llm"]);
    // engine ran but did not surface this one → assessment-LLM-alone → []
    expect(byName["Sunk Cost Fallacy"].engineSources).toEqual([]);
    // per-bias output must NOT carry ragCase (storage-only, review finding 3)
    expect((byName["Sunk Cost Fallacy"] as Record<string, unknown>).ragCase).toBeUndefined();
  });

  it("engine=roster_fallback: [] means unknown, disambiguated by the returned ragCase (not assessment-alone)", async () => {
    const { service, provider } = makeService(
      storedResponse([engineBias({ id: "confirmation_bias", retrieval_score: 0, source: ["vector"] })]),
    );
    provider.setDefault({
      biases: [providerBias("Confirmation Bias")],
      reflectionPrompt: "Reflect on your reasoning here in a meaningful way.",
    });

    const { output, ragCase } = await service.runFullAssessment("sess-2", "the story", [], [], "req-2");

    expect(ragCase).toBe("roster_fallback");
    expect(output.biases[0].engineSources).toEqual([]);
  });
});
