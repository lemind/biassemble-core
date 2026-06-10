import guardrailsData from "./guardrails.json" with { type: "json" };
import questionBatchData from "./reflection/question-batch/system.json" with { type: "json" };
import assessmentData from "./reflection/assessment/system.json" with { type: "json" };

export type PromptTemplate = "question-batch" | "assessment";

export class PromptRegistry {
  private guardrails: string;
  private version: string;

  constructor(version = "1.0.0") {
    this.guardrails = guardrailsData.content;
    this.version = version;
  }

  /** Returns the current prompt version string. */
  getVersion(): string {
    return this.version;
  }

  render(template: PromptTemplate, variables: Record<string, string>): string {
    let raw: string;

    switch (template) {
      case "question-batch":
        raw = questionBatchData.content;
        break;
      case "assessment":
        raw = assessmentData.content;
        break;
      default:
        throw new Error(`Unknown template: ${template}`);
    }

    let rendered = raw.replace("{{guardrails}}", this.guardrails);

    for (const [key, value] of Object.entries(variables)) {
      rendered = rendered.replace(`{{${key}}}`, value);
    }

    return rendered;
  }
}
