import { logger } from "../../observability/logger.js";
import {
  AssessmentOutputSchema,
  type AssessmentOutput,
  SCHEMA_VERSION,
} from "../../contracts/reflection.schemas.js";
import type { ReasoningTrace } from "../../contracts/reasoning.schemas.js";
import { repairWithFallback } from "../../parsers/repair.js";
import { withRetry } from "../retry.js";
import { computeInputHash } from "../../lib/hash.js";
import { createRun, persistTrace } from "../../db/queries.js";
import type { Provider } from "../../providers/types.js";
import type { PromptRegistry } from "../../prompts/registry.js";
import type { BiasCatalogService } from "../../catalog/bias-catalog.js";
import { normalizeBiasName } from "../../catalog/normalize.js";

const MODULE = "assessment-service";

/**
 * Validates that the reasoning trace has a prompt_version set.
 * Throws with a descriptive message if missing (FR-014).
 * Per-step prompt_version validation deferred until schemas are updated.
 */
function validatePromptVersion(trace: ReasoningTrace): void {
  if (!trace.prompt_version) {
    throw new Error(
      "Validation failed: reasoning_trace is missing prompt_version"
    );
  }
}

export class AssessmentService {
  constructor(
    private provider: Provider,
    private prompts: PromptRegistry,
    private catalog: BiasCatalogService,
    private modelName: string
  ) {}

  /**
   * Backward-compatible pass-through to runFullAssessment.
   * Used by the existing route until T401 switches it to the new entry points.
   */
  async generate(
    story: string,
    questions: string[],
    answers: string[],
    requestId: string
  ): Promise<AssessmentOutput> {
    return this.runFullAssessment("", story, questions, answers, requestId);
  }

  /**
   * Run a story-only assessment (no questions/answers yet).
   * Creates a run with stage=initial_assessment, scope=story_only.
   */
  async runStoryOnlyAssessment(
    sessionId: string,
    story: string,
    requestId: string
  ): Promise<AssessmentOutput> {
    const promptVersion = this.prompts.getVersion();
    const providerId = this.provider.mode;
    const inputHash = computeInputHash(promptVersion, this.modelName, story, []);

    // Create run record — best-effort, non-blocking
    let runId = "";
    try {
      const run = await createRun(sessionId, {
        provider: providerId,
        modelName: this.modelName,
        stage: "initial_assessment",
        scope: "story_only",
        promptVersion,
        inputHash,
      });
      runId = run.id;
    } catch (err) {
      logger.warn(
        { module: MODULE, operation: "runStoryOnlyAssessment", error: err, requestId },
        "Failed to create run record — continuing without persistence"
      );
    }

    // Render prompt (story only, no Q&A)
    const biasShortlist = this.catalog
      .getAll()
      .map((b) => `- ${b.name}: ${b.definition}`)
      .join("\n");

    const system = this.prompts.render("assessment", { biasShortlist });
    const user = `STORY: ${story}`;

    const result = await this.callProvider(
      system,
      user,
      requestId,
      runId,
      "initial_assessment",
      "story_only",
      inputHash,
      promptVersion,
      providerId
    );

    return result;
  }

  /**
   * Run a full assessment with story + questions + answers.
   * Creates a run with stage=post_questions_assessment, scope=story_plus_answers.
   */
  async runFullAssessment(
    sessionId: string,
    story: string,
    questions: string[],
    answers: string[],
    requestId: string
  ): Promise<AssessmentOutput> {
    const promptVersion = this.prompts.getVersion();
    const providerId = this.provider.mode;
    const inputHash = computeInputHash(
      promptVersion,
      this.modelName,
      story,
      answers
    );

    // Create run record — best-effort, non-blocking
    let runId = "";
    try {
      const run = await createRun(sessionId, {
        provider: providerId,
        modelName: this.modelName,
        stage: "post_questions_assessment",
        scope: "story_plus_answers",
        promptVersion,
        inputHash,
      });
      runId = run.id;
    } catch (err) {
      logger.warn(
        { module: MODULE, operation: "runFullAssessment", error: err, requestId },
        "Failed to create run record — continuing without persistence"
      );
    }

    // Render prompt with Q&A
    const biasShortlist = this.catalog
      .getAll()
      .map((b) => `- ${b.name}: ${b.definition}`)
      .join("\n");

    const system = this.prompts.render("assessment", { biasShortlist });
    const qaPairs = questions
      .map((q, i) => `Q: ${q}\nA: ${answers[i]}`)
      .join("\n\n");
    const user = `STORY: ${story}\n\nCONVERSATION:\n${qaPairs}`;

    const result = await this.callProvider(
      system,
      user,
      requestId,
      runId,
      "post_questions_assessment",
      "story_plus_answers",
      inputHash,
      promptVersion,
      providerId
    );

    return result;
  }

  /**
   * Shared provider call + parsing + validation + persistence logic.
   */
  private async callProvider(
    system: string,
    user: string,
    requestId: string,
    runId: string,
    stage: "initial_assessment" | "post_questions_assessment",
    scope: "story_only" | "story_plus_answers",
    inputHash: string,
    promptVersion: string,
    providerId: string
  ): Promise<AssessmentOutput> {
    return await withRetry(async (attempt) => {
      logger.info(
        { module: MODULE, operation: "callProvider", requestId, attempt, stage, scope },
        "Calling AI provider for assessment"
      );

      const raw = await this.provider.completeJson<any>({
        system,
        user,
      });

      // Use the full repair pipeline
      const parsed = await repairWithFallback(
        JSON.stringify(raw),
        AssessmentOutputSchema,
        async () => {
          logger.warn(
            { module: MODULE, operation: "callProvider", requestId },
            "Attempting fallback model call for assessment generation"
          );
          return await this.provider.completeJson<AssessmentOutput>({
            system,
            user,
          });
        }
      );

      // Extract and validate reasoning trace
      if (parsed.reasoningTrace) {
        validatePromptVersion(parsed.reasoningTrace as ReasoningTrace);

        // Persist the reasoning trace
        try {
          await persistTrace(runId, parsed.reasoningTrace);
          logger.info(
            { module: MODULE, operation: "callProvider", runId, requestId },
            "Reasoning trace persisted"
          );
        } catch (persistErr) {
          logger.error(
            { module: MODULE, operation: "callProvider", runId, requestId, error: persistErr },
            "Failed to persist reasoning trace — continuing"
          );
        }
      } else {
        logger.warn(
          { module: MODULE, operation: "callProvider", requestId },
          "No reasoning trace in response"
        );
      }

      // Normalize bias names against catalog
      const allBiases = this.catalog.getAll();
      const normalizedBiases = parsed.biases.map((bias) => {
        const result = normalizeBiasName(bias.name, allBiases);
        return {
          ...bias,
          name: result.name,
          ...(result.id ? { biasCatalogId: result.id } : {}),
        };
      });

      // Stamp version, model, stage, scope fields
      return {
        ...parsed,
        biases: normalizedBiases,
        prompt_version: promptVersion,
        schema_version: SCHEMA_VERSION,
        modelName: this.modelName,
        inputContext: scope === "story_only" ? "story-only" : "full",
      };
    });
  }
}