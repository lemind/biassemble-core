import { z } from "zod";
import { logger } from "../../observability/logger.js";
import { env } from "../../lib/env.js";
import { repairWithFallback } from "../../parsers/repair.js";
import { executeAndRecordLlmCall } from "../../observability/llm-call-recorder.js";
import { isSuspectedInjection, InjectionSuspectedError } from "./injection-guard.js";
import { RateLimitError } from "../../providers/gemini.js";
import { isPastDeadline } from "../retry.js";
import { EXTRACT_RESPONSE_KEYS, ExtractedClaimSchema } from "../../contracts/audit-internal.schemas.js";
import { generateClaimId } from "../../lib/audit-identifiers.js";
import type { Provider } from "../../providers/types.js";
import type { PromptRegistry } from "../../prompts/registry.js";
import type { LlmCallStore } from "../../persistence/ports.js";
import type { AuditStore } from "../../persistence/audit-store.js";
import type { Claim } from "../../db/schema.js";

const MODULE = "extract-service";
/** EXTRACT had zero retry: any provider abort or schema failure hard-failed the whole audit, before any
 * claim existed to degrade. Reproduced 3/3 live on an adversarial narrative payload. D018 §5.10. */
const EXTRACT_ATTEMPTS = 3;

const REFERENCE_RE = /\b(?:Article|Section|Paragraph|Item|§)\s*\d+(?:[-.]\d+)?\b/gi;

function extractReferences(text: string): string[] {
  return [...text.matchAll(REFERENCE_RE)].map((m) => m[0].replace(/\s+/g, " ").trim());
}

/** Catches a claim dropping a sub-reference its own excerpt cites (e.g. "Article 19-2" -> "Article 19"). Incident: extract-golden-set.json case 12. */
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

  // deadlineAt: wall-clock budget shared with VERIFY (D018 §5.13); default Infinity keeps existing
  // callers/tests (no deadline) behaving exactly as before.
  async run(
    auditId: string,
    outputText: string,
    task: string | undefined,
    maxClaims: number,
    deadlineAt: number = Infinity
  ): Promise<ExtractResult> {
    const system = this.prompts.render("audit-extract", {
      task: task ?? "",
      output_text: outputText,
      maxClaims: String(maxClaims),
    });
    const user = "Return the JSON now.";
    const promptVersion = this.prompts.getAuditVersion("extract");
    const providerId = this.provider.mode;

    // Unlike VERIFY there is no partial audit to degrade to on final failure — EXTRACT produces the claim
    // set itself, so a failure here still ends the audit, but only after EXTRACT_ATTEMPTS tries instead
    // of one. Reproduced live: a 21-claim adversarial narrative payload hard-failed 3/3 times with zero
    // retry. D018 §5.10.
    const schema = buildExtractResponseSchema(outputText);
    let parsed: z.infer<typeof schema> | null = null;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= EXTRACT_ATTEMPTS; attempt++) {
      if (isPastDeadline(deadlineAt)) {
        lastError = new Error(`EXTRACT deadline exceeded before attempt ${attempt}/${EXTRACT_ATTEMPTS}`);
        logger.warn({ module: MODULE, operation: "run", auditId, attempt }, "EXTRACT deadline exceeded — not retrying further");
        break;
      }
      let raw: unknown;
      let llmCallId: string | null = null;
      try {
        ({ result: raw, llmCallId } = await executeAndRecordLlmCall(
          // temperature: 0 — audit-mode output must be reproducible run-to-run on
          // identical input (a customer re-running an audit and getting a
          // different claim set/score each time is a trust-destroying bug for a
          // paid product, found in production 2026-07-26). The reflection flow's
          // default temperature is untouched; this is an explicit per-call override.
          () => this.provider.completeJson<unknown>({ system, user, options: { temperature: 0, timeoutMs: env.AUDIT_LLM_TIMEOUT_MS } }),
          // sessionId is auditId here, not null (T040) — audit mode has no
          // "session" concept, but llm_calls.session_id is a plain UUID with no
          // FK (schema.ts), so it doubles as the correlation key that lets
          // getCallsBySession(auditId) attribute LLM calls/tokens back to a run.
          { sessionId: auditId, stage: "extract", callType: "primary", provider: providerId, model: this.modelName, promptVersion },
          this.llmCallStore
        ));
      } catch (err) {
        if (err instanceof RateLimitError) throw err; // fails again immediately — retrying wastes attempts
        lastError = err as Error;
        logger.warn({ module: MODULE, operation: "run", auditId, attempt, err }, "EXTRACT provider call failed — retrying");
        continue;
      }

      if (isSuspectedInjection(JSON.stringify(raw), EXTRACT_RESPONSE_KEYS)) {
        logger.error({ module: MODULE, operation: "run", auditId, raw }, "EXTRACT response flagged as injection-suspected — hard stop, not repaired");
        if (llmCallId) {
          await this.llmCallStore.updateFailure(llmCallId, "schema_validation", "injection-suspected response").catch(() => {});
        }
        throw new InjectionSuspectedError("extract");
      }

      try {
        // salvageArrays: true — only EXTRACT wants a bad claim dropped instead of nulling `claims`
        // wholesale; other repairWithFallback callers (reflection's bias/question arrays) rely on
        // the null-then-retry default and must not opt in. D018 §5.15.
        const { result } = await repairWithFallback(JSON.stringify(raw), schema, null, { salvageArrays: true });
        // repair.ts's partial-field-recovery step (Stage 004) sets a whole
        // top-level field to null rather than throwing when only that field
        // fails validation — e.g. every claim's excerpt failing the
        // verbatim-substring superRefine check nulls out `claims` entirely
        // while `truncated` still parses fine. That's a legitimate partial
        // parse, not an absent response — it must fail EXTRACT cleanly, not
        // crash on `.length` a few lines below.
        if (result.claims === null || result.claims === undefined) {
          throw new Error("EXTRACT response failed schema validation: claims could not be parsed (see repair warnings)");
        }
        if (llmCallId) await this.llmCallStore.updateParsedOutput(llmCallId, result).catch(() => {});
        parsed = result;
        break;
      } catch (err) {
        lastError = err as Error;
        if (llmCallId) {
          await this.llmCallStore.updateFailure(llmCallId, "schema_validation", lastError.message).catch(() => {});
        }
        logger.warn({ module: MODULE, operation: "run", auditId, attempt, err }, "EXTRACT response unparseable — retrying");
      }
    }
    if (!parsed) {
      throw lastError ?? new Error("EXTRACT failed after retries with no captured error");
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
