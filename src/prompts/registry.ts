import guardrailsMd from "./guardrails.md";
import questionBatchSystem from "./reflection/question-batch/system.md";
import assessmentSystem from "./reflection/assessment/system.md";

export type PromptTemplate = "question-batch" | "assessment";

export class PromptRegistry {
  private guardrails: string;
  private version: string;

  constructor(version = "1.0.0") {
    this.guardrails = guardrailsMd;
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
        raw = questionBatchSystem;
        break;
      case "assessment":
        raw = assessmentSystem;
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
