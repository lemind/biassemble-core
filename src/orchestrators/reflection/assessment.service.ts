import { logger } from "../../observability/logger.js";
import { AssessmentOutputSchema, type AssessmentOutput, SCHEMA_VERSION } from "../../contracts/reflection.schemas.js";
import { repairWithFallback } from "../../parsers/repair.js";
import { withRetry } from "../retry.js";
import type { Provider } from "../../providers/types.js";
import type { PromptRegistry } from "../../prompts/registry.js";
import type { BiasCatalogService } from "../../catalog/bias-catalog.js";
import { normalizeBiasName } from "../../catalog/normalize.js";

const MODULE = "assessment-service";

export class AssessmentService {
  constructor(
    private provider: Provider,
    private prompts: PromptRegistry,
    private catalog: BiasCatalogService,
    private modelName: string
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
      logger.info(
        { module: MODULE, operation: "generate", requestId, attempt },
        "Calling AI provider for assessment"
      );

      const raw = await this.provider.completeJson<any>({
        system,
        user,
      });

      // Use the full repair pipeline: try repair, then fallback model call
      const parsed = await repairWithFallback(
        JSON.stringify(raw),
        AssessmentOutputSchema,
        async () => {
          logger.warn(
            { module: MODULE, operation: "generate", requestId },
            "Attempting fallback model call for assessment generation"
          );
          return await this.provider.completeJson<AssessmentOutput>({
            system,
            user,
          });
        }
      );

      // 4. Normalize bias names against catalog
      const allBiases = this.catalog.getAll();
      const normalizedBiases = parsed.biases.map((bias) => {
        const result = normalizeBiasName(bias.name, allBiases);
        return {
          ...bias,
          name: result.name,
          ...(result.id ? { biasCatalogId: result.id } : {}),
        };
      });

      // 5. Stamp version and model fields
      return {
        ...parsed,
        biases: normalizedBiases,
        prompt_version: this.prompts.getVersion(),
        schema_version: SCHEMA_VERSION,
        modelName: this.modelName,
      };
    });
  }
}
