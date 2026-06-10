/**
 * Shared evaluation runner for reflection orchestrators.
 *
 * Loads golden + no_bias datasets, runs them through QuestionService +
 * AssessmentService, computes evaluation_metrics and system_metrics.
 *
 * ── Provider contract ─────────────────────────────────────────────────
 *   This module RECEIVES a Provider, never instantiates one.
 *   Caller (CLI or Inngest job) decides MockProvider vs GeminiProvider.
 *   Zero DB imports — determinism hashes are computed and returned,
 *   but DB persistence / hash checking belongs to the caller.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PromptRegistry } from "../prompts/registry";
import { QuestionService } from "../orchestrators/reflection/question.service";
import { AssessmentService } from "../orchestrators/reflection/assessment.service";
import { BiasCatalogService } from "../catalog/bias-catalog";
import {
  computeEvaluationMetrics,
  type EvaluationMetrics,
} from "./compute-evaluation-metrics";
import {
  computeSystemMetrics,
  type LLMResponse,
  type SystemMetrics,
} from "./compute-system-metrics";
import { computeInputHash } from "../lib/hash";
import type { Provider } from "../providers/types";

// ─── Types ──────────────────────────────────────────────────────────────

export interface StoryBase {
  id: string;
  title: string;
  story: string;
  tags: string[];
}

export interface GoldenStory extends StoryBase {
  expectedMinBiases: number;
  expectedQuestionsCountRange: [number, number];
}

export interface NoBiasStory extends StoryBase {
  isNoBias: true;
  confidenceThreshold: number;
  notes: string;
}

export interface StoryResult {
  id: string;
  title: string;
  dataset: "golden" | "no_bias";
  parseSuccess: boolean;
  questionCount: number;
  biasCount: number;
  evaluationMetrics: EvaluationMetrics | null;
  inputHash: string;
  failed: boolean;
  failureReasons: string[];
  errors: string[];
}

export interface EvalRunResult {
  goldenResults: StoryResult[];
  noBiasResults: StoryResult[];
  sysMetrics: SystemMetrics;
  overallPassed: boolean;
  exitCode: number;
}

// ─── Data loading ───────────────────────────────────────────────────────

export function loadStories<T>(dir: string): T[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  return files.map((file) => {
    const raw = readFileSync(join(dir, file), "utf-8");
    return JSON.parse(raw) as T;
  });
}

// ─── Golden story eval ──────────────────────────────────────────────────

async function evaluateGoldenStory(
  story: GoldenStory,
  questionService: QuestionService,
  assessmentService: AssessmentService,
  prompts: PromptRegistry,
): Promise<StoryResult & { llmResponse: LLMResponse }> {
  const result: StoryResult = {
    id: story.id,
    title: story.title,
    dataset: "golden",
    parseSuccess: false,
    questionCount: 0,
    biasCount: 0,
    evaluationMetrics: null,
    inputHash: "",
    failed: false,
    failureReasons: [],
    errors: [],
  };

  const llmResponse: LLMResponse = { requiredRepair: false };

  try {
    const questionsOutput = await questionService.generate(story.story, `eval-${story.id}`);
    result.questionCount = questionsOutput.questions.length;

    const answers = questionsOutput.questions.map((_, i) => `Answer ${i + 1} to "${questionsOutput.questions[i]}"`);
    const assessmentOutput = await assessmentService.generate(
      story.story,
      questionsOutput.questions,
      answers,
      `eval-${story.id}`,
    );
    result.biasCount = assessmentOutput.biases.length;
    result.parseSuccess = true;

    const metrics = computeEvaluationMetrics(
      { biases: assessmentOutput.biases.map((b) => ({ name: b.name, evidence: b.evidence ?? [], confidence: undefined })) },
      { story: story.story, answers },
      { isNoBiasStory: false },
    );
    result.evaluationMetrics = metrics;

    const promptVersion = prompts.getVersion();
    result.inputHash = computeInputHash(promptVersion, "eval-model", story.story, answers);
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    result.failed = true;
    result.failureReasons.push(`Exception: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { ...result, llmResponse };
}

// ─── No-bias story eval ─────────────────────────────────────────────────

async function evaluateNoBiasStory(
  story: NoBiasStory,
  assessmentService: AssessmentService,
  prompts: PromptRegistry,
): Promise<StoryResult & { llmResponse: LLMResponse }> {
  const result: StoryResult = {
    id: story.id,
    title: story.title,
    dataset: "no_bias",
    parseSuccess: false,
    questionCount: 0,
    biasCount: 0,
    evaluationMetrics: null,
    inputHash: "",
    failed: false,
    failureReasons: [],
    errors: [],
  };

  const llmResponse: LLMResponse = { requiredRepair: false };

  try {
    const answers: string[] = [];
    const assessmentOutput = await assessmentService.generate(
      story.story,
      [],
      [],
      `eval-${story.id}`,
    );
    result.biasCount = assessmentOutput.biases.length;
    result.parseSuccess = true;

    const metrics = computeEvaluationMetrics(
      { biases: assessmentOutput.biases.map((b) => ({ name: b.name, evidence: b.evidence ?? [], confidence: (b as any).confidence })) },
      { story: story.story, answers },
      { isNoBiasStory: true, confidenceThreshold: story.confidenceThreshold },
    );
    result.evaluationMetrics = metrics;

    if (metrics.isFalsePositive === true) {
      const threshold = story.confidenceThreshold;
      assessmentOutput.biases.forEach((bias: any) => {
        if ((bias.confidence ?? 1) > threshold) {
          result.failed = true;
          result.failureReasons.push(`${bias.name} — confidence ${(bias.confidence ?? 1).toFixed(2)} > ${threshold}`);
        }
      });
    }

    const promptVersion = prompts.getVersion();
    result.inputHash = computeInputHash(promptVersion, "eval-model", story.story, answers);
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    result.failed = true;
    result.failureReasons.push(`Exception: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { ...result, llmResponse };
}

// ─── Main runner ────────────────────────────────────────────────────────

export async function runEval(
  provider: Provider,
  modelName: string,
  storyText?: string,
  mode?: "golden" | "no_bias",
): Promise<EvalRunResult> {
  const prompts = new PromptRegistry();
  const catalog = new BiasCatalogService();
  const questionService = new QuestionService(provider, prompts, modelName);
  const assessmentService = new AssessmentService(provider, prompts, catalog, modelName);

  const goldenResults: StoryResult[] = [];
  const noBiasResults: StoryResult[] = [];
  const allLLMResponses: LLMResponse[] = [];

  if (storyText && mode === "no_bias") {
    // Single no_bias story — assessment only, no questions
    const story: NoBiasStory = {
      id: "custom",
      title: "Custom Story",
      story: storyText,
      tags: [],
      isNoBias: true,
      confidenceThreshold: 0.5,
      notes: "",
    };
    const { llmResponse, ...res } = await evaluateNoBiasStory(story, assessmentService, prompts);
    allLLMResponses.push(llmResponse);
    noBiasResults.push(res);
  } else if (storyText) {
    // Single golden story — questions + assessment
    const story: GoldenStory = {
      id: "custom",
      title: "Custom Story",
      story: storyText,
      tags: [],
      expectedMinBiases: 0,
      expectedQuestionsCountRange: [0, 10],
    };
    const { llmResponse, ...res } = await evaluateGoldenStory(story, questionService, assessmentService, prompts);
    allLLMResponses.push(llmResponse);
    goldenResults.push(res);
  } else {
    // Resolve evaluations directory — works both locally and in Vercel serverless
    const currentDir = dirname(fileURLToPath(import.meta.url));
    // In Vercel: api/index.js → api/evaluations/
    // Locally: src/evaluation/run-eval.ts → evaluations/
    const vercelEvalDir = join(currentDir, "evaluations");
    const localEvalDir = join(currentDir, "..", "..", "evaluations");
    const evalRoot = existsSync(vercelEvalDir) ? vercelEvalDir : localEvalDir;

    const GOLDEN_DIR = join(evalRoot, "golden", "reflection");
    const NO_BIAS_DIR = join(evalRoot, "no_bias", "reflection");

    const goldenStories = loadStories<GoldenStory>(GOLDEN_DIR);
    const noBiasStories = loadStories<NoBiasStory>(NO_BIAS_DIR);

    // Evaluate golden stories
    for (const story of goldenStories) {
      const { llmResponse, ...res } = await evaluateGoldenStory(story, questionService, assessmentService, prompts);
      allLLMResponses.push(llmResponse);
      goldenResults.push(res);
    }

    // Evaluate no_bias stories
    for (const story of noBiasStories) {
      const { llmResponse, ...res } = await evaluateNoBiasStory(story, assessmentService, prompts);
      allLLMResponses.push(llmResponse);
      noBiasResults.push(res);
    }
  }

  const sysMetrics = computeSystemMetrics(allLLMResponses);

  // Pass/fail uses default thresholds — caller can override
  const thresholds = {
    minEvidenceGrounded: 0.9,
    maxFalsePositive: 0.1,
    minSchemaParse: 0.95,
    maxRepairRate: 0.05,
  };

  let overallPassed = true;
  const groundedRates = [...goldenResults, ...noBiasResults]
    .filter((r) => r.errors.length === 0)
    .map((r) => r.evaluationMetrics?.evidenceGroundedRate)
    .filter((v): v is number => v !== null && v !== undefined);
  const evidenceGroundedRate = groundedRates.length > 0
    ? groundedRates.reduce((a, b) => a + b, 0) / groundedRates.length
    : null;
  if (evidenceGroundedRate !== null && evidenceGroundedRate < thresholds.minEvidenceGrounded) overallPassed = false;

  const fpCount = noBiasResults.filter((r) => r.evaluationMetrics?.isFalsePositive === true).length;
  const fpRate = noBiasResults.length > 0 ? fpCount / noBiasResults.length : null;
  if (fpRate !== null && fpRate > thresholds.maxFalsePositive) overallPassed = false;

  if (sysMetrics.schemaParseRate !== null && sysMetrics.schemaParseRate < thresholds.minSchemaParse) overallPassed = false;
  if (sysMetrics.repairRate !== null && sysMetrics.repairRate > thresholds.maxRepairRate) overallPassed = false;

  return {
    goldenResults,
    noBiasResults,
    sysMetrics,
    overallPassed,
    exitCode: overallPassed ? 0 : 1,
  };
}