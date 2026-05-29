/**
 * Build script: serializes Zod schemas into a portable JSON Schema file.
 *
 * Run: pnpm generate:contracts
 * Output: contracts/reflection.schemas.json
 *
 * Uses Zod v4's built-in toJSONSchema() method — no external dependency needed.
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GenerateQuestionRequestSchema,
  GenerateAssessmentRequestSchema,
  QuestionOutputSchema,
  AssessmentOutputSchema,
  BiasItemSchema,
} from "../src/contracts/reflection.schemas.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", "contracts", "reflection.schemas.json");

const schemas = {
  reflection: {
    GenerateQuestionRequest: GenerateQuestionRequestSchema.toJSONSchema(),
    GenerateAssessmentRequest: GenerateAssessmentRequestSchema.toJSONSchema(),
    QuestionOutput: QuestionOutputSchema.toJSONSchema(),
    AssessmentOutput: AssessmentOutputSchema.toJSONSchema(),
    BiasItem: BiasItemSchema.toJSONSchema(),
  },
};

writeFileSync(OUT, JSON.stringify(schemas, null, 2), "utf-8");
console.log(`✓ Contracts written to ${OUT}`);