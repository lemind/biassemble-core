import { logger } from "../../observability/logger";
import { QuestionOutputSchema, type QuestionOutput, SCHEMA_VERSION } from "../../contracts/reflection.schemas";
import type { StoryAnalysis, Interpretation } from "../../contracts/reasoning.schemas";
import { repairWithFallback } from "../../parsers/repair";
import { withRetry } from "../retry";
import type { Provider } from "../../providers/types";
import type { PromptRegistry } from "../../prompts/registry";
import { executeAndRecordLlmCall } from "../../observability/llm-call-recorder";
import { updateLlmCallParsedOutput } from "../../db/queries";

const MODULE = "question-service";

/** Generates contextual follow-up questions from a story using the AI provider, with repair+fallback. */
export class QuestionService {
  constructor(
    private provider: Provider,
    private prompts: PromptRegistry,
    private modelName: string
  ) {}

  /**
   * Generate contextual follow-up questions for the user's story.
   *
   * When `storyAnalysis` and `interpretations` are provided (from Trace 1 of
   * the two-phase flow), the questions probe the user's specific interpretations
   * rather than generic surface-level details (FR-018).
   */
  async generate(
    sessionId: string,
    story: string,
    requestId: string,
    storyAnalysis?: StoryAnalysis,
    interpretations?: Interpretation[]
  ): Promise<QuestionOutput> {
    // Build reasoning context block when available
    let reasoningContext = "";
    if (storyAnalysis) {
      reasoningContext +=
        "Themes: " + storyAnalysis.themes.join(", ") + "\n" +
        "Emotional tone: " + storyAnalysis.emotional_tone + "\n" +
        "Key events: " + storyAnalysis.key_events.join(", ") + "\n";
    }
    if (interpretations && interpretations.length > 0) {
      reasoningContext += "\nPlausible interpretations:\n" +
        interpretations
          .slice(0, 2) // highest-plausibility only
          .map((i, idx) => `${idx + 1}. ${i.interpretation} (plausibility: ${i.plausibility})`)
          .join("\n");
    }

    const system = this.prompts.render("question-batch", {});
    const user = reasoningContext
      ? `REASONING CONTEXT:\n${reasoningContext}\n\nSTORY: ${story}`
      : `STORY: ${story}`;

    return await withRetry(async (attempt) => {
      logger.info(
        { module: MODULE, operation: "generate", requestId, attempt },
        "Calling AI provider for questions"
      );

      const promptVersion = this.prompts.getVersion();
      const providerId = this.provider.mode;
      const t0 = Date.now();

      const { result: raw, llmCallId: primaryLlmCallId } = await executeAndRecordLlmCall(
        () => this.provider.completeJson<unknown>({ system, user }),
        {
          sessionId,
          stage: "question",
          callType: "primary",
          provider: providerId,
          model: this.modelName,
          promptVersion,
        }
      );

      // Use the full repair pipeline: try repair, then fallback model call
      const parsed = await repairWithFallback(
        JSON.stringify(raw),
        QuestionOutputSchema,
        async () => {
          logger.warn(
            { module: MODULE, operation: "generate", requestId },
            "Attempting fallback model call for question generation"
          );
          const { result, llmCallId } = await executeAndRecordLlmCall(
            () => this.provider.completeJson<QuestionOutput>({ system, user }),
            {
              sessionId,
              stage: "question",
              callType: "fallback",
              provider: providerId,
              model: this.modelName,
              promptVersion,
            }
          );
          // Update fallback call with parsed output
          if (llmCallId) {
            await updateLlmCallParsedOutput(llmCallId, result as unknown as Record<string, unknown>).catch((err) => {
              logger.warn(
                { module: MODULE, operation: "updateLlmCallParsedOutput", llmCallId, error: err },
                "Failed to update fallback LLM call parsed output"
              );
            });
          }
          return result;
        }
      );

      // Update primary call with parsed output (after successful repair/parsing)
      if (primaryLlmCallId) {
        await updateLlmCallParsedOutput(primaryLlmCallId, parsed as unknown as Record<string, unknown>).catch((err) => {
          logger.warn(
            { module: MODULE, operation: "updateLlmCallParsedOutput", llmCallId: primaryLlmCallId, error: err },
            "Failed to update primary LLM call parsed output"
          );
        });
      }

      // Stamp version and model fields
      return {
        ...parsed,
        prompt_version: this.prompts.getVersion(),
        schema_version: SCHEMA_VERSION,
        modelName: this.modelName,
      };
    });
  }
}