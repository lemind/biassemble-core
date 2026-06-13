import guardrailsData from "./guardrails.json" with { type: "json" };
import questionBatchData from "./reflection/question-batch/system.json" with { type: "json" };
import assessmentData from "./reflection/assessment/system.json" with { type: "json" };

export type PromptTemplate = "question-batch" | "assessment";

interface PromptFile {
  content: string;
  version: string;
}

/** Loads guardrails + system prompts from JSON files, renders templates with variables. */
export class PromptRegistry {
  private guardrails: string;
  private version: string;

  constructor() {
    this.guardrails = guardrailsData.content;
    // Version comes from the assessment prompt JSON — single source of truth.
    this.version = (assessmentData as PromptFile).version;
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
