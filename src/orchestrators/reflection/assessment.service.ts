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
    return this.runFullAssessment("", story, questions, answers, requestId);
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

    // Retrieve RAG context if client is configured
    let ragCase: RagCase = "unavailable";
    let retrievedIds = new Set<string>();
    let ragList: string[] = [];

    if (this.ragClient) {
      const ragResult = await this.ragClient.retrieve(story);

      // Store raw EngineResponse (or null) fire-and-forget — bridge for runFullAssessment
      if (runId) {
        this.runStore.storeRagResult(runId, ragResult.status === "ok" ? ragResult.data : null).catch(() => {/* already logged in storeRagResult */});
      }

      const ctx = buildBiasContext(ragResult, this.catalog.getAll());
      ragCase = ctx.ragCase;
      retrievedIds = ctx.retrievedIds;
      ragList = ragCase === "retrieved" && ragResult.status === "ok"
        ? ragResult.data.biases.filter(b => b.retrieval_score > 0).map(b => b.name)
        : [];

      const system = this.prompts.render("assessment", { biasContext: ctx.biasContext });
      const user = `STORY: ${story}`;

      return this.callProvider(
        sessionId, system, user, requestId, runId,
        "initial_assessment", "story_only", inputHash, promptVersion, providerId,
        story, [], ragCase, retrievedIds, ragList,
      );
    }

    // No RAG client — roster-only path (backward compat)
    const biasContext = this.catalog
      .getAll()
      .map((b) => `- ${b.name}: ${b.definition}`)
      .join("\n");

    const system = this.prompts.render("assessment", { biasContext });
    const user = `STORY: ${story}`;

    return this.callProvider(
      sessionId, system, user, requestId, runId,
      "initial_assessment", "story_only", inputHash, promptVersion, providerId,
      story, [], ragCase, retrievedIds, ragList,
    );
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
  ): Promise<AssessmentOutput> {
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

    // Reconstruct RAG context from the stored story-only result
    let ragCase: RagCase = "unavailable";
    let retrievedIds = new Set<string>();
    let ragList: string[] = [];
    let biasContext: string;

    if (sessionId && this.ragClient) {
      const stored = await this.runStore.getRagResultForSession(sessionId).catch(() => null);
      // stored is raw EngineResponse (or null) serialised to JSONB — validate shape before trusting
      const ragResult = isEngineResponse(stored)
        ? { status: "ok" as const, data: stored }
        : { status: "unavailable" as const };

      const ctx = buildBiasContext(ragResult, this.catalog.getAll());
      ragCase = ctx.ragCase;
      retrievedIds = ctx.retrievedIds;
      ragList = ragCase === "retrieved" && ragResult.status === "ok"
        ? ragResult.data.biases.filter(b => b.retrieval_score > 0).map(b => b.name)
        : [];
      biasContext = ctx.biasContext;
    } else {
      // generate() backward-compat path: no sessionId, no RAG
      biasContext = this.catalog
        .getAll()
        .map((b) => `- ${b.name}: ${b.definition}`)
        .join("\n");
    }

    const system = this.prompts.render("assessment", { biasContext });
    const qaPairs = questions
      .map((q, i) => `Q: ${q}\nA: ${answers[i]}`)
      .join("\n\n");
    const user = questions.length
      ? `STORY: ${story}\n\nCONVERSATION:\n${qaPairs}`
      : `STORY: ${story}`;

    return this.callProvider(
      sessionId, system, user, requestId, runId,
      "post_questions_assessment", "story_plus_answers", inputHash, promptVersion, providerId,
      story, answers, ragCase, retrievedIds, ragList,
    );
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
    _ragList: string[] = [],
  ): Promise<AssessmentOutput> {
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

      // T205: Enforce noBiasDetected flag consistency
      if (parsed.biases.length === 0 && !parsed.noBiasDetected) {
        parsed.noBiasDetected = true;
      } else if (parsed.biases.length > 0 && parsed.noBiasDetected === undefined) {
        parsed.noBiasDetected = false;
      }

      // Normalize bias names against catalog
      const allBiases = this.catalog.getAll();
      const normalizedBiases = parsed.biases.map((bias) => {
        const result = normalizeBiasName(bias.name, allBiases);
        // Engine BiasResult.id and local BiasEntry.id must share the same string format
        // (e.g. "confirmation_bias") — see ADR D014. Divergence silently returns "roster" for all.
        const contextSource: "retrieved" | "roster" = ragCase === "retrieved"
          ? (retrievedIds.has(result.id ?? "") ? "retrieved" : "roster")
          : "roster";
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
      return {
        ...parsed,
        biases: normalizedBiases,
        prompt_version: promptVersion,
        schema_version: SCHEMA_VERSION,
        modelName: this.modelName,
        inputContext: scope === "story_only" ? "story-only" : "full",
      };
    });
  }
}
