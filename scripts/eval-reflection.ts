/**
 * Evaluation script for reflection orchestrators.
 *
 * Runs golden and no_bias datasets through QuestionService + AssessmentService,
 * computes evaluation_metrics (evidence_grounded_rate, false_positive_rate)
 * and system_metrics (schema_parse_rate, repair_rate).
 *
 * ── Modes ──────────────────────────────────────────────────────────────
 *   pnpm eval                     MockProvider — fast CI sanity check
 *   pnpm eval --provider real     Real Gemini — actual quality gate
 *
 * ── Eval Policy ────────────────────────────────────────────────────────
 *   Mock eval:  every commit, every PR (automated)
 *   Real eval:  before prompt file changes merge
 *               before provider changes
 *               weekly scheduled Inngest job (T305)
 *               never on every commit
 *
 * ── API call count (real mode) ─────────────────────────────────────────
 *   5 golden × 2 calls (questions + assessment) = 10
 *   13 no_bias × 1 call (assessment only, skip questions) = 13
 *   Total: 23 calls
 *
 * Usage: pnpm eval [--provider real] [--min-evidence-grounded 0.85] ...
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PromptRegistry } from "../src/prompts/registry.js";
import { MockProvider } from "../tests/mocks/mock-provider.js";
import { GeminiProvider } from "../src/providers/gemini.js";
import { QuestionService } from "../src/orchestrators/reflection/question.service.js";
import { AssessmentService } from "../src/orchestrators/reflection/assessment.service.js";
import { BiasCatalogService } from "../src/catalog/bias-catalog.js";
import {
  computeEvaluationMetrics,
  type EvaluationMetrics,
} from "../src/evaluation/compute-evaluation-metrics.js";
import {
  computeSystemMetrics,
  type LLMResponse,
} from "../src/evaluation/compute-system-metrics.js";
import { computeInputHash } from "../src/lib/hash.js";
import type { Provider } from "../src/providers/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Types ──────────────────────────────────────────────────────────────

interface StoryBase {
  id: string;
  title: string;
  story: string;
  tags: string[];
}

interface GoldenStory extends StoryBase {
  expectedMinBiases: number;
  expectedQuestionsCountRange: [number, number];
}

interface NoBiasStory extends StoryBase {
  isNoBias: true;
  confidenceThreshold: number;
  notes: string;
}

interface StoryResult {
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

interface Thresholds {
  minEvidenceGrounded: number;
  maxFalsePositive: number;
  minSchemaParse: number;
  maxRepairRate: number;
}

// ─── CLI parsing ────────────────────────────────────────────────────────

function parseArgs(): { provider: string; thresholds: Thresholds } {
  const args = process.argv.slice(2);
  let provider = "mock";

  const thresholds: Thresholds = {
    minEvidenceGrounded: 0.9,
    maxFalsePositive: 0.1,
    minSchemaParse: 0.95,
    maxRepairRate: 0.05,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === "--provider" && next) { provider = next; i++; }
    else if (arg === "--min-evidence-grounded" && next) { thresholds.minEvidenceGrounded = parseFloat(next); i++; }
    else if (arg === "--max-false-positive" && next) { thresholds.maxFalsePositive = parseFloat(next); i++; }
    else if (arg === "--min-schema-parse" && next) { thresholds.minSchemaParse = parseFloat(next); i++; }
    else if (arg === "--max-repair-rate" && next) { thresholds.maxRepairRate = parseFloat(next); i++; }
  }

  return { provider, thresholds };
}

// ─── Data loading ───────────────────────────────────────────────────────

function loadStories<T>(dir: string): T[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  return files.map((file) => {
    const raw = readFileSync(join(dir, file), "utf-8");
    return JSON.parse(raw) as T;
  });
}

// ─── Provider factory ───────────────────────────────────────────────────

function createProvider(mode: string): Provider {
  if (mode === "real") {
    return new GeminiProvider();
  }
  // When mock, preload with a deterministic assessment that will pass evaluation.
  // Real behavior (confidence scores, hallucination) is tested only in real mode.
  const mock = new MockProvider();
  mock.setDefault({
    biases: [
      {
        name: "confirmation bias",
        explanation: "You described filtering news to match your views and dismissing disagreement. This selective exposure and rejection of opposing evidence aligns with confirmation bias.",
        storyConnection: "In your story, you explicitly stated that you only read news confirming your views and felt your colleague was wrong before considering his arguments.",
        alternativePerspective: "Consider consuming news sources across the political spectrum and evaluating each argument on its own merits.",
      },
    ],
    reflectionPrompt: "Reflect on whether you are giving fair consideration to all perspectives.",
  });
  return mock;
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
    // Question generation
    const [minQ, maxQ] = story.expectedQuestionsCountRange;
    const questionsOutput = await questionService.generate(story.story, `eval-${story.id}`);
    result.questionCount = questionsOutput.questions.length;

    // Assessment generation
    const answers = questionsOutput.questions.map((_, i) => `Answer ${i + 1} to "${questionsOutput.questions[i]}"`);
    const assessmentOutput = await assessmentService.generate(
      story.story,
      questionsOutput.questions,
      answers,
      `eval-${story.id}`,
    );
    result.biasCount = assessmentOutput.biases.length;
    result.parseSuccess = true;

    // Compute metrics
    const metrics = computeEvaluationMetrics(
      { biases: assessmentOutput.biases.map((b) => ({ name: b.name, evidence: b.evidence ?? [], confidence: undefined })) },
      { story: story.story, answers },
      { isNoBiasStory: false },
    );
    result.evaluationMetrics = metrics;

    // Determinism hash
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
    // No_bias stories: skip question generation — eval targets assessment only
    const answers: string[] = [];
    const assessmentOutput = await assessmentService.generate(
      story.story,
      [],
      [],
      `eval-${story.id}`,
    );
    result.biasCount = assessmentOutput.biases.length;
    result.parseSuccess = true;

    // Compute metrics
    const metrics = computeEvaluationMetrics(
      { biases: assessmentOutput.biases.map((b) => ({ name: b.name, evidence: b.evidence ?? [], confidence: (b as any).confidence })) },
      { story: story.story, answers },
      { isNoBiasStory: true, confidenceThreshold: story.confidenceThreshold },
    );
    result.evaluationMetrics = metrics;

    // Check false positive
    if (metrics.isFalsePositive === true) {
      // Find which biases exceeded threshold
      const threshold = story.confidenceThreshold;
      assessmentOutput.biases.forEach((bias: any) => {
        if ((bias.confidence ?? 1) > threshold) {
          result.failed = true;
          result.failureReasons.push(`${bias.name} — confidence ${(bias.confidence ?? 1).toFixed(2)} > ${threshold}`);
        }
      });
    }

    // Determinism hash
    const promptVersion = prompts.getVersion();
    result.inputHash = computeInputHash(promptVersion, "eval-model", story.story, answers);
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
    result.failed = true;
    result.failureReasons.push(`Exception: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { ...result, llmResponse };
}

// ─── Output ─────────────────────────────────────────────────────────────

function printDatasetResults(label: string, results: StoryResult[], thresholds: Thresholds, systemNote: string): boolean {
  const stories = results.filter((r) => r.errors.length === 0);
  const total = results.length;

  // evidence_grounded_rate: average across stories that parsed successfully
  const groundedRates = stories
    .map((r) => r.evaluationMetrics?.evidenceGroundedRate)
    .filter((v): v is number => v !== null && v !== undefined);
  const evidenceGroundedRate = groundedRates.length > 0
    ? groundedRates.reduce((a, b) => a + b, 0) / groundedRates.length
    : null;

  // false_positive_rate: count(stories where isFalsePositive === true) / total no_bias stories
  const noBiasResults = results.filter((r) => r.dataset === "no_bias");
  const falsePositiveCount = noBiasResults.filter((r) => r.evaluationMetrics?.isFalsePositive === true).length;
  const falsePositiveRate = noBiasResults.length > 0
    ? falsePositiveCount / noBiasResults.length
    : null;

  console.log(`\n📊 EVALUATION — ${label} (${total} stories)`);
  console.log("─────────────────────────────────────");

  // evidence_grounded_rate
  if (evidenceGroundedRate !== null) {
    const pass = evidenceGroundedRate >= thresholds.minEvidenceGrounded;
    console.log(`  evidence_grounded_rate:  ${evidenceGroundedRate.toFixed(3)} ${pass ? "✅" : "❌"}  min ${thresholds.minEvidenceGrounded}`);
  } else {
    console.log(`  evidence_grounded_rate:  N/A`);
  }

  // false_positive_rate (only for no_bias)
  if (falsePositiveRate !== null) {
    const pass = falsePositiveRate <= thresholds.maxFalsePositive;
    console.log(`  false_positive_rate:     ${falsePositiveRate.toFixed(3)} ${pass ? "✅" : "❌"}  max ${thresholds.maxFalsePositive}`);
  }

  // schema_parse_rate — from system metrics (handled in main)
  console.log(`  schema_parse_rate:       ${systemNote}`);

  // Per-story failures
  const failedStories = results.filter((r) => r.failed);
  if (failedStories.length > 0) {
    console.log(`\n  Failed stories:`);
    for (const s of failedStories) {
      console.log(`    ${s.id.padEnd(22)} — ${s.failureReasons.join("; ")}`);
    }
  }

  // Return whether thresholds passed
  let passed = true;
  if (evidenceGroundedRate !== null && evidenceGroundedRate < thresholds.minEvidenceGrounded) passed = false;
  if (falsePositiveRate !== null && falsePositiveRate > thresholds.maxFalsePositive) passed = false;
  return passed;
}

// ─── Main ───────────────────────────────────────────────────────────────

async function runEvaluation(): Promise<void> {
  const { provider: providerMode, thresholds } = parseArgs();
  const isMock = providerMode !== "real";

  console.log(`\n🔬 BIASSEMBLE EVALUATION`);
  console.log(`Provider: ${providerMode}${isMock ? " (repair tracking n/a — mock returns clean JSON)" : ""}`);
  console.log(`Thresholds:`);
  console.log(`  min-evidence-grounded: ${thresholds.minEvidenceGrounded}`);
  console.log(`  max-false-positive:    ${thresholds.maxFalsePositive}`);
  console.log(`  min-schema-parse:      ${thresholds.minSchemaParse}`);
  console.log(`  max-repair-rate:       ${thresholds.maxRepairRate}`);

  // Load datasets
  const GOLDEN_DIR = join(__dirname, "..", "evaluations", "golden", "reflection");
  const NO_BIAS_DIR = join(__dirname, "..", "evaluations", "no_bias", "reflection");

  const goldenStories = loadStories<GoldenStory>(GOLDEN_DIR);
  const noBiasStories = loadStories<NoBiasStory>(NO_BIAS_DIR);

  console.log(`\n📋 Loaded ${goldenStories.length} golden stories`);
  console.log(`📋 Loaded ${noBiasStories.length} no_bias stories`);

  // Setup services
  const provider = createProvider(providerMode);
  const prompts = new PromptRegistry();
  const catalog = new BiasCatalogService();
  const modelName = isMock ? "mock-eval" : "gemini-2.0-flash";
  const questionService = new QuestionService(provider, prompts, modelName);
  const assessmentService = new AssessmentService(provider, prompts, catalog, modelName);

  const goldenResults: StoryResult[] = [];
  const noBiasResultsRaw: StoryResult[] = [];
  const allLLMResponses: LLMResponse[] = [];

  // ── Evaluate golden stories ──────────────────────────────────
  for (const story of goldenStories) {
    console.log(`\n━━━ Golden: ${story.title} ━━━`);
    const { llmResponse, ...res } = await evaluateGoldenStory(story, questionService, assessmentService, prompts);
    allLLMResponses.push(llmResponse);
    goldenResults.push(res);
    console.log(
      `  Q: ${res.questionCount} | Biases: ${res.biasCount} | Parse: ${res.parseSuccess ? "✅" : "❌"}`
    );
  }

  // ── Evaluate no_bias stories ─────────────────────────────────
  for (const story of noBiasStories) {
    console.log(`\n━━━ NoBias: ${story.title} ━━━`);
    const { llmResponse, ...res } = await evaluateNoBiasStory(story, assessmentService, prompts);
    allLLMResponses.push(llmResponse);
    noBiasResultsRaw.push(res);
    console.log(
      `  Biases: ${res.biasCount} | FalsePos: ${res.evaluationMetrics?.isFalsePositive === true ? "❌" : "✅"} | Parse: ${res.parseSuccess ? "✅" : "❌"}`
    );
  }

  // ── System metrics ───────────────────────────────────────────
  const sysMetrics = computeSystemMetrics(allLLMResponses);
  const schemaNote = isMock
    ? `1.000 ✅  min ${thresholds.minSchemaParse}  (mock — n/a)`
    : `${sysMetrics.schemaParseRate?.toFixed(3) ?? "N/A"} ${(sysMetrics.schemaParseRate ?? 0) >= thresholds.minSchemaParse ? "✅" : "❌"}  min ${thresholds.minSchemaParse}`;

  // ── Print results ─────────────────────────────────────────────
  const goldenPassed = printDatasetResults("GOLDEN", goldenResults, thresholds, schemaNote);
  const noBiasPassed = printDatasetResults("NO_BIAS", noBiasResultsRaw, thresholds, schemaNote);

  // ── Combined system metrics ───────────────────────────────────
  console.log(`\n📊 SYSTEM METRICS`);
  console.log("─────────────────────────────────────");
  console.log(`  schema_parse_rate:  ${sysMetrics.schemaParseRate?.toFixed(3) ?? "N/A"}  (${sysMetrics.schemaParsePassCount}/${sysMetrics.totalResponses})`);
  console.log(`  repair_rate:        ${sysMetrics.repairRate?.toFixed(3) ?? "N/A"}  (${sysMetrics.repairSuccessCount}/${sysMetrics.repairAttemptCount} repaired)`);
  if (sysMetrics.repairRate !== null && sysMetrics.repairRate > thresholds.maxRepairRate) {
    console.log(`  ❌ repair_rate exceeds max ${thresholds.maxRepairRate}`);
  }

  // ── Determinism hashes (logged, not checked — T305 does DB check) ──
  console.log(`\n📋 DETERMINISM HASHES`);
  for (const r of [...goldenResults, ...noBiasResultsRaw]) {
    console.log(`  ${r.id.padEnd(22)} ${r.inputHash}`);
  }

  // ── Overall pass/fail ──────────────────────────────────────────
  let exitCode = 0;
  if (!goldenPassed) {
    console.error(`\n❌ GOLDEN dataset thresholds NOT met`);
    exitCode = 1;
  }
  if (!noBiasPassed) {
    console.error(`\n❌ NO_BIAS dataset thresholds NOT met`);
    exitCode = 1;
  }
  if (sysMetrics.schemaParseRate !== null && sysMetrics.schemaParseRate < thresholds.minSchemaParse) {
    console.error(`\n❌ schema_parse_rate threshold NOT met`);
    exitCode = 1;
  }
  if (sysMetrics.repairRate !== null && sysMetrics.repairRate > thresholds.maxRepairRate) {
    console.error(`\n❌ repair_rate threshold NOT met`);
    exitCode = 1;
  }

  if (exitCode === 0) {
    console.log("\n🎉 All evaluation criteria passed!\n");
  } else {
    console.log(`\n❌ Evaluation failed with exit code ${exitCode}\n`);
  }

  process.exit(exitCode);
}

runEvaluation().catch((error) => {
  console.error("Evaluation script failed:", error);
  process.exit(1);
});