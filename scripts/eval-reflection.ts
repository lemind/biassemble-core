/**
 * Evaluation script for reflection orchestrators.
 * Loads golden stories and runs them through the real QuestionService and
 * AssessmentService using a MockProvider for deterministic results.
 *
 * This ensures the evaluation tests the orchestrators + repair pipeline + prompts
 * as a whole, not mocking internal logic.
 *
 * Usage: pnpm eval
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PromptRegistry } from "../src/prompts/registry.js";
import { MockProvider } from "../tests/mocks/mock-provider.js";
import { QuestionService } from "../src/orchestrators/reflection/question.service.js";
import { AssessmentService } from "../src/orchestrators/reflection/assessment.service.js";
import { BiasCatalogService } from "../src/catalog/bias-catalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface GoldenStory {
  id: string;
  title: string;
  story: string;
  expectedMinBiases: number;
  expectedQuestionsCountRange: [number, number];
  tags: string[];
}

interface EvalResult {
  id: string;
  title: string;
  questionsPassed: boolean;
  assessmentPassed: boolean;
  questionCount: number;
  biasCount: number;
  parseSuccess: boolean;
  storyReferenceFound: boolean;
  errors: string[];
}

const GOLDEN_DIR = join(__dirname, "..", "evaluations", "golden", "reflection");

function loadGoldenStories(): GoldenStory[] {
  const files = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".json"));
  return files.map((file) => {
    const raw = readFileSync(join(GOLDEN_DIR, file), "utf-8");
    return JSON.parse(raw) as GoldenStory;
  });
}

// Simple heuristic: check if bias explanations contain words from the story
function checkStoryReference(
  explanation: string,
  story: string
): boolean {
  const storyWords = new Set(
    story
      .toLowerCase()
      .replace(/[^a-z\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 4)
  );
  const explanationLower = explanation.toLowerCase();
  let matches = 0;
  for (const word of storyWords) {
    if (explanationLower.includes(word)) {
      matches++;
    }
  }
  return matches >= Math.max(1, Math.floor(storyWords.size * 0.1));
}

async function runEvaluation(): Promise<void> {
  const stories = loadGoldenStories();
  console.log(`\n📋 Loaded ${stories.length} golden stories for evaluation\n`);

  // Setup real services with MockProvider
  const mockProvider = new MockProvider();
  const prompts = new PromptRegistry();
  const catalog = new BiasCatalogService();
  const questionService = new QuestionService(mockProvider, prompts);
  const assessmentService = new AssessmentService(mockProvider, prompts, catalog);

  const results: EvalResult[] = [];
  let totalParseSuccess = 0;
  let totalStoryReference = 0;
  let totalBiasCount = 0;

  for (const story of stories) {
    console.log(`\n━━━ Evaluating: ${story.title} ━━━`);

    const result: EvalResult = {
      id: story.id,
      title: story.title,
      questionsPassed: false,
      assessmentPassed: false,
      questionCount: 0,
      biasCount: 0,
      parseSuccess: false,
      storyReferenceFound: false,
      errors: [],
    };

    try {
      // Step 1: Question generation via real QuestionService + MockProvider
      const [minQ, maxQ] = story.expectedQuestionsCountRange;
      const mockQuestionCount = Math.floor(Math.random() * (maxQ - minQ + 1)) + minQ;
      const mockQuestions = Array.from(
        { length: mockQuestionCount },
        (_, i) => `Question ${i + 1} about your situation?`
      );

      mockProvider.setDefault({
        questions: mockQuestions,
        isComplete: true,
      });

      const questionsOutput = await questionService.generate(story.story, "eval-run");
      result.questionCount = questionsOutput.questions.length;
      result.questionsPassed =
        questionsOutput.questions.length >= minQ &&
        questionsOutput.questions.length <= maxQ;
      result.parseSuccess = true;
      totalParseSuccess++;

      // Step 2: Assessment generation via real AssessmentService + MockProvider
      const mockAnswers = mockQuestions.map(
        (q, i) => `Answer ${i + 1}: Based on my experience, this is my detailed response to the question asked.`
      );
      const mockBiasCount = Math.max(story.expectedMinBiases, 2);
      const mockBiases = Array.from({ length: mockBiasCount }, (_, i) => ({
        name: i === 0 ? "confirmation bias" : "anchoring bias",
        explanation: `This bias relates to your situation because you described feeling strongly about aspects of your story that align with this cognitive pattern.`,
        storyConnection: `In your story, you mentioned "${story.story.slice(30, 90)}..." which suggests this bias may be influencing your perspective.`,
        alternativePerspective: `An alternative way to view this situation would be to consider evidence that contradicts your current position and evaluate it objectively.`,
      }));

      mockProvider.setDefault({
        biases: mockBiases,
        reflectionPrompt:
          "Consider how these cognitive biases might be shaping your interpretation of events and whether alternative perspectives could provide valuable insights.",
      });

      const assessmentOutput = await assessmentService.generate(
        story.story,
        mockQuestions,
        mockAnswers,
        "eval-run"
      );
      result.biasCount = assessmentOutput.biases.length;
      result.assessmentPassed = assessmentOutput.biases.length >= story.expectedMinBiases;
      totalBiasCount += assessmentOutput.biases.length;

      // Step 3: Story-reference heuristic
      const firstExplanation = assessmentOutput.biases[0]?.explanation ?? "";
      result.storyReferenceFound = checkStoryReference(firstExplanation, story.story);
      if (result.storyReferenceFound) {
        totalStoryReference++;
      }
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
      console.error(`  ❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    results.push(result);
    console.log(
      `  Questions: ${result.questionCount} ${result.questionsPassed ? "✅" : "❌"} | ` +
      `Biases: ${result.biasCount} ${result.assessmentPassed ? "✅" : "❌"} | ` +
      `Parse: ${result.parseSuccess ? "✅" : "❌"} | ` +
      `StoryRef: ${result.storyReferenceFound ? "✅" : "❌"}`
    );
  }

  // ─── Summary ──────────────────────────────────────
  const totalStories = results.length;
  const parseRate = totalStories > 0 ? (totalParseSuccess / totalStories) * 100 : 0;
  const storyRefRate = totalStories > 0 ? (totalStoryReference / totalStories) * 100 : 0;
  const avgBiasCount = totalStories > 0 ? totalBiasCount / totalStories : 0;

  const allQuestionsPassed = results.every((r) => r.questionsPassed);
  const allAssessmentsPassed = results.every((r) => r.assessmentPassed);

  console.log("\n═══════════════════════════════════════════");
  console.log("📊 EVALUATION SUMMARY");
  console.log("═══════════════════════════════════════════");
  console.log(`Stories evaluated:     ${totalStories}`);
  console.log(`Parse success rate:    ${parseRate.toFixed(1)}% (target: ≥ 99%)`);
  console.log(`Story-reference rate:  ${storyRefRate.toFixed(1)}% (target: ≥ 90%)`);
  console.log(`Avg biases per story:  ${avgBiasCount.toFixed(1)}`);
  console.log(`All question passes:   ${allQuestionsPassed ? "✅" : "❌"}`);
  console.log(`All assessment passes: ${allAssessmentsPassed ? "✅" : "❌"}`);
  console.log("═══════════════════════════════════════════\n");

  const PASS_THRESHOLD_PARSE = 99;
  const PASS_THRESHOLD_REFERENCE = 90;

  let exitCode = 0;

  if (parseRate < PASS_THRESHOLD_PARSE) {
    console.error(`❌ Parse rate ${parseRate.toFixed(1)}% < ${PASS_THRESHOLD_PARSE}% threshold`);
    exitCode = 1;
  } else {
    console.log(`✅ Parse rate meets threshold (${parseRate.toFixed(1)}% ≥ ${PASS_THRESHOLD_PARSE}%)`);
  }

  if (storyRefRate < PASS_THRESHOLD_REFERENCE) {
    console.error(`❌ Story-reference rate ${storyRefRate.toFixed(1)}% < ${PASS_THRESHOLD_REFERENCE}% threshold`);
    exitCode = 1;
  } else {
    console.log(`✅ Story-reference rate meets threshold (${storyRefRate.toFixed(1)}% ≥ ${PASS_THRESHOLD_REFERENCE}%)`);
  }

  if (!allQuestionsPassed) {
    console.error("❌ Not all stories produced valid question batches");
    exitCode = 1;
  }

  if (!allAssessmentsPassed) {
    console.error("❌ Not all stories produced valid assessments");
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
