import type { BiasEntry } from "../catalog/bias-catalog";
import type { RagClientResult } from "./engine-client";

export type RagCase = "retrieved" | "roster_fallback" | "unavailable";

export interface BiasContextResult {
  biasContext: string;
  ragCase: RagCase;
  /** Bias IDs from engine response with retrieval_score > 0. Note: this module is vestigial —
   * only reachable via runStoryOnlyAssessment's hardcoded roster-only stub. The real retrieval
   * consumption path (workspace-builder.ts) has its own separate retrievedIds/engineSources. */
  retrievedIds: Set<string>;
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
    return { biasContext: roster, ragCase: "unavailable", retrievedIds: new Set() };
  }

  const retrieved = result.data.biases.filter((b) => b.retrieval_score > 0);

  // Case B: engine returned all-zero scores (roster fallback from engine T008).
  // Engine BiasResult.id and local BiasEntry.id must share the same string format
  // (e.g. "confirmation_bias") — see ADR D014.
  if (retrieved.length === 0) {
    return { biasContext: roster, ragCase: "roster_fallback", retrievedIds: new Set() };
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

  return { biasContext, ragCase: "retrieved", retrievedIds };
}
