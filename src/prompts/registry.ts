import guardrailsData from "./guardrails.json" with { type: "json" };
import questionBatchData from "./reflection/question-batch/system.json" with { type: "json" };
import assessmentData from "./reflection/assessment/system.json" with { type: "json" };
import auditExtractData from "./audit/extract/system.json" with { type: "json" };
import auditVerifyData from "./audit/verify/system.json" with { type: "json" };
import grounnelExtractData from "./grounnel/extract/system.json" with { type: "json" };

export type PromptTemplate = "question-batch" | "assessment" | "audit-extract" | "audit-verify" | "grounnel-extract";

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
    // Version comes from the assessment prompt JSON — single source of truth
    // for story/reflection mode. Audit mode's EXTRACT/VERIFY each version
    // independently (data-model.md's prompt_revision_extract/_verify) — use
    // getAuditVersion(), not this method, for those.
    this.version = (assessmentData as PromptFile).version;
  }

  /** Returns the current prompt version string (reflection/story mode only). */
  getVersion(): string {
    return this.version;
  }

  /** Returns the current version for one audit-mode stage (EXTRACT/VERIFY version independently). */
  getAuditVersion(stage: "extract" | "verify"): string {
    return stage === "extract"
      ? (auditExtractData as PromptFile).version
      : (auditVerifyData as PromptFile).version;
  }

  /** Grounnel's own EXTRACT prompt version, independent of audit mode's (spec.md — self-contained surface). */
  getGrounnelExtractVersion(): string {
    return (grounnelExtractData as PromptFile).version;
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
      case "audit-extract":
        raw = auditExtractData.content;
        break;
      case "audit-verify":
        raw = auditVerifyData.content;
        break;
      case "grounnel-extract":
        raw = grounnelExtractData.content;
        break;
      default:
        throw new Error(`Unknown template: ${template satisfies never}`);
    }

    let rendered = raw.replace("{{guardrails}}", this.guardrails);

    for (const [key, value] of Object.entries(variables)) {
      rendered = rendered.replace(`{{${key}}}`, value);
    }

    return rendered;
  }
}
