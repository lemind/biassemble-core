import type { BiasEntry } from "../catalog/bias-catalog";
import type { RagClientResult } from "./engine-client";

export type WorkspaceCase = "retrieved" | "unavailable";

export interface BiasCandidate {
  bias_id: string;
  name: string;
  confidence: number;
  evidence: string;
  source: "retrieved";
}

export interface BiasWorkspace {
  candidates: BiasCandidate[];
  workspaceCase: WorkspaceCase;
  /** Bias IDs (catalog format, hyphenated) with retrieval_score > 0; used to derive context_source per bias. */
  retrievedIds: Set<string>;
}

function buildRoster(catalog: BiasEntry[]): string {
  return catalog.map((b) => `- ${b.name}: ${b.definition}`).join("\n");
}

export function buildBiasWorkspace(
  result: RagClientResult,
  catalog: BiasEntry[],
): BiasWorkspace {
  // Unavailable: network error, timeout, auth error, or invalid shape
  if (result.status !== "ok") {
    return { candidates: [], workspaceCase: "unavailable", retrievedIds: new Set() };
  }

  const retrieved = result.data.biases.filter((b) => b.retrieval_score > 0);

  // Unavailable: engine returned all-zero scores (roster fallback from engine T008)
  if (retrieved.length === 0) {
    return { candidates: [], workspaceCase: "unavailable", retrievedIds: new Set() };
  }

  const candidates: BiasCandidate[] = retrieved.map((b) => ({
    bias_id: b.id,
    name: b.name,
    confidence: b.retrieval_score,
    evidence: b.indicators,
    source: "retrieved",
  }));

  // Engine uses underscore IDs (e.g. "confirmation_bias"); catalog uses hyphenated
  // IDs (e.g. "confirmation-bias") — convert before comparing. See ADR D014.
  const retrievedIds = new Set(retrieved.map((b) => b.id.replace(/_/g, "-")));

  return { candidates, workspaceCase: "retrieved", retrievedIds };
}

export function renderWorkspaceToPrompt(workspace: BiasWorkspace, catalog: BiasEntry[]): string {
  const roster = buildRoster(catalog);

  if (workspace.workspaceCase === "unavailable") {
    return roster;
  }

  const table = workspace.candidates
    .map((c) =>
      [
        `## ${c.name}`,
        `**Confidence**: ${c.confidence.toFixed(2)}`,
        `**Indicators**: ${c.evidence}`,
      ].join("\n"),
    )
    .join("\n\n");

  return `### Candidate Biases (retrieved)\n\n${table}\n\n### All Biases (roster)\n\n${roster}`;
}
