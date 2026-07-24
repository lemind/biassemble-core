import { z } from "zod";
import { logger } from "../../observability/logger.js";
import { repairWithFallback } from "../../parsers/repair.js";
import { executeAndRecordLlmCall } from "../../observability/llm-call-recorder.js";
import { isSuspectedInjection, InjectionSuspectedError } from "./injection-guard.js";
import { EXTRACT_RESPONSE_KEYS, ExtractedClaimSchema } from "../../contracts/audit-internal.schemas.js";
import { generateClaimId } from "../../lib/audit-identifiers.js";
import type { Provider } from "../../providers/types.js";
import type { PromptRegistry } from "../../prompts/registry.js";
import type { LlmCallStore } from "../../persistence/ports.js";
import type { AuditStore } from "../../persistence/audit-store.js";
import type { Claim } from "../../db/schema.js";

const MODULE = "extract-service";

const REFERENCE_RE = /\b(?:Article|Section|Paragraph|Item|§)\s*\d+(?:[-.]\d+)?\b/gi;

function extractReferences(text: string): string[] {
  return [...text.matchAll(REFERENCE_RE)].map((m) => m[0].replace(/\s+/g, " ").trim());
}

/**
 * Catches EXTRACT paraphrasing a legal/financial reference down to a bare
 * base number when its own excerpt cites a more specific sub-reference —
 * e.g. excerpt "Article 19-2 provides a special indemnity..." paraphrased
 * as claim "Article 19 provides...". Found in production 2026-07-23: the
 * mangled claim was then correctly rejected by VERIFY as unsupported (bare
 * Article 19 is just the damages-period article), producing a confident,
 * false "the audited output got this wrong" reading of a claim the audited
 * output actually stated correctly. Only fires when the claim keeps a bare
 * form of the same base number — a claim that drops the reference entirely
 * (fair paraphrasing) is not flagged.
 */
export function findReferenceDrift(claim: string, excerpt: string): string | null {
  for (const ref of extractReferences(excerpt)) {
    if (claim.includes(ref)) continue;
    const baseMatch = ref.match(/^(\D*)(\d+)/);
    if (!baseMatch) continue;
    const [, prefix, baseNum] = baseMatch;
    const baseToken = `${prefix}${baseNum}`.trim();
    const escaped = baseToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const baseRe = new RegExp(`\\b${escaped}\\b(?!\\s*[-.]\\d)`, "i");
    if (baseRe.test(claim)) {
      return `excerpt cites "${ref}" but claim only cites "${baseToken}" — sub-reference dropped`;
    }
  }
  return null;
}

/** Zod schema with the excerpt-verbatim-substring rule baked in via the captured outputText (data-model.md's Claim validation). */
function buildExtractResponseSchema(outputText: string) {
  return z.object({
    claims: z.array(ExtractedClaimSchema).superRefine((claims, ctx) => {
      claims.forEach((c, i) => {
        if (!outputText.includes(c.excerpt)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, "excerpt"],
            message: "excerpt is not a verbatim substring of output_text",
          });
        }
        const drift = findReferenceDrift(c.claim, c.excerpt);
        if (drift) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i, "claim"],
            message: `reference drift: ${drift}`,
          });
        }
      });
    }),
    truncated: z.boolean(),
  });
}

export interface ExtractResult {
  claims: Claim[];
  truncated: boolean;
}

export class ExtractService {
  constructor(
    private provider: Provider,
    private prompts: PromptRegistry,
    private modelName: string,
    private llmCallStore: LlmCallStore,
    private auditStore: AuditStore
  ) {}

  async run(auditId: string, outputText: string, task: string | undefined, maxClaims: number): Promise<ExtractResult> {
    const system = this.prompts.render("audit-extract", {
      task: task ?? "",
      output_text: outputText,
      maxClaims: String(maxClaims),
    });
    const user = "Return the JSON now.";
    const promptVersion = this.prompts.getAuditVersion("extract");
    const providerId = this.provider.mode;

    const { result: raw, llmCallId } = await executeAndRecordLlmCall(
      () => this.provider.completeJson<unknown>({ system, user }),
      // sessionId is auditId here, not null (T040) — audit mode has no
      // "session" concept, but llm_calls.session_id is a plain UUID with no
      // FK (schema.ts), so it doubles as the correlation key that lets
      // getCallsBySession(auditId) attribute LLM calls/tokens back to a run.
      { sessionId: auditId, stage: "extract", callType: "primary", provider: providerId, model: this.modelName, promptVersion },
      this.llmCallStore
    );

    if (isSuspectedInjection(JSON.stringify(raw), EXTRACT_RESPONSE_KEYS)) {
      logger.error({ module: MODULE, operation: "run", auditId, raw }, "EXTRACT response flagged as injection-suspected — hard stop, not repaired");
      if (llmCallId) {
        await this.llmCallStore.updateFailure(llmCallId, "schema_validation", "injection-suspected response").catch(() => {});
      }
      throw new InjectionSuspectedError("extract");
    }

    const schema = buildExtractResponseSchema(outputText);
    let parsed: z.infer<typeof schema>;
    try {
      const { result } = await repairWithFallback(JSON.stringify(raw), schema, null);
      parsed = result;
      // repair.ts's partial-field-recovery step (Stage 004) sets a whole
      // top-level field to null rather than throwing when only that field
      // fails validation — e.g. every claim's excerpt failing the
      // verbatim-substring superRefine check nulls out `claims` entirely
      // while `truncated` still parses fine. That's a legitimate partial
      // parse, not an absent response — it must fail EXTRACT cleanly, not
      // crash on `.length` a few lines below.
      if (parsed.claims === null || parsed.claims === undefined) {
        throw new Error("EXTRACT response failed schema validation: claims could not be parsed (see repair warnings)");
      }
      if (llmCallId) await this.llmCallStore.updateParsedOutput(llmCallId, parsed).catch(() => {});
    } catch (err) {
      if (llmCallId) {
        await this.llmCallStore.updateFailure(llmCallId, "schema_validation", (err as Error).message).catch(() => {});
      }
      throw err;
    }

    // Belt-and-suspenders cap enforcement (FR-019) — the prompt asks the model
    // to self-truncate, but a cap only the model enforces isn't really a cap.
    let claims = parsed.claims;
    let truncated = parsed.truncated;
    if (claims.length > maxClaims) {
      claims = claims.slice(0, maxClaims);
      truncated = true;
    }

    const claimRows = claims.map((c) => ({
      claimId: generateClaimId(),
      auditId,
      type: c.type,
      claimText: c.claim,
      excerpt: c.excerpt,
      locations: c.locations,
      period: c.period === "unresolved" ? null : c.period,
      derived: c.derived,
    }));

    const inserted = claimRows.length > 0 ? await this.auditStore.createClaims(claimRows) : [];

    await this.auditStore.updateAudit(auditId, {
      promptRevisionExtract: promptVersion,
      modelRevisionExtract: this.modelName,
      truncated,
    });

    return { claims: inserted, truncated };
  }
}
