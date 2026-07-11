import type { BiasEntry } from "../catalog/bias-catalog";
import type { EngineSource, RagClientResult } from "./engine-client";

export type RagCase = "retrieved" | "roster_fallback" | "unavailable";

export interface BiasContextResult {
  biasContext: string;
  ragCase: RagCase;
  /** Bias IDs (hyphenated) from engine response with retrieval_score > 0. Keys of `engineSources`. */
  retrievedIds: Set<string>;
  /**
   * Per-bias engine provenance (D015): normalized (hyphenated) bias id → the engine signal(s) that
   * surfaced it. Built from each retrieved bias's `source`, falling back to `["vector"]` when
   * `source` is null but `retrieval_score > 0` (research R3). Empty for roster_fallback/unavailable.
   */
  engineSources: Map<string, EngineSource[]>;
}

function buildRoster(catalog: BiasEntry[]): string {
  return catalog.map((b) => `- ${b.name}: ${b.definition}`).join("\n");
}

export function buildBiasContext(
  result: RagClientResult,
  catalog: BiasEntry[],
): BiasContextResult {
  const roster = buildRoster(catalog);

  // Case C: network error, timeout, auth error, or invalid shape
  if (result.status !== "ok") {
    return { biasContext: roster, ragCase: "unavailable", retrievedIds: new Set(), engineSources: new Map() };
  }

  const retrieved = result.data.biases.filter((b) => b.retrieval_score > 0);

  // Case B: engine returned all-zero scores (roster fallback from engine T008).
  // Engine BiasResult.id and local BiasEntry.id must share the same string format
  // (e.g. "confirmation_bias") — see ADR D014. If they diverge, engineSources
  // silently resolves to [] for all biases on Case A.
  if (retrieved.length === 0) {
    return { biasContext: roster, ragCase: "roster_fallback", retrievedIds: new Set(), engineSources: new Map() };
  }

  // Case A: at least one bias with retrieval_score > 0
  const tier1 = retrieved
    .map((b) =>
      [
        `## ${b.name}`,
        `**Definition**: ${b.definition}`,
        `**Examples**: ${b.examples}`,
        `**Indicators**: ${b.indicators}`,
        `**False positives**: ${b.false_positives}`,
        `**Related biases**: ${b.related_biases}`,
      ].join("\n"),
    )
    .join("\n\n");

  const biasContext = `### Retrieved Biases (full context)\n\n${tier1}\n\n### All Biases (roster)\n\n${roster}`;
  const retrievedIds = new Set(retrieved.map((b) => b.id.replace(/_/g, "-")));

  // Per-bias provenance: source array as-is, or ["vector"] fallback when the engine sent no
  // source but did retrieve it (research R3 — vector_only/nli_union carry source: null).
  const engineSources = new Map<string, EngineSource[]>(
    retrieved.map((b) => [
      b.id.replace(/_/g, "-"),
      b.source && b.source.length > 0 ? b.source : ["vector"],
    ]),
  );

  return { biasContext, ragCase: "retrieved", retrievedIds, engineSources };
}
