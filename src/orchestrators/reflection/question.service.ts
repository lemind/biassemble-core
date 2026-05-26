import { logger } from "../../observability/logger.js";
import { QuestionOutputSchema, type QuestionOutput } from "../../contracts/reflection.schemas.js";
import { tryRepairJson } from "../../parsers/repair.js";
import { withRetry } from "../retry.js";
import type { Provider } from "../../providers/types.js";
import type { PromptRegistry } from "../../prompts/registry.js";

export class QuestionService {
  constructor(
    private provider: Provider,
    private prompts: PromptRegistry
  ) {}

  async generate(story: string, requestId: string): Promise<QuestionOutput> {
    const system = this.prompts.render("question-batch", {});
    const user = `STORY: ${story}`;

    return await withRetry(async (attempt) => {
      logger.info({ requestId, attempt }, "Calling AI provider for questions");

      const raw = await this.provider.completeJson<any>({
        system,
        user,
      });

      try {
        // completeJson already does JSON.parse, but we might need repair 
        // if the provider didn't use application/json mode or failed.
        // For now, we trust the provider and validate with Zod.
        return QuestionOutputSchema.parse(raw);
      } catch (error) {
        logger.warn({ requestId, error, raw }, "Zod validation failed, trying repair");
        return tryRepairJson(JSON.stringify(raw), QuestionOutputSchema);
      }
    });
  }
}
