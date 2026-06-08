import { createHash } from "node:crypto";

/**
 * Compute a deterministic SHA-256 hash of the canonical input.
 * Used for input_hash on runs and eval_results for determinism checking.
 */
export function computeInputHash(
  promptVersion: string,
  modelName: string,
  story: string,
  answers: string[]
): string {
  const input = [promptVersion, modelName, story, ...answers].join("\n\n");
  return createHash("sha256").update(input, "utf-8").digest("hex");
}