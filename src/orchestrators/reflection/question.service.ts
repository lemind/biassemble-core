import { logger } from "../../observability/logger.js";
import { QuestionOutputSchema, type QuestionOutput, SCHEMA_VERSION } from "../../contracts/reflection.schemas.js";
import { repairWithFallback } from "../../parsers/repair.js";
import { withRetry } from "../retry.js";
import type { Provider } from "../../providers/types.js";
import type { PromptRegistry } from "../../prompts/registry.js";

const MODULE = "question-service";

export class QuestionService {
  constructor(
    private provider: Provider,
    private prompts: PromptRegistry,
    private modelName: string
  ) {}

  async generate(story: string, requestId: string): Promise<QuestionOutput> {
    const system = this.prompts.render("question-batch", {});
    const user = `STORY: ${story}`;

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
