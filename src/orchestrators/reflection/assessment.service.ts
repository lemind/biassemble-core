import { logger } from "../../observability/logger.js";
import { AssessmentOutputSchema, type AssessmentOutput } from "../../contracts/reflection.schemas.js";
import { tryRepairJson } from "../../parsers/repair.js";
import { withRetry } from "../retry.js";
import type { Provider } from "../../providers/types.js";
import type { PromptRegistry } from "../../prompts/registry.js";
import type { BiasCatalogService } from "../../catalog/bias-catalog.js";

export class AssessmentService {
  constructor(
    private provider: Provider,
    private prompts: PromptRegistry,
    private catalog: BiasCatalogService
  ) {}

  async generate(
    story: string,
    questions: string[],
    answers: string[],
    requestId: string
  ): Promise<AssessmentOutput> {
    // 1. Prepare bias shortlist
    const biasShortlist = this.catalog.getAll()
      .map(b => `- ${b.name}: ${b.definition}`)
      .join("\n");

    // 2. Render prompt
    const system = this.prompts.render("assessment", {
      biasShortlist
    });

    const qaPairs = questions.map((q, i) => `Q: ${q}\nA: ${answers[i]}`).join("\n\n");
    const user = `STORY: ${story}\n\nCONVERSATION:\n${qaPairs}`;

    // 3. Generate with retry
    return await withRetry(async (attempt) => {
      logger.info({ requestId, attempt }, "Calling AI provider for assessment");

      const raw = await this.provider.completeJson<any>({
        system,
        user,
      });

      try {
        return AssessmentOutputSchema.parse(raw);
      } catch (error) {
        logger.warn({ requestId, error, raw }, "Zod validation failed, trying repair");
        return tryRepairJson(JSON.stringify(raw), AssessmentOutputSchema);
      }
    });
  }
}
