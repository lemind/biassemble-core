import { logger } from "../../observability/logger";
import { QuestionOutputSchema, type QuestionOutput, SCHEMA_VERSION } from "../../contracts/reflection.schemas";
import type { StoryAnalysis, Interpretation } from "../../contracts/reasoning.schemas";
import { repairWithFallback } from "../../parsers/repair";
import { withRetry } from "../retry";
import type { Provider } from "../../providers/types";
import type { PromptRegistry } from "../../prompts/registry";

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

      const raw = await this.provider.completeJson<any>({
        system,
        user,
      });

      // Use the full repair pipeline: try repair, then fallback model call
      const parsed = await repairWithFallback(
        JSON.stringify(raw),
        QuestionOutputSchema,
        async () => {
          logger.warn(
            { module: MODULE, operation: "generate", requestId },
            "Attempting fallback model call for question generation"
          );
          return await this.provider.completeJson<QuestionOutput>({
            system,
            user,
          });
        }
      );

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