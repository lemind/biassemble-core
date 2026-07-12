import { logger } from "../../observability/logger";
import {
  AssessmentOutputSchema,
  type AssessmentOutput,
  SCHEMA_VERSION,
} from "../../contracts/reflection.schemas";
import type { PromptVersion } from "../../contracts/reasoning.schemas";
import { repairWithFallback } from "../../parsers/repair";
import { withRetry } from "../retry";
import { computeInputHash } from "../../lib/hash";
import { executeAndRecordLlmCall } from "../../observability/llm-call-recorder";
import type { Provider } from "../../providers/types";
import type { PromptRegistry } from "../../prompts/registry";
import type { BiasCatalogService } from "../../catalog/bias-catalog";
import { normalizeBiasName } from "../../catalog/normalize";
import { validateEvidence } from "../../parsers/evidence-validator";
import type { LlmCallStore, RunStore, TraceStore } from "../../persistence/ports";
import { isEngineResponse, type RagEngineClient } from "../../rag/engine-client";
import { buildBiasContext, type RagCase } from "../../rag/context-builder";
import { buildBiasWorkspace, renderWorkspaceToPrompt } from "../../rag/workspace-builder";
import type { Inngest } from "inngest";
import { waitUntil } from "@vercel/functions";

const MODULE = "assessment-service";

/** Orchestrates assessment generation: renders prompts, calls provider, parses + validates output, persists traces. */
export class AssessmentService {
  constructor(
    private provider: Provider,
    private prompts: PromptRegistry,
    private catalog: BiasCatalogService,
    private modelName: string,
    private llmCallStore: LlmCallStore,
    private runStore: RunStore,
    private traceStore: TraceStore,
    private ragClient?: RagEngineClient,
    private inngestClient?: Inngest,
  ) {}

  /**
   * Backward-compatible pass-through to runFullAssessment.
   * Used by the existing route until T401 switches it to the new entry points.
   */
  async generate(
    story: string,
    questions: string[],
    answers: string[],
    requestId: string
  ): Promise<AssessmentOutput> {
    return (await this.runFullAssessment("", story, questions, answers, requestId)).output;
  }

  /**
   * Fires RAG retrieval as a background Inngest job. This is the ONLY place
   * RAG gets fired — called from the POST /v1/reflection/question route,
   * which is the actual story-submission trigger point the backend calls on
   * every request. (runStoryOnlyAssessment used to also fire RAG, but nothing
   * in production calls that endpoint; keeping the fire there too would have
   * meant a double-fire — two Inngest jobs, two initial_assessment run rows —
   * for any client that called both. Removed rather than left as a
   * caller-discipline invariant.)
   *
   * Creates a correlation-only run record (stage=initial_assessment,
   * scope=story_only) purely to give the background job a runId to write its
   * result against — this row has no LLM call, no reasoning_trace, no parsed
   * output. To distinguish it from a "real" assessment run at query time:
   * LEFT JOIN reasoning_traces — correlation-only rows have no match.
   *
   * Fire-and-forget by design: internally wraps the work in `waitUntil()` so
   * it survives past the caller's HTTP response on Vercel, and returns void
   * rather than a promise so there's nothing for a caller to forget to await
   * or wrap themselves (see D016 for why that matters on Vercel).
   */
  fireRagRetrieval(sessionId: string, story: string, requestId: string): void {
    waitUntil(
      this.doFireRagRetrieval(sessionId, story, requestId).catch(() => {/* already logged in doFireRagRetrieval */})
    );
  }

  private async doFireRagRetrieval(sessionId: string, story: string, requestId: string): Promise<void> {
    if (!this.ragClient || !this.inngestClient) return;

    let runId = "";
    try {
      const promptVersion = this.prompts.getVersion();
      const providerId = this.provider.mode;
      const inputHash = computeInputHash(promptVersion, this.modelName, story, []);
      const run = await this.runStore.createRun(sessionId, {
        provider: providerId,
        modelName: this.modelName,
        stage: "initial_assessment",
        scope: "story_only",
        promptVersion,
        inputHash,
      });
      runId = run?.id ?? "";
    } catch (err) {
      logger.warn(
        { module: MODULE, operation: "fireRagRetrieval", error: err, requestId },
        "Failed to create run record for RAG correlation — skipping RAG fire"
      );
      return;
    }
    if (!runId) return;

    const startedAt = new Date();
    try {
      await this.inngestClient.send({
        name: "rag/retrieve.requested",
        data: { story, sessionId, runId, startedAt: startedAt.toISOString() },
      });
      logger.info(
        { module: MODULE, operation: "fireRagRetrieval", sessionId, runId },
        "rag_job_fired"
      );
      await this.runStore.recordRagStarted(runId, startedAt).catch(() => {/* already logged in recordRagStarted */});
    } catch (err) {
      logger.warn(
        { module: MODULE, operation: "fireRagRetrieval", sessionId, runId, error: err },
        "rag_job_fire_failed"
      );
    }
  }

  /**
   * Run a story-only assessment (no questions/answers yet).
   * Creates a run with stage=initial_assessment, scope=story_only.
   */
  async runStoryOnlyAssessment(
    sessionId: string,
    story: string,
    requestId: string
  ): Promise<AssessmentOutput> {
    const promptVersion = this.prompts.getVersion();
    const providerId = this.provider.mode;
    const inputHash = computeInputHash(promptVersion, this.modelName, story, []);

    // Create run record — best-effort, non-blocking
    let runId = "";
    try {
      const run = await this.runStore.createRun(sessionId, {
        provider: providerId,
        modelName: this.modelName,
        stage: "initial_assessment",
        scope: "story_only",
        promptVersion,
        inputHash,
      });
      runId = run?.id ?? "";
    } catch (err) {
      logger.warn(
        { module: MODULE, operation: "runStoryOnlyAssessment", error: err, requestId },
        "Failed to create run record — continuing without persistence"
      );
    }

    // Stage 005: RAG firing lives entirely in fireRagRetrieval, called only from
    // the POST /v1/reflection/question route — see that method's doc comment for
    // why. story_only always renders roster-only context immediately regardless.
    const ragCase: RagCase = "unavailable";
    const retrievedIds = new Set<string>();

    const ctx = buildBiasContext({ status: "unavailable" }, this.catalog.getAll());
    const system = this.prompts.render("assessment", { candidateBiases: ctx.biasContext });
    const user = `STORY: ${story}`;

    return (await this.callProvider(
      sessionId, system, user, requestId, runId,
      "initial_assessment", "story_only", inputHash, promptVersion, providerId,
      story, [], ragCase, retrievedIds,
    )).output;
  }

  /**
   * Run a full assessment with story + questions + answers.
   * Creates a run with stage=post_questions_assessment, scope=story_plus_answers.
   */
  async runFullAssessment(
    sessionId: string,
    story: string,
    questions: string[],
    answers: string[],
    requestId: string
  ): Promise<{ output: AssessmentOutput; runId: string; ragCase: RagCase; ragList: string[]; llmListRaw: string[] }> {
    const promptVersion = this.prompts.getVersion();
    const providerId = this.provider.mode;
    const inputHash = computeInputHash(
      promptVersion,
      this.modelName,
      story,
      answers
    );

    // Create run record — best-effort, non-blocking
    let runId = "";
    try {
      const run = await this.runStore.createRun(sessionId, {
        provider: providerId,
        modelName: this.modelName,
        stage: "post_questions_assessment",
        scope: "story_plus_answers",
        promptVersion,
        inputHash,
      });
      runId = run?.id ?? "";
    } catch (err) {
      logger.warn(
        { module: MODULE, operation: "runFullAssessment", error: err, requestId },
        "Failed to create run record — continuing without persistence"
      );
    }

    // Reconstruct RAG workspace from the stored story-only result. RAG fires
    // asynchronously at story submission (Stage 005) — if it hasn't landed by the
    // time the user finishes answering questions, we proceed without it. No wait.
    let ragCase: RagCase = "unavailable";
    let retrievedIds = new Set<string>();
    let ragList: string[] = [];
    let candidateBiases: string;

    if (sessionId && this.ragClient) {
      const stored = await this.runStore.getRagResultForSession(sessionId).catch(() => null);

      // stored is raw EngineResponse (or null) serialised to JSONB — validate shape before trusting
      const ragResult = isEngineResponse(stored)
        ? { status: "ok" as const, data: stored }
        : { status: "unavailable" as const };

      const workspace = buildBiasWorkspace(ragResult, this.catalog.getAll());
      ragCase = workspace.workspaceCase;
      retrievedIds = workspace.retrievedIds;
      ragList = workspace.candidates.map((c) => c.name);
      candidateBiases = renderWorkspaceToPrompt(workspace, this.catalog.getAll());

      // Stage 005 telemetry: was RAG done in time for the full assessment, with no
      // wait budget at all? Validates/refutes the miss-rate assumption in D015 now
      // that the adaptive wait has been removed.
      logger.info(
        { module: MODULE, operation: "runFullAssessment", sessionId, runId, rag_available: workspace.workspaceCase === "retrieved" },
        "rag_availability_at_assessment"
      );
    } else {
      // generate() backward-compat path: no sessionId, no RAG
      candidateBiases = this.catalog
        .getAll()
        .map((b) => `- ${b.name}: ${b.definition}`)
        .join("\n");
    }

    const system = this.prompts.render("assessment", { candidateBiases });
    const qaPairs = questions
      .map((q, i) => `Q: ${q}\nA: ${answers[i]}`)
      .join("\n\n");
    const user = questions.length
      ? `STORY: ${story}\n\nCONVERSATION:\n${qaPairs}`
      : `STORY: ${story}`;

    const { output, llmListRaw } = await this.callProvider(
      sessionId, system, user, requestId, runId,
      "post_questions_assessment", "story_plus_answers", inputHash, promptVersion, providerId,
      story, answers, ragCase, retrievedIds,
    );
    return { output, runId, ragCase, ragList, llmListRaw };
  }

  /**
   * Shared provider call + parsing + validation + persistence logic.
   */
  private async callProvider(
    sessionId: string,
    system: string,
    user: string,
    requestId: string,
    runId: string,
    stage: "initial_assessment" | "post_questions_assessment",
    scope: "story_only" | "story_plus_answers",
    _inputHash: string,
    promptVersion: string,
    providerId: string,
    story: string,
    answers: string[],
    ragCase: RagCase = "unavailable",
    retrievedIds: Set<string> = new Set(),
  ): Promise<{ output: AssessmentOutput; llmListRaw: string[] }> {
    return await withRetry(async (attempt) => {
      logger.info(
        { module: MODULE, operation: "callProvider", requestId, attempt, stage, scope, rag_context: ragCase },
        "Calling AI provider for assessment"
      );

      const llmStage = "assessment";
      const t0 = Date.now();

      const { result: raw, llmCallId: primaryLlmCallId } = await executeAndRecordLlmCall(
        () => this.provider.completeJson<unknown>({ system, user }),
        {
          sessionId,
          stage: llmStage,
          callType: "primary",
          provider: providerId,
          model: this.modelName,
          promptVersion,
        },
        this.llmCallStore
      );

      logger.info(
        { module: MODULE, operation: "callProvider", requestId, attempt, stage, scope, durationMs: Date.now() - t0 },
        "AI provider returned assessment response"
      );

      // Use the full repair pipeline
      let parsed: AssessmentOutput;
      let fallbackLlmCallId: string | null = null;
      try {
        const { result, metadata } = await repairWithFallback<AssessmentOutput, string | null>(
          JSON.stringify(raw),
          AssessmentOutputSchema,
          async () => {
            logger.warn(
              { module: MODULE, operation: "callProvider", requestId },
              "Attempting fallback model call for assessment generation"
            );
            const { result, llmCallId } = await executeAndRecordLlmCall(
              () => this.provider.completeJson<AssessmentOutput>({ system, user }),
              {
                sessionId,
                stage: llmStage,
                callType: "fallback",
                provider: providerId,
                model: this.modelName,
                promptVersion,
              },
              this.llmCallStore
            );
            return { result, metadata: llmCallId };
          }
        );
        parsed = result;
        fallbackLlmCallId = metadata;
      } catch (repairError) {
        // Determine failure type based on error message
        const errorMsg = (repairError as Error).message ?? String(repairError);
        const failureType = errorMsg.toLowerCase().includes("parse") || errorMsg.toLowerCase().includes("json")
          ? "parse_error"
          : "schema_validation";

        // Update primary call record with failure
        if (primaryLlmCallId) {
          try {
            await this.llmCallStore.updateFailure(primaryLlmCallId, failureType, errorMsg);
          } catch (err) {
            logger.warn(
              { module: MODULE, operation: "updateLlmCallFailure", llmCallId: primaryLlmCallId, error: err },
              "Failed to update primary LLM call failure"
            );
          }
        }
        throw repairError;
      }

      // Update primary call with parsed output (after successful repair/parsing)
      if (primaryLlmCallId) {
        try {
          await this.llmCallStore.updateParsedOutput(primaryLlmCallId, parsed);
        } catch (err) {
          logger.warn(
            { module: MODULE, operation: "updateLlmCallParsedOutput", llmCallId: primaryLlmCallId, error: err },
            "Failed to update primary LLM call parsed output"
          );
        }
      }

      // Update fallback call with parsed output (if fallback was used)
      if (fallbackLlmCallId) {
        try {
          await this.llmCallStore.updateParsedOutput(fallbackLlmCallId, parsed);
        } catch (err) {
          logger.warn(
            { module: MODULE, operation: "updateLlmCallParsedOutput", llmCallId: fallbackLlmCallId, error: err },
            "Failed to update fallback LLM call parsed output"
          );
        }
      }

      // T204: Stamp promptVersion on trace (LLM doesn't generate it)
      if (parsed.reasoningTrace) {
        parsed.reasoningTrace.prompt_version = promptVersion as PromptVersion;
      } else {
        logger.warn(
          { module: MODULE, operation: "callProvider", requestId },
          "No reasoning trace in LLM response — persisting stub"
        );
      }

      try {
        await this.traceStore.persistTrace(runId, parsed.reasoningTrace ?? {
          story_analysis: { themes: [], emotional_tone: "", key_events: [] },
          interpretations: [],
          bias_hypotheses: [],
          evidence_mapping: [],
          prompt_version: promptVersion as PromptVersion,
        });
        logger.info(
          { module: MODULE, operation: "callProvider", runId, requestId },
          "Reasoning trace persisted"
        );
      } catch (persistErr) {
        logger.error(
          { module: MODULE, operation: "callProvider", runId, requestId, error: persistErr },
          "Failed to persist reasoning trace — continuing"
        );
      }

      // T205: Enforce noBiasDetected flag consistency. Check == null (not === undefined) —
      // repair.ts's partialParseObject sets any field missing after a failed strict parse
      // to null, not undefined, so a strict-undefined check silently misses that path.
      if (parsed.biases.length === 0 && !parsed.noBiasDetected) {
        parsed.noBiasDetected = true;
      } else if (parsed.biases.length > 0 && parsed.noBiasDetected == null) {
        parsed.noBiasDetected = false;
      }

      // Capture raw LLM bias names before normalization for comparison recording
      const llmListRaw = parsed.biases.map(b => b.name);

      // Normalize bias names against catalog
      const allBiases = this.catalog.getAll();
      const normalizedBiases = parsed.biases.map((bias) => {
        const result = normalizeBiasName(bias.name, allBiases);
        // Engine BiasResult.id and local BiasEntry.id must share the same string format
        // (e.g. "confirmation_bias") — see ADR D014. Divergence silently returns "llm" for all.
        // "both" is in the schema enum but is never emitted here — it requires persisting
        // the story_only LLM candidate list to DB (deferred to a follow-on spec); without
        // that persistence there is no LLM-side list to merge retrievedIds against.
        const contextSource: "retrieved" | "llm" = retrievedIds.has(result.id ?? "") ? "retrieved" : "llm";
        return {
          ...bias,
          name: result.name,
          ...(result.id ? { biasCatalogId: result.id } : {}),
          context_source: contextSource,
        };
      });

      // T206: Wire evidence validation (T301)
      const validation = validateEvidence(
        { biases: normalizedBiases },
        {
          story,
          answers: scope === "story_plus_answers" ? answers : [],
        },
      );
      if (!validation.valid) {
        logger.warn(
          { module: MODULE, operation: "callProvider", requestId, violations: validation.violations },
          `Evidence validation failed — ${validation.violations.length} violation(s)`,
        );
      }

      // Stamp version, model, stage, scope fields
      const output: AssessmentOutput = {
        ...parsed,
        biases: normalizedBiases,
        prompt_version: promptVersion,
        schema_version: SCHEMA_VERSION,
        modelName: this.modelName,
        inputContext: scope === "story_only" ? "story-only" : "full",
      };
      return { output, llmListRaw };
    });
  }
}
