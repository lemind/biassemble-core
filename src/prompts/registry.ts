import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type PromptTemplate = "question-batch" | "assessment";

export class PromptRegistry {
  private guardrails: string;

  constructor() {
    this.guardrails = readFileSync(
      join(__dirname, "guardrails.md"),
      "utf-8"
    );
  }

  render(template: PromptTemplate, variables: Record<string, string>): string {
    const path = this.getTemplatePath(template);
    const raw = readFileSync(path, "utf-8");

    let rendered = raw.replace("{{guardrails}}", this.guardrails);

    for (const [key, value] of Object.entries(variables)) {
      rendered = rendered.replace(`{{${key}}}`, value);
    }

    return rendered;
  }

  private getTemplatePath(template: PromptTemplate): string {
    switch (template) {
      case "question-batch":
        return join(__dirname, "reflection", "question-batch", "system.md");
      case "assessment":
        return join(__dirname, "reflection", "assessment", "system.md");
      default:
        throw new Error(`Unknown template: ${template}`);
    }
  }
}
