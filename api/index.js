var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/server.ts
import Fastify from "fastify";
import { fastifyPlugin as inngestFastify } from "inngest/fastify";

// src/lib/env.ts
import { z } from "zod";
var envSchema = z.object({
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  GEMINI_MODEL: z.string().default("gemini-2.0-flash"),
  AI_CORE_API_KEY: z.string().min(1, "AI_CORE_API_KEY is required"),
  PORT: z.coerce.number().int().positive().default(3001),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(1e4),
  AI_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  INNGEST_SERVE_HOST: z.string().optional(),
  VERCEL_BYPASS_TOKEN: z.string().optional(),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info")
});
function loadEnv() {
  const parsed2 = envSchema.safeParse(process.env);
  if (!parsed2.success) {
    const msg = `[env] Invalid environment variables: ${JSON.stringify(parsed2.error.flatten().fieldErrors)}`;
    console.error(msg);
    throw new Error(msg);
  }
  return parsed2.data;
}
var env = loadEnv();

// src/lib/request-id.ts
import { randomUUID } from "node:crypto";
function generateRequestId() {
  return randomUUID();
}
async function requestIdHook(request, reply) {
  const id = request.headers["x-request-id"] || generateRequestId();
  request.id = id;
  reply.header("x-request-id", id);
}

// src/observability/logger.ts
import pino from "pino";
var isVercel = process.env.VERCEL === "1";
var logger = pino({
  level: env.LOG_LEVEL,
  ...isVercel ? {} : {
    transport: env.LOG_LEVEL === "info" || env.LOG_LEVEL === "debug" ? { target: "pino-pretty", options: { colorize: true } } : void 0
  },
  redact: ["GEMINI_API_KEY", "AI_CORE_API_KEY"]
});

// src/providers/gemini.ts
import { GoogleGenerativeAI } from "@google/generative-ai";
var DEFAULT_TEMPERATURE = 0.7;
var MODULE = "gemini-provider";
var RateLimitError = class extends Error {
  /** "daily" (quota) or "per-minute" (RPM) */
  limitType;
  /** ISO timestamp when the limit resets, if available */
  resetsAt;
  constructor(message, limitType, resetsAt) {
    super(message);
    this.name = "RateLimitError";
    this.limitType = limitType;
    this.resetsAt = resetsAt;
  }
};
var GeminiProvider = class {
  mode = "gemini";
  client;
  constructor() {
    this.client = new GoogleGenerativeAI(env.GEMINI_API_KEY);
  }
  async completeJson(request) {
    const timeoutMs = request.options?.timeoutMs ?? env.AI_TIMEOUT_MS;
    const model = this.client.getGenerativeModel(
      {
        model: env.GEMINI_MODEL,
        generationConfig: {
          temperature: request.options?.temperature ?? DEFAULT_TEMPERATURE,
          maxOutputTokens: request.options?.maxTokens,
          responseMimeType: "application/json"
        }
      },
      { timeout: timeoutMs }
    );
    const contents = [
      {
        role: "user",
        parts: [{ text: `SYSTEM: ${request.system}

USER: ${request.user}` }]
      }
    ];
    try {
      const result = await model.generateContent({ contents });
      const response = await result.response;
      const text2 = response.text();
      try {
        return JSON.parse(text2);
      } catch (parseError) {
        logger.error(
          { module: MODULE, operation: "completeJson", text: text2, parseError },
          "Failed to parse Gemini JSON output"
        );
        throw new Error("Malformed JSON from AI provider");
      }
    } catch (error) {
      const err = error;
      const status = err?.status;
      const message = err?.message ?? String(error);
      if (status === 429 || message.includes("429") || message.toLowerCase().includes("rate limit")) {
        const isDaily = message.toLowerCase().includes("quota") || message.toLowerCase().includes("daily");
        const resetsAt = extractResetTime(message);
        logger.warn(
          { module: MODULE, operation: "completeJson", status, limitType: isDaily ? "daily" : "per-minute", resetsAt },
          "Gemini rate limit hit \u2014 not retrying"
        );
        throw new RateLimitError(
          isDaily ? "Daily API quota exhausted. Please try again tomorrow." : "Too many requests. Please try again later.",
          isDaily ? "daily" : "per-minute",
          resetsAt
        );
      }
      logger.error(
        { module: MODULE, operation: "completeJson", error },
        "Gemini API call failed"
      );
      throw error;
    }
  }
};
function extractResetTime(message) {
  const match = message.match(/reset\s+in\s+(\d+)\s+seconds/i);
  if (match && match[1]) {
    const seconds = parseInt(match[1], 10);
    if (!isNaN(seconds)) {
      return new Date(Date.now() + seconds * 1e3).toISOString();
    }
  }
  return void 0;
}

// src/prompts/guardrails.md
var guardrails_default = '# Non-Clinical Guardrails\n\n1. **NO CLINICAL ADVICE**: Do not provide diagnoses, psychiatric advice, or therapeutic recommendations.\n2. **NO THERAPEUTIC CLAIMS**: Do not suggest that this tool or its output is a substitute for professional mental health services.\n3. **REFLECTIVE TONE**: Maintain a supportive, curious, and reflective tone. Use phrases like "It seems like...", "One way to look at this is...", or "Have you considered...?".\n4. **EMPOWER USER**: Focus on empowering the user to see alternative perspectives, not telling them what is "true" or "right".\n5. **SCOPE**: Stay strictly within the domain of cognitive biases and logical reflection.\n';

// src/prompts/reflection/question-batch/system.md
var system_default = 'You are a reflective AI guide specializing in cognitive bias awareness. \nYour goal is to help a user reflect on their personal situation by asking 2-5 probing, contextual follow-up questions.\n\n### GUIDELINES\n- Ask between 2 and 5 questions.\n- Each question must be distinct and contextual (reference details from the story).\n- Do not provide analysis or detect biases yet.\n- Stay curious and objective.\n\n{{guardrails}}\n\n### OUTPUT FORMAT\nYou must return valid JSON matching this schema:\n{\n  "questions": ["string", "string"],\n  "isComplete": true\n}\n';

// src/prompts/reflection/assessment/system.md
var system_default2 = 'You are a reflective AI guide specializing in cognitive bias awareness.\nThe user has provided a personal situation and answered follow-up questions.\n\nDo not reproduce large portions of the story. Use concise summaries when needed.\n\n### BIAS CATALOG\nAvailable biases and their definitions:\n{{biasShortlist}}\n\n### REASONING PROCESS\n\nFollow these steps before producing your assessment:\n\n**Step 1 \u2014 Story Analysis**\nIdentify the core themes, emotional tone, and key events from the user\'s story and answers.\n\n**Step 2 \u2014 Interpretations**\nGenerate 1\u20134 plausible interpretations of what might be happening. Each should offer a different lens on the situation. Assign a plausibility score (0.0\u20131.0) to each and include supporting evidence (quotes or references from the story/answers). Interpretations should be ordered from most plausible to least plausible.\n\n**Step 3 \u2014 Bias Hypotheses**\nFor the most plausible interpretations, identify which cognitive biases from the catalog might apply. Only use bias names from the provided catalog \u2014 do not invent new bias names. Assign a confidence score (0.0\u20131.0). List specific excerpts supporting each hypothesis. Include uncertainty reasons whenever meaningful uncertainty exists.\n\n**Step 4 \u2014 Evidence Mapping**\nFor each bias hypothesis, identify all relevant excerpts considered during reasoning. These excerpts form the `evidence_mapping` section. The evidence included in each final bias assessment should be drawn from the corresponding entries in `evidence_mapping`.\n\n### EVIDENCE RULES\n\n- Every bias in your assessment MUST include at least one evidence entry\n- Use exact excerpts whenever possible \u2014 prefer the user\'s own words\n- Mark each excerpt\'s source as "story" or "answer"\n- Explain the relevance of each excerpt to the bias\n- If you cannot find supporting evidence for a bias, do not include that bias\n\n### NO BIAS DETECTED\n\nIf after reasoning you genuinely find no cognitive biases, set `no_bias_detected` to `true`, return an empty `biases` array, and provide a `reflectionPrompt` that acknowledges the user\'s balanced perspective.\n\n### GUIDELINES\n\n- Detect cognitive biases from the catalog when supported by evidence\n- Only use bias names from the provided catalog\n- For each bias, provide:\n  - `name`: The bias name from the catalog\n  - `explanation`: Why this bias might be relevant\n  - `storyConnection`: A specific reference to the user\'s story or answers\n  - `alternativePerspective`: A different way to interpret the situation\n  - `evidence`: Array of excerpts drawn from `evidence_mapping`, with source and relevance\n- Provide a `reflectionPrompt` to help the user think deeper\n- Stay curious, supportive, and non-clinical\n\n{{guardrails}}\n\n### OUTPUT FORMAT\n\nReturn valid JSON with a reasoning trace and your assessment:\n\n{\n  "reasoning_trace": {\n    "story_analysis": {\n      "themes": ["theme1", "theme2"],\n      "emotional_tone": "description",\n      "key_events": ["event1", "event2"]\n    },\n    "interpretations": [\n      {\n        "interpretation": "description",\n        "plausibility": 0.0,\n        "supporting_evidence": ["quote or reference"]\n      }\n    ],\n    "bias_hypotheses": [\n      {\n        "bias_name": "bias name from catalog",\n        "confidence": 0.0,\n        "supporting_excerpts": ["verbatim excerpt"],\n        "uncertainty_reasons": ["reason for uncertainty"]\n      }\n    ],\n    "evidence_mapping": [\n      {\n        "bias_id": "bias name from catalog",\n        "evidence": [\n          { "source": "story", "excerpt": "exact words", "relevance": "connection to bias" }\n        ]\n      }\n    ]\n  },\n  "biases": [\n    {\n      "name": "bias name",\n      "explanation": "why this bias applies",\n      "storyConnection": "reference to story",\n      "alternativePerspective": "different view",\n      "evidence": [\n        { "source": "story", "excerpt": "exact words", "relevance": "connection to bias" }\n      ]\n    }\n  ],\n  "reflectionPrompt": "closing reflection",\n  "no_bias_detected": false\n}';

// src/prompts/registry.ts
var PromptRegistry = class {
  guardrails;
  version;
  constructor(version = "1.0.0") {
    this.guardrails = guardrails_default;
    this.version = version;
  }
  /** Returns the current prompt version string. */
  getVersion() {
    return this.version;
  }
  render(template, variables) {
    let raw;
    switch (template) {
      case "question-batch":
        raw = system_default;
        break;
      case "assessment":
        raw = system_default2;
        break;
      default:
        throw new Error(`Unknown template: ${template}`);
    }
    let rendered = raw.replace("{{guardrails}}", this.guardrails);
    for (const [key, value] of Object.entries(variables)) {
      rendered = rendered.replace(`{{${key}}}`, value);
    }
    return rendered;
  }
};

// datasets/biases/taxonomy.v1.json
var taxonomy_v1_default = {
  version: "1.0.0",
  biases: [
    {
      id: "confirmation-bias",
      name: "Confirmation Bias",
      category: "information-processing",
      definition: "Seeking or interpreting information that confirms existing beliefs while discounting contradictory evidence.",
      detectionSignals: ["only looked for supporting evidence", "ignored counterexamples"]
    },
    {
      id: "anchoring",
      name: "Anchoring Bias",
      category: "decision-making",
      definition: "Over-relying on the first piece of information encountered when making judgments.",
      detectionSignals: ["first number or impression drove the decision", "insufficient adjustment from initial anchor"]
    },
    {
      id: "sunk-cost-fallacy",
      name: "Sunk Cost Fallacy",
      category: "decision-making",
      definition: "Continuing a course of action because of previously invested resources rather than future value.",
      detectionSignals: ["already invested too much to stop", "throwing good after bad"]
    },
    {
      id: "survivorship-bias",
      name: "Survivorship Bias",
      category: "information-processing",
      definition: "Focusing on surviving examples while overlooking failures that are not visible.",
      detectionSignals: ["only looked at success stories", "ignored those who failed"]
    },
    {
      id: "availability-heuristic",
      name: "Availability Heuristic",
      category: "memory",
      definition: "Overestimating the likelihood of events that are more easily recalled from memory.",
      detectionSignals: ["based on how easily examples came to mind", "vivid recent events dominated judgment"]
    },
    {
      id: "halo-effect",
      name: "Halo Effect",
      category: "social",
      definition: "Allowing one positive trait to influence overall judgment of a person or situation.",
      detectionSignals: ["one good quality colored everything", "generalized from a single trait"]
    },
    {
      id: "negativity-bias",
      name: "Negativity Bias",
      category: "information-processing",
      definition: "Giving more weight to negative experiences or information than positive ones.",
      detectionSignals: ["focused on what went wrong", "dismissed positive aspects"]
    },
    {
      id: "self-serving-bias",
      name: "Self-Serving Bias",
      category: "social",
      definition: "Attributing successes to oneself and failures to external factors.",
      detectionSignals: ["took credit for good outcomes", "blamed others or circumstances for bad outcomes"]
    },
    {
      id: "optimism-bias",
      name: "Optimism Bias",
      category: "decision-making",
      definition: "Believing that one is less likely to experience negative events than others.",
      detectionSignals: ["underestimated risks", "overestimated positive outcomes"]
    },
    {
      id: "hindsight-bias",
      name: "Hindsight Bias",
      category: "memory",
      definition: "Believing past events were more predictable after they have already occurred.",
      detectionSignals: ["I knew it all along", "obvious in retrospect"]
    },
    {
      id: "dunning-kruger-effect",
      name: "Dunning-Kruger Effect",
      category: "self-assessment",
      definition: "Overestimating one's own competence in areas of low skill or knowledge.",
      detectionSignals: ["overconfident in unfamiliar domain", "unaware of own limitations"]
    },
    {
      id: "fundamental-attribution-error",
      name: "Fundamental Attribution Error",
      category: "social",
      definition: "Overemphasizing personality-based explanations for others' behavior while underemphasizing situational factors.",
      detectionSignals: ["they are just like that", "ignored context or constraints"]
    },
    {
      id: "bandwagon-effect",
      name: "Bandwagon Effect",
      category: "social",
      definition: "Adopting beliefs or behaviors because many others do the same.",
      detectionSignals: ["everyone else was doing it", "followed the majority without question"]
    },
    {
      id: "cherry-picking",
      name: "Cherry-Picking",
      category: "information-processing",
      definition: "Selectively choosing evidence that supports one's position while ignoring contradictory data.",
      detectionSignals: ["only mentioned favorable data", "ignored inconvenient facts"]
    },
    {
      id: "framing-effect",
      name: "Framing Effect",
      category: "decision-making",
      definition: "Drawing different conclusions from the same information depending on how it is presented.",
      detectionSignals: ["reacted differently to same data presented differently", "wording changed the decision"]
    },
    {
      id: "gamblers-fallacy",
      name: "Gambler's Fallacy",
      category: "probability",
      definition: "Believing that past independent events affect the probability of future ones.",
      detectionSignals: ["due for a win after a streak", "expected a reversal based on past outcomes"]
    },
    {
      id: "just-world-hypothesis",
      name: "Just-World Hypothesis",
      category: "social",
      definition: "Assuming that people get what they deserve and deserve what they get.",
      detectionSignals: ["blamed the victim", "assumed outcomes reflect merit"]
    },
    {
      id: "moral-licensing",
      name: "Moral Licensing",
      category: "decision-making",
      definition: "Allowing oneself to act immorally after previously acting morally.",
      detectionSignals: ["I earned the right to do this", "compensating good behavior with indulgence"]
    },
    {
      id: "overconfidence-effect",
      name: "Overconfidence Effect",
      category: "self-assessment",
      definition: "Having excessive confidence in one's own answers or judgments beyond actual accuracy.",
      detectionSignals: ["was certain but wrong", "overestimated own abilities"]
    },
    {
      id: "placebo-effect",
      name: "Placebo Effect",
      category: "perception",
      definition: "Experiencing real effects from a treatment or intervention due to belief rather than its actual mechanism.",
      detectionSignals: ["believed it worked so it did", "expectation shaped the outcome"]
    },
    {
      id: "reactance",
      name: "Reactance",
      category: "social",
      definition: "Adopting a contrary stance when one's freedom of choice is threatened or restricted.",
      detectionSignals: ["pushed back when told what to do", "wanted the opposite of what was prescribed"]
    },
    {
      id: "selection-bias",
      name: "Selection Bias",
      category: "information-processing",
      definition: "Drawing conclusions from a non-representative sample due to flawed selection process.",
      detectionSignals: ["sample did not represent the whole", "ignored those who were not included"]
    },
    {
      id: "spotlight-effect",
      name: "Spotlight Effect",
      category: "social",
      definition: "Overestimating how much others notice or remember about one's appearance or actions.",
      detectionSignals: ["felt everyone was watching", "overestimated how noticeable the mistake was"]
    },
    {
      id: "status-quo-bias",
      name: "Status Quo Bias",
      category: "decision-making",
      definition: "Preferring things to stay the same rather than change, even when change is beneficial.",
      detectionSignals: ["preferred things as they were", "resisted change despite clear benefits"]
    },
    {
      id: "stereotyping",
      name: "Stereotyping",
      category: "social",
      definition: "Applying generalized beliefs about a group to an individual without individual assessment.",
      detectionSignals: ["assumed based on group membership", "generalized without evidence"]
    },
    {
      id: "temporal-discounting",
      name: "Temporal Discounting",
      category: "decision-making",
      definition: "Preferring smaller immediate rewards over larger delayed ones.",
      detectionSignals: ["chose short-term gain over long-term benefit", "discounted future consequences"]
    },
    {
      id: "third-person-effect",
      name: "Third-Person Effect",
      category: "social",
      definition: "Believing that media or persuasive messages affect others more than oneself.",
      detectionSignals: ["others are influenced but I am not", "overestimated impact on others"]
    },
    {
      id: "ultimate-attribution-error",
      name: "Ultimate Attribution Error",
      category: "social",
      definition: "Attributing negative outgroup behavior to disposition and positive behavior to luck or exception.",
      detectionSignals: ["their failures are because of who they are", "their successes are flukes"]
    },
    {
      id: "zero-risk-bias",
      name: "Zero-Risk Bias",
      category: "decision-making",
      definition: "Preferring to eliminate one risk entirely rather than reduce multiple risks significantly.",
      detectionSignals: ["preferred certainty over better overall outcome", "chose complete elimination over reduction"]
    }
  ]
};

// src/catalog/bias-catalog.ts
var parsed = taxonomy_v1_default;
var BiasCatalogService = class {
  biases = parsed.biases;
  getShortlist() {
    return this.biases.map((b) => b.name);
  }
  getCategories() {
    return [...new Set(this.biases.map((b) => b.category))];
  }
  getBiasesByCategory() {
    const map = {};
    for (const bias of this.biases) {
      if (!map[bias.category]) {
        map[bias.category] = [];
      }
      map[bias.category].push(bias);
    }
    return map;
  }
  getAll() {
    return [...this.biases];
  }
};

// src/contracts/reflection.schemas.ts
import { z as z3 } from "zod";

// src/contracts/reasoning.schemas.ts
import { z as z2 } from "zod";
var PromptVersionSchema = z2.string().min(1).brand("PromptVersion");
var StageEnum = z2.enum([
  "initial_assessment",
  "post_questions_assessment"
]);
var ScopeEnum = z2.enum(["story_only", "story_plus_answers"]);
var SourceEnum = z2.enum(["story", "answer"]);
var DatasetEnum = z2.enum(["golden", "no_bias", "all"]);
var SeverityEnum = z2.enum(["low", "medium", "high"]);
var EvidenceEntrySchema = z2.object({
  source: SourceEnum,
  excerpt: z2.string().min(1),
  relevance: z2.string().min(1)
});
var StoryAnalysisSchema = z2.object({
  themes: z2.array(z2.string()),
  emotional_tone: z2.string(),
  key_events: z2.array(z2.string())
});
var InterpretationSchema = z2.object({
  interpretation: z2.string().min(1),
  plausibility: z2.number().min(0).max(1),
  supporting_evidence: z2.array(z2.string()),
  rejected: z2.boolean().optional()
});
var BiasHypothesisSchema = z2.object({
  bias_name: z2.string().min(1),
  confidence: z2.number().min(0).max(1),
  supporting_excerpts: z2.array(z2.string()),
  uncertainty_reasons: z2.array(z2.string().min(1))
}).refine(
  (h) => h.confidence >= 0.8 || h.uncertainty_reasons.length > 0,
  { message: "uncertainty_reasons required when confidence < 0.8" }
);
var EvidenceMappingSchema = z2.object({
  bias_id: z2.string().min(1),
  evidence: z2.array(EvidenceEntrySchema).min(1)
});
var ReasoningTraceSchema = z2.object({
  story_analysis: StoryAnalysisSchema,
  interpretations: z2.array(InterpretationSchema),
  bias_hypotheses: z2.array(BiasHypothesisSchema),
  evidence_mapping: z2.array(EvidenceMappingSchema),
  prompt_version: PromptVersionSchema
});
var ReflectionSessionSchema = z2.object({
  id: z2.string().uuid(),
  story_id: z2.string().uuid(),
  created_at: z2.string().datetime()
});
var RunSchema = z2.object({
  id: z2.string().uuid(),
  session_id: z2.string().uuid(),
  model_name: z2.string().min(1),
  stage: StageEnum,
  scope: ScopeEnum,
  prompt_version: PromptVersionSchema,
  input_hash: z2.string().min(1),
  created_at: z2.string().datetime()
}).refine(
  (r) => r.stage === "initial_assessment" && r.scope === "story_only" || r.stage === "post_questions_assessment" && r.scope === "story_plus_answers",
  { message: "stage and scope must be consistent: initial_assessment \u2194 story_only, post_questions_assessment \u2194 story_plus_answers" }
);
var EvaluationMetricsSchema = z2.object({
  evidence_grounded_rate: z2.number().min(0).max(1).nullable(),
  false_positive_rate: z2.number().min(0).max(1).nullable()
});
var SystemMetricsSchema = z2.object({
  schema_parse_rate: z2.number().min(0).max(1).nullable(),
  repair_rate: z2.number().min(0).max(1).nullable()
});
var EvalResultSchema = z2.object({
  id: z2.string().uuid(),
  run_id: z2.string().uuid().optional(),
  prompt_version: z2.string().min(1),
  model_name: z2.string().min(1),
  dataset: DatasetEnum,
  evaluation_metrics: EvaluationMetricsSchema,
  system_metrics: SystemMetricsSchema,
  input_hash: z2.string().min(1),
  passed: z2.boolean(),
  run_at: z2.string().datetime()
});
var ClaimSchema = z2.object({
  claim: z2.string().min(1),
  source: SourceEnum
});
var ProviderComparisonSchema = z2.object({
  prompt_version: PromptVersionSchema,
  results: z2.record(z2.string(), z2.unknown()),
  disagreement_score: z2.number().min(0).max(1).optional()
});
var ContradictionSchema = z2.object({
  statement_a: z2.string().min(1),
  statement_b: z2.string().min(1),
  severity: SeverityEnum
});

// src/contracts/reflection.schemas.ts
var STORY_MIN_LENGTH = 50;
var STORY_MAX_LENGTH = 3e3;
var QUESTIONS_MIN = 2;
var QUESTIONS_MAX = 5;
var BIAS_FIELD_MIN_LENGTH = 10;
var REFLECTION_MIN_LENGTH = 10;
var SCHEMA_VERSION = "1.0.0";
var InputContextEnum = z3.enum(["story-only", "full"]);
var AssessmentModeEnum = z3.enum(["story_only", "full"]);
var GenerateQuestionRequestSchema = z3.object({
  sessionId: z3.string().uuid(),
  story: z3.string().min(STORY_MIN_LENGTH).max(STORY_MAX_LENGTH)
});
var GenerateAssessmentRequestSchema = z3.object({
  sessionId: z3.string().uuid(),
  story: z3.string().min(1),
  questions: z3.array(z3.string().min(1)).default([]),
  answers: z3.array(z3.string().min(1)).default([]),
  mode: AssessmentModeEnum.default("full")
}).refine(
  (data) => {
    if (data.mode === "story_only") return true;
    return data.questions.length >= 1 && data.answers.length >= 1;
  },
  {
    message: "Full assessment mode requires at least 1 question and answer",
    path: ["questions"]
  }
);
var BiasItemSchema = z3.object({
  name: z3.string().min(1),
  /** Canonical catalog ID if the bias name was matched against the taxonomy. */
  biasCatalogId: z3.string().optional(),
  explanation: z3.string().min(BIAS_FIELD_MIN_LENGTH),
  storyConnection: z3.string().min(BIAS_FIELD_MIN_LENGTH),
  alternativePerspective: z3.string().min(BIAS_FIELD_MIN_LENGTH),
  evidence: z3.array(EvidenceEntrySchema).optional()
});
var QuestionOutputSchema = z3.object({
  questions: z3.array(z3.string().min(1)).min(QUESTIONS_MIN).max(QUESTIONS_MAX),
  isComplete: z3.boolean(),
  prompt_version: z3.string(),
  schema_version: z3.literal(SCHEMA_VERSION)
});
var AssessmentOutputSchema = z3.object({
  biases: z3.array(BiasItemSchema),
  reflectionPrompt: z3.string().min(REFLECTION_MIN_LENGTH),
  prompt_version: z3.string(),
  schema_version: z3.literal(SCHEMA_VERSION),
  noBiasDetected: z3.boolean(),
  reasoningTrace: ReasoningTraceSchema.optional(),
  inputContext: InputContextEnum,
  modelName: z3.string().min(1)
});

// src/parsers/json-from-llm.ts
var MODULE2 = "json-from-llm";
function extractJson(text2) {
  let cleaned = text2.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, "");
    cleaned = cleaned.replace(/\n?\s*```$/i, "");
    cleaned = cleaned.trim();
  }
  const firstBrace = cleaned.indexOf("{");
  const firstBracket = cleaned.indexOf("[");
  let start = -1;
  let useObject = true;
  if (firstBrace >= 0 && firstBracket >= 0) {
    if (firstBrace <= firstBracket) {
      start = firstBrace;
      useObject = true;
    } else {
      start = firstBracket;
      useObject = false;
    }
  } else if (firstBrace >= 0) {
    start = firstBrace;
    useObject = true;
  } else if (firstBracket >= 0) {
    start = firstBracket;
    useObject = false;
  }
  if (start < 0) {
    logger.warn({ module: MODULE2 }, "No JSON structure found in LLM response");
    return cleaned;
  }
  const extracted = cleaned.slice(start);
  const openChar = useObject ? "{" : "[";
  const closeChar = useObject ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let closeIndex = -1;
  for (let i = 0; i < extracted.length; i++) {
    const char = extracted[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (inString) {
      if (char === "\\") {
        escapeNext = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === openChar) {
      depth++;
    } else if (char === closeChar) {
      depth--;
      if (depth === 0) {
        closeIndex = i;
        break;
      }
    }
  }
  if (closeIndex >= 0) {
    const result = extracted.slice(0, closeIndex + 1);
    logger.info(
      { module: MODULE2, originalLength: text2.length, extractedLength: result.length },
      "Extracted JSON substring from LLM response"
    );
    return result;
  }
  logger.warn(
    { module: MODULE2, originalLength: text2.length },
    "Could not find matching close bracket in LLM response"
  );
  return extracted;
}

// src/parsers/repair.ts
var MODULE3 = "repair";
function tryRepairJson(text2, schema) {
  const extracted = extractJson(text2);
  try {
    const parsed2 = JSON.parse(extracted);
    return schema.parse(parsed2);
  } catch (error) {
    logger.warn(
      { module: MODULE3, operation: "tryRepairJson", text: text2, extracted, error },
      "JSON repair failed parse/validate after extraction"
    );
    throw new Error("Failed to parse or validate LLM output");
  }
}
async function repairWithFallback(text2, schema, fallbackProvider) {
  try {
    return tryRepairJson(text2, schema);
  } catch (repairError) {
    logger.warn(
      { module: MODULE3, operation: "repairWithFallback", repairError },
      "Repair attempt failed, trying fallback model call"
    );
  }
  if (fallbackProvider) {
    try {
      const result = await fallbackProvider();
      logger.info(
        { module: MODULE3, operation: "repairWithFallback" },
        "Fallback model call succeeded"
      );
      return result;
    } catch (fallbackError) {
      logger.error(
        { module: MODULE3, operation: "repairWithFallback", fallbackError },
        "Fallback model call also failed"
      );
    }
  }
  throw new Error("Failed to produce valid output after repair and fallback");
}

// src/orchestrators/retry.ts
var DEFAULT_RETRY_BASE_DELAY_MS = 2e3;
var MODULE4 = "retry";
async function withRetry(fn, options = {}) {
  const maxRetries = options.maxRetries ?? env.AI_MAX_RETRIES;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  let lastError;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (error instanceof RateLimitError) {
        logger.warn(
          { module: MODULE4, operation: "withRetry", error },
          "Rate limit hit \u2014 not retrying"
        );
        throw error;
      }
      lastError = error;
      if (attempt > maxRetries) break;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      const jitter = Math.random() * 200;
      logger.warn(
        { module: MODULE4, operation: "withRetry", attempt, delay: delay + jitter, error },
        "Operation failed, retrying..."
      );
      await new Promise((resolve) => setTimeout(resolve, delay + jitter));
    }
  }
  logger.error(
    { module: MODULE4, operation: "withRetry", lastError, attempts: maxRetries + 1 },
    "Operation failed after all retries"
  );
  throw lastError;
}

// src/orchestrators/reflection/question.service.ts
var MODULE5 = "question-service";
var QuestionService = class {
  constructor(provider, prompts, modelName) {
    this.provider = provider;
    this.prompts = prompts;
    this.modelName = modelName;
  }
  provider;
  prompts;
  modelName;
  /**
   * Generate contextual follow-up questions for the user's story.
   *
   * When `storyAnalysis` and `interpretations` are provided (from Trace 1 of
   * the two-phase flow), the questions probe the user's specific interpretations
   * rather than generic surface-level details (FR-018).
   */
  async generate(story, requestId, storyAnalysis, interpretations) {
    let reasoningContext = "";
    if (storyAnalysis) {
      reasoningContext += "Themes: " + storyAnalysis.themes.join(", ") + "\nEmotional tone: " + storyAnalysis.emotional_tone + "\nKey events: " + storyAnalysis.key_events.join(", ") + "\n";
    }
    if (interpretations && interpretations.length > 0) {
      reasoningContext += "\nPlausible interpretations:\n" + interpretations.slice(0, 2).map((i, idx) => `${idx + 1}. ${i.interpretation} (plausibility: ${i.plausibility})`).join("\n");
    }
    const system = this.prompts.render("question-batch", {});
    const user = reasoningContext ? `REASONING CONTEXT:
${reasoningContext}

STORY: ${story}` : `STORY: ${story}`;
    return await withRetry(async (attempt) => {
      logger.info(
        { module: MODULE5, operation: "generate", requestId, attempt },
        "Calling AI provider for questions"
      );
      const raw = await this.provider.completeJson({
        system,
        user
      });
      const parsed2 = await repairWithFallback(
        JSON.stringify(raw),
        QuestionOutputSchema,
        async () => {
          logger.warn(
            { module: MODULE5, operation: "generate", requestId },
            "Attempting fallback model call for question generation"
          );
          return await this.provider.completeJson({
            system,
            user
          });
        }
      );
      return {
        ...parsed2,
        prompt_version: this.prompts.getVersion(),
        schema_version: SCHEMA_VERSION,
        modelName: this.modelName
      };
    });
  }
};

// src/lib/hash.ts
import { createHash } from "node:crypto";
function computeInputHash(promptVersion, modelName, story, answers) {
  const input = [promptVersion, modelName, story, ...answers].join("\n\n");
  return createHash("sha256").update(input, "utf-8").digest("hex");
}

// src/db/queries.ts
import { and, desc, eq } from "drizzle-orm";

// src/db/config.ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

// src/db/schema.ts
var schema_exports = {};
__export(schema_exports, {
  core: () => core,
  evalResults: () => evalResults,
  reasoningTraces: () => reasoningTraces,
  runs: () => runs
});
import { boolean, jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";
var core = pgSchema("core");
var runs = core.table("runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").notNull(),
  provider: text("provider").notNull(),
  modelName: text("model_name").notNull(),
  stage: text("stage", { enum: ["initial_assessment", "post_questions_assessment"] }).notNull(),
  scope: text("scope", { enum: ["story_only", "story_plus_answers"] }).notNull(),
  promptVersion: text("prompt_version").notNull(),
  inputHash: text("input_hash").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull()
});
var reasoningTraces = core.table("reasoning_traces", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  trace: jsonb("trace").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull()
});
var evalResults = core.table("eval_results", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").references(() => runs.id),
  provider: text("provider").notNull(),
  modelName: text("model_name").notNull(),
  promptVersion: text("prompt_version").notNull(),
  dataset: text("dataset", { enum: ["golden", "no_bias", "all"] }).notNull(),
  evaluationMetrics: jsonb("evaluation_metrics").notNull(),
  systemMetrics: jsonb("system_metrics").notNull(),
  inputHash: text("input_hash").notNull(),
  passed: boolean("passed").notNull(),
  runAt: timestamp("run_at").defaultNow().notNull()
});

// src/db/config.ts
var _db = null;
function getDb() {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is required");
    }
    const client = postgres(url, { max: 1 });
    _db = drizzle(client, { schema: schema_exports });
  }
  return _db;
}

// src/db/queries.ts
function db() {
  return getDb();
}
async function createRun(sessionId, data) {
  const [row] = await db().insert(runs).values({
    sessionId,
    provider: data.provider,
    modelName: data.modelName,
    stage: data.stage,
    scope: data.scope,
    promptVersion: data.promptVersion,
    inputHash: data.inputHash
  }).returning();
  return row;
}
async function persistTrace(runId, trace) {
  const [row] = await db().insert(reasoningTraces).values({ runId, trace }).returning();
  return row;
}
async function persistEvalResult(data) {
  const [row] = await db().insert(evalResults).values(data).returning();
  return row;
}
async function getEvalResultByHash(inputHash, promptVersion) {
  const result = await db().select().from(evalResults).where(
    and(
      eq(evalResults.inputHash, inputHash),
      eq(evalResults.promptVersion, promptVersion)
    )
  );
  return result[0] ?? null;
}

// src/catalog/normalize.ts
function normalizeLabel(label) {
  return label.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}
function tokenOverlap(a, b) {
  const tokensA = new Set(a.toLowerCase().split(/\s+/));
  const tokensB = b.toLowerCase().split(/\s+/);
  const intersection = tokensB.filter((t) => tokensA.has(t));
  const union = /* @__PURE__ */ new Set([...tokensA, ...tokensB]);
  return intersection.length / union.size;
}
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) {
    dp[i][0] = i;
  }
  for (let j = 0; j <= n; j++) {
    dp[0][j] = j;
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}
function normalizedEditDistance(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 0;
  return levenshtein(a, b) / maxLen;
}
function findBestMatch(label, entries) {
  const normalized = normalizeLabel(label);
  if (!normalized) return null;
  let best = null;
  for (const entry of entries) {
    const entryNorm = normalizeLabel(entry.name);
    const overlap = tokenOverlap(normalized, entryNorm);
    const editDist = normalizedEditDistance(normalized, entryNorm);
    const confidence = overlap * 0.6 + (1 - editDist) * 0.4;
    if (!best || confidence > best.confidence) {
      best = { entry, confidence };
    }
  }
  return best;
}
function normalizeBiasName(name, catalog) {
  const match = findBestMatch(name, catalog);
  if (match && match.confidence > 0.5) {
    return { name: match.entry.name, id: match.entry.id };
  }
  return { name };
}

// src/parsers/evidence-validator.ts
function excerptExistsInInput(excerpt, story, answers) {
  const trimmed = excerpt.trim();
  if (trimmed.length === 0) return false;
  if (story.includes(trimmed)) return true;
  return answers.some((answer) => answer.includes(trimmed));
}
function validateEvidence(assessment, input) {
  const violations = [];
  const answers = input.answers ?? [];
  for (const bias of assessment.biases) {
    const biasName = bias.name;
    const evidenceList = bias.evidence ?? [];
    if (evidenceList.length === 0) {
      violations.push({
        biasName,
        excerpt: "",
        violationType: "no_evidence_entries",
        message: `Bias "${biasName}" has no evidence entries (FR-001 requires non-empty evidence)`
      });
      continue;
    }
    for (const evidence of evidenceList) {
      if (evidence.excerpt.trim().length === 0) {
        violations.push({
          biasName,
          excerpt: evidence.excerpt,
          violationType: "empty_excerpt",
          message: `Empty excerpt in evidence for bias "${biasName}"`
        });
        continue;
      }
      if (!excerptExistsInInput(evidence.excerpt, input.story, answers)) {
        violations.push({
          biasName,
          excerpt: evidence.excerpt,
          violationType: "excerpt_not_in_input",
          message: `Excerpt "${evidence.excerpt}" not found verbatim in input (story or answers)`
        });
      }
    }
  }
  return {
    valid: violations.length === 0,
    violations
  };
}

// src/orchestrators/reflection/assessment.service.ts
var MODULE6 = "assessment-service";
function validatePromptVersion(trace) {
  if (!trace.prompt_version) {
    throw new Error(
      "Validation failed: reasoning_trace is missing prompt_version"
    );
  }
}
var AssessmentService = class {
  constructor(provider, prompts, catalog, modelName) {
    this.provider = provider;
    this.prompts = prompts;
    this.catalog = catalog;
    this.modelName = modelName;
  }
  provider;
  prompts;
  catalog;
  modelName;
  /**
   * Backward-compatible pass-through to runFullAssessment.
   * Used by the existing route until T401 switches it to the new entry points.
   */
  async generate(story, questions, answers, requestId) {
    return this.runFullAssessment("", story, questions, answers, requestId);
  }
  /**
   * Run a story-only assessment (no questions/answers yet).
   * Creates a run with stage=initial_assessment, scope=story_only.
   */
  async runStoryOnlyAssessment(sessionId, story, requestId) {
    const promptVersion = this.prompts.getVersion();
    const providerId = this.provider.mode;
    const inputHash = computeInputHash(promptVersion, this.modelName, story, []);
    let runId = "";
    try {
      const run = await createRun(sessionId, {
        provider: providerId,
        modelName: this.modelName,
        stage: "initial_assessment",
        scope: "story_only",
        promptVersion,
        inputHash
      });
      runId = run?.id ?? "";
    } catch (err) {
      logger.warn(
        { module: MODULE6, operation: "runStoryOnlyAssessment", error: err, requestId },
        "Failed to create run record \u2014 continuing without persistence"
      );
    }
    const biasShortlist = this.catalog.getAll().map((b) => `- ${b.name}: ${b.definition}`).join("\n");
    const system = this.prompts.render("assessment", { biasShortlist });
    const user = `STORY: ${story}`;
    const result = await this.callProvider(
      system,
      user,
      requestId,
      runId,
      "initial_assessment",
      "story_only",
      inputHash,
      promptVersion,
      providerId,
      story,
      []
    );
    return result;
  }
  /**
   * Run a full assessment with story + questions + answers.
   * Creates a run with stage=post_questions_assessment, scope=story_plus_answers.
   */
  async runFullAssessment(sessionId, story, questions, answers, requestId) {
    const promptVersion = this.prompts.getVersion();
    const providerId = this.provider.mode;
    const inputHash = computeInputHash(
      promptVersion,
      this.modelName,
      story,
      answers
    );
    let runId = "";
    try {
      const run = await createRun(sessionId, {
        provider: providerId,
        modelName: this.modelName,
        stage: "post_questions_assessment",
        scope: "story_plus_answers",
        promptVersion,
        inputHash
      });
      runId = run?.id ?? "";
    } catch (err) {
      logger.warn(
        { module: MODULE6, operation: "runFullAssessment", error: err, requestId },
        "Failed to create run record \u2014 continuing without persistence"
      );
    }
    const biasShortlist = this.catalog.getAll().map((b) => `- ${b.name}: ${b.definition}`).join("\n");
    const system = this.prompts.render("assessment", { biasShortlist });
    const qaPairs = questions.map((q, i) => `Q: ${q}
A: ${answers[i]}`).join("\n\n");
    const user = `STORY: ${story}

CONVERSATION:
${qaPairs}`;
    const result = await this.callProvider(
      system,
      user,
      requestId,
      runId,
      "post_questions_assessment",
      "story_plus_answers",
      inputHash,
      promptVersion,
      providerId,
      story,
      answers
    );
    return result;
  }
  /**
   * Shared provider call + parsing + validation + persistence logic.
   */
  async callProvider(system, user, requestId, runId, stage, scope, inputHash, promptVersion, providerId, story, answers) {
    return await withRetry(async (attempt) => {
      logger.info(
        { module: MODULE6, operation: "callProvider", requestId, attempt, stage, scope },
        "Calling AI provider for assessment"
      );
      const raw = await this.provider.completeJson({
        system,
        user
      });
      const parsed2 = await repairWithFallback(
        JSON.stringify(raw),
        AssessmentOutputSchema,
        async () => {
          logger.warn(
            { module: MODULE6, operation: "callProvider", requestId },
            "Attempting fallback model call for assessment generation"
          );
          return await this.provider.completeJson({
            system,
            user
          });
        }
      );
      if (parsed2.reasoningTrace) {
        validatePromptVersion(parsed2.reasoningTrace);
      } else {
        logger.warn(
          { module: MODULE6, operation: "callProvider", requestId },
          "No reasoning trace in LLM response \u2014 persisting stub"
        );
      }
      try {
        await persistTrace(runId, parsed2.reasoningTrace ?? {
          no_trace: true,
          inputContext: scope,
          prompt_version: promptVersion,
          story_analysis: { themes: [], emotional_tone: "", key_events: [] },
          interpretations: [],
          bias_hypotheses: [],
          evidence_mapping: []
        });
        logger.info(
          { module: MODULE6, operation: "callProvider", runId, requestId },
          "Reasoning trace persisted"
        );
      } catch (persistErr) {
        logger.error(
          { module: MODULE6, operation: "callProvider", runId, requestId, error: persistErr },
          "Failed to persist reasoning trace \u2014 continuing"
        );
      }
      if (parsed2.biases.length === 0 && !parsed2.noBiasDetected) {
        parsed2.noBiasDetected = true;
      } else if (parsed2.biases.length > 0 && parsed2.noBiasDetected === void 0) {
        parsed2.noBiasDetected = false;
      }
      const allBiases = this.catalog.getAll();
      const normalizedBiases = parsed2.biases.map((bias) => {
        const result = normalizeBiasName(bias.name, allBiases);
        return {
          ...bias,
          name: result.name,
          ...result.id ? { biasCatalogId: result.id } : {}
        };
      });
      const validation = validateEvidence(
        { biases: normalizedBiases },
        {
          story,
          answers: scope === "story_plus_answers" ? answers : []
        }
      );
      if (!validation.valid) {
        logger.warn(
          { module: MODULE6, operation: "callProvider", requestId, violations: validation.violations },
          `Evidence validation failed \u2014 ${validation.violations.length} violation(s)`
        );
      }
      return {
        ...parsed2,
        biases: normalizedBiases,
        prompt_version: promptVersion,
        schema_version: SCHEMA_VERSION,
        modelName: this.modelName,
        inputContext: scope === "story_only" ? "story-only" : "full"
      };
    });
  }
};

// src/routes/reflection.ts
import { ZodError } from "zod";

// src/lib/auth.ts
var BEARER_PREFIX = "Bearer ";
async function authHook(request, reply) {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
    reply.status(401).send({ error: "Missing or invalid authorization header" });
    return;
  }
  const token = authHeader.slice(BEARER_PREFIX.length);
  if (token !== env.AI_CORE_API_KEY) {
    reply.status(401).send({ error: "Invalid API key" });
    return;
  }
}

// contracts/reflection.schemas.json
var reflection_schemas_default = {
  reflection: {
    GenerateQuestionRequest: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          format: "uuid",
          pattern: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        story: {
          type: "string",
          minLength: 50,
          maxLength: 3e3
        }
      },
      required: [
        "sessionId",
        "story"
      ],
      additionalProperties: false
    },
    GenerateAssessmentRequest: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          format: "uuid",
          pattern: "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        },
        story: {
          type: "string",
          minLength: 1
        },
        questions: {
          minItems: 1,
          type: "array",
          items: {
            type: "string",
            minLength: 1
          }
        },
        answers: {
          minItems: 1,
          type: "array",
          items: {
            type: "string",
            minLength: 1
          }
        }
      },
      required: [
        "sessionId",
        "story",
        "questions",
        "answers"
      ],
      additionalProperties: false
    },
    QuestionOutput: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        questions: {
          minItems: 2,
          maxItems: 5,
          type: "array",
          items: {
            type: "string",
            minLength: 1
          }
        },
        isComplete: {
          type: "boolean"
        }
      },
      required: [
        "questions",
        "isComplete"
      ],
      additionalProperties: false
    },
    AssessmentOutput: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        biases: {
          minItems: 1,
          type: "array",
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                minLength: 1
              },
              explanation: {
                type: "string",
                minLength: 10
              },
              storyConnection: {
                type: "string",
                minLength: 10
              },
              alternativePerspective: {
                type: "string",
                minLength: 10
              }
            },
            required: [
              "name",
              "explanation",
              "storyConnection",
              "alternativePerspective"
            ],
            additionalProperties: false
          }
        },
        reflectionPrompt: {
          type: "string",
          minLength: 10
        }
      },
      required: [
        "biases",
        "reflectionPrompt"
      ],
      additionalProperties: false
    },
    BiasItem: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        name: {
          type: "string",
          minLength: 1
        },
        explanation: {
          type: "string",
          minLength: 10
        },
        storyConnection: {
          type: "string",
          minLength: 10
        },
        alternativePerspective: {
          type: "string",
          minLength: 10
        }
      },
      required: [
        "name",
        "explanation",
        "storyConnection",
        "alternativePerspective"
      ],
      additionalProperties: false
    }
  }
};

// src/routes/reflection.ts
var MODULE7 = "routes";
var CONTRACTS_JSON = reflection_schemas_default;
function registerReflectionRoutes(server, services) {
  server.get("/v1/contracts", async () => {
    return CONTRACTS_JSON;
  });
  server.post("/v1/reflection/question", { preHandler: [authHook] }, async (request, reply) => {
    try {
      const body = GenerateQuestionRequestSchema.parse(request.body);
      const result = await services.question.generate(
        body.story,
        request.id
      );
      return result;
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({
          error: "Invalid request body",
          details: error.issues
        });
      }
      logger.error(
        { module: MODULE7, operation: "POST /v1/reflection/question", error, requestId: request.id },
        "Question generation failed"
      );
      return reply.status(502).send({ error: "AI provider failed" });
    }
  });
  server.post("/v1/reflection/assessment", { preHandler: [authHook] }, async (request, reply) => {
    try {
      const body = GenerateAssessmentRequestSchema.parse(request.body);
      const includeTrace = request.query && request.query.includeReasoningTrace === "true";
      let result;
      if (body.mode === "story_only") {
        result = await services.assessment.runStoryOnlyAssessment(
          body.sessionId,
          body.story,
          request.id
        );
      } else {
        if (body.questions.length !== body.answers.length) {
          return reply.status(400).send({
            error: "Questions and answers count must match"
          });
        }
        result = await services.assessment.runFullAssessment(
          body.sessionId,
          body.story,
          body.questions,
          body.answers,
          request.id
        );
      }
      if (!includeTrace) {
        const { reasoningTrace, ...rest } = result;
        return rest;
      }
      return result;
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.status(400).send({
          error: "Invalid request body",
          details: error.issues
        });
      }
      logger.error(
        { module: MODULE7, operation: "POST /v1/reflection/assessment", error, requestId: request.id },
        "Assessment generation failed"
      );
      return reply.status(502).send({ error: "AI provider failed" });
    }
  });
}

// src/jobs/client.ts
import { Inngest } from "inngest";
var inngest = new Inngest({
  id: "biassemble-core",
  name: "Biassemble Core",
  eventKey: process.env.INNGEST_EVENT_KEY
});

// src/evaluation/run-eval.ts
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// src/evaluation/compute-evaluation-metrics.ts
function excerptExistsInInput2(excerpt, story, answers) {
  const trimmed = excerpt.trim();
  if (trimmed.length === 0) return false;
  if (story.includes(trimmed)) return true;
  return answers.some((answer) => answer.includes(trimmed));
}
function computeEvaluationMetrics(assessment, input, options) {
  const { biases } = assessment;
  const answers = input.answers ?? [];
  let evidenceGroundedRate;
  if (biases.length === 0) {
    evidenceGroundedRate = null;
  } else {
    const groundedCount = biases.filter((bias) => {
      if (bias.evidence.length === 0) return false;
      return bias.evidence.every(
        (e) => excerptExistsInInput2(e.excerpt, input.story, answers)
      );
    }).length;
    evidenceGroundedRate = groundedCount / biases.length;
  }
  let isFalsePositive;
  if (options?.isNoBiasStory === void 0) {
    isFalsePositive = null;
  } else if (options.isNoBiasStory) {
    const threshold = options.confidenceThreshold ?? 0.5;
    isFalsePositive = biases.some((b) => (b.confidence ?? 1) > threshold);
  } else {
    isFalsePositive = false;
  }
  return { evidenceGroundedRate, isFalsePositive };
}

// src/evaluation/compute-system-metrics.ts
function computeSystemMetrics(responses) {
  const totalResponses = responses.length;
  if (totalResponses === 0) {
    return {
      totalResponses: 0,
      schemaParsePassCount: 0,
      schemaParseRate: null,
      repairAttemptCount: 0,
      repairSuccessCount: 0,
      repairRate: null
    };
  }
  const schemaParsePassCount = responses.filter(
    (r) => !r.requiredRepair
  ).length;
  const repairAttempts = responses.filter((r) => r.requiredRepair);
  const repairAttemptCount = repairAttempts.length;
  const repairSuccessCount = repairAttempts.filter(
    (r) => r.repairSucceeded === true
  ).length;
  const schemaParseRate = schemaParsePassCount / totalResponses;
  const repairRate = repairAttemptCount > 0 ? repairSuccessCount / repairAttemptCount : null;
  return {
    totalResponses,
    schemaParsePassCount,
    schemaParseRate,
    repairAttemptCount,
    repairSuccessCount,
    repairRate
  };
}

// src/evaluation/run-eval.ts
function loadStories(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  return files.map((file) => {
    const raw = readFileSync(join(dir, file), "utf-8");
    return JSON.parse(raw);
  });
}
async function evaluateGoldenStory(story, questionService, assessmentService, prompts) {
  const result = {
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
    errors: []
  };
  const llmResponse = { requiredRepair: false };
  try {
    const questionsOutput = await questionService.generate(story.story, `eval-${story.id}`);
    result.questionCount = questionsOutput.questions.length;
    const answers = questionsOutput.questions.map((_, i) => `Answer ${i + 1} to "${questionsOutput.questions[i]}"`);
    const assessmentOutput = await assessmentService.generate(
      story.story,
      questionsOutput.questions,
      answers,
      `eval-${story.id}`
    );
    result.biasCount = assessmentOutput.biases.length;
    result.parseSuccess = true;
    const metrics = computeEvaluationMetrics(
      { biases: assessmentOutput.biases.map((b) => ({ name: b.name, evidence: b.evidence ?? [], confidence: void 0 })) },
      { story: story.story, answers },
      { isNoBiasStory: false }
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
async function evaluateNoBiasStory(story, assessmentService, prompts) {
  const result = {
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
    errors: []
  };
  const llmResponse = { requiredRepair: false };
  try {
    const answers = [];
    const assessmentOutput = await assessmentService.generate(
      story.story,
      [],
      [],
      `eval-${story.id}`
    );
    result.biasCount = assessmentOutput.biases.length;
    result.parseSuccess = true;
    const metrics = computeEvaluationMetrics(
      { biases: assessmentOutput.biases.map((b) => ({ name: b.name, evidence: b.evidence ?? [], confidence: b.confidence })) },
      { story: story.story, answers },
      { isNoBiasStory: true, confidenceThreshold: story.confidenceThreshold }
    );
    result.evaluationMetrics = metrics;
    if (metrics.isFalsePositive === true) {
      const threshold = story.confidenceThreshold;
      assessmentOutput.biases.forEach((bias) => {
        if ((bias.confidence ?? 1) > threshold) {
          result.failed = true;
          result.failureReasons.push(`${bias.name} \u2014 confidence ${(bias.confidence ?? 1).toFixed(2)} > ${threshold}`);
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
async function runEval(provider, modelName) {
  const prompts = new PromptRegistry();
  const catalog = new BiasCatalogService();
  const questionService = new QuestionService(provider, prompts, modelName);
  const assessmentService = new AssessmentService(provider, prompts, catalog, modelName);
  const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "evaluations", "golden", "reflection");
  const NO_BIAS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "evaluations", "no_bias", "reflection");
  const goldenStories = loadStories(GOLDEN_DIR);
  const noBiasStories = loadStories(NO_BIAS_DIR);
  const goldenResults = [];
  const noBiasResults = [];
  const allLLMResponses = [];
  for (const story of goldenStories) {
    const { llmResponse, ...res } = await evaluateGoldenStory(story, questionService, assessmentService, prompts);
    allLLMResponses.push(llmResponse);
    goldenResults.push(res);
  }
  for (const story of noBiasStories) {
    const { llmResponse, ...res } = await evaluateNoBiasStory(story, assessmentService, prompts);
    allLLMResponses.push(llmResponse);
    noBiasResults.push(res);
  }
  const sysMetrics = computeSystemMetrics(allLLMResponses);
  const thresholds = {
    minEvidenceGrounded: 0.9,
    maxFalsePositive: 0.1,
    minSchemaParse: 0.95,
    maxRepairRate: 0.05
  };
  let overallPassed = true;
  const groundedRates = [...goldenResults, ...noBiasResults].filter((r) => r.errors.length === 0).map((r) => r.evaluationMetrics?.evidenceGroundedRate).filter((v) => v !== null && v !== void 0);
  const evidenceGroundedRate = groundedRates.length > 0 ? groundedRates.reduce((a, b) => a + b, 0) / groundedRates.length : null;
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
    exitCode: overallPassed ? 0 : 1
  };
}

// src/jobs/eval-assessment.ts
var MODULE8 = "eval-assessment";
var evalAssessmentJob = inngest.createFunction(
  { id: "eval-assessment", name: "Evaluation Assessment" },
  { event: "eval/assessment" },
  async ({ event }) => {
    const triggerType = event.data?.triggerType ?? "monitor";
    const provider = new GeminiProvider();
    const prompts = new PromptRegistry();
    const modelName = "gemini-2.0-flash";
    logger.info({ module: MODULE8, triggerType }, "Starting eval assessment");
    try {
      const result = await runEval(provider, modelName);
      for (const storyResult of [...result.goldenResults, ...result.noBiasResults]) {
        const existing = await getEvalResultByHash(storyResult.inputHash, prompts.getVersion());
        if (existing && existing.passed !== result.overallPassed) {
          logger.error(
            { module: MODULE8, hash: storyResult.inputHash, previousPassed: existing.passed, currentPassed: result.overallPassed },
            "Non-determinism detected: same input hash produced different outcome"
          );
          if (triggerType === "gate") {
            return { passed: false, reason: "non_determinism", hash: storyResult.inputHash };
          }
        }
      }
      try {
        await persistEvalResult({
          provider: "gemini",
          modelName,
          promptVersion: prompts.getVersion(),
          dataset: "all",
          evaluationMetrics: {
            evidenceGroundedRate: computeAggregateGroundedRate(result),
            falsePositiveRate: computeFalsePositiveRate(result)
          },
          systemMetrics: {
            schemaParseRate: result.sysMetrics.schemaParseRate,
            repairRate: result.sysMetrics.repairRate,
            totalResponses: result.sysMetrics.totalResponses
          },
          inputHash: result.goldenResults[0]?.inputHash ?? "",
          passed: result.overallPassed
        });
      } catch (dbError) {
        logger.error({ module: MODULE8, error: dbError }, "Failed to persist eval result \u2014 continuing");
      }
      const output = {
        passed: result.overallPassed,
        goldenStories: result.goldenResults.length,
        noBiasStories: result.noBiasResults.length,
        falsePositiveCount: result.noBiasResults.filter((r) => r.evaluationMetrics?.isFalsePositive === true).length
      };
      if (!result.overallPassed) {
        logger.error({ module: MODULE8, ...output }, "Eval gate failed");
      } else {
        logger.info({ module: MODULE8, ...output }, "Eval completed");
      }
      return output;
    } catch (error) {
      logger.error({ module: MODULE8, error }, "Eval assessment failed");
      if (triggerType === "gate") {
        return { passed: false, reason: "eval_error", error: String(error) };
      }
      return { passed: false };
    }
  }
);
function computeAggregateGroundedRate(result) {
  const all = [...result.goldenResults, ...result.noBiasResults].filter((r) => r.errors.length === 0).map((r) => r.evaluationMetrics?.evidenceGroundedRate).filter((v) => v !== null && v !== void 0);
  return all.length > 0 ? all.reduce((a, b) => a + b, 0) / all.length : null;
}
function computeFalsePositiveRate(result) {
  const noBias = result.noBiasResults;
  if (noBias.length === 0) return null;
  const count = noBias.filter((r) => r.evaluationMetrics?.isFalsePositive === true).length;
  return count / noBias.length;
}

// src/jobs/inngest-functions.ts
var inngestFunctions = [evalAssessmentJob];

// src/server.ts
function buildApp() {
  const server = Fastify({
    logger: false
    // we use our own pino logger
  });
  const provider = new GeminiProvider();
  const prompts = new PromptRegistry();
  const catalog = new BiasCatalogService();
  const modelName = env.GEMINI_MODEL;
  const questionService = new QuestionService(provider, prompts, modelName);
  const assessmentService = new AssessmentService(provider, prompts, catalog, modelName);
  server.addHook("onRequest", requestIdHook);
  server.get("/health", async () => {
    return { status: "ok" };
  });
  registerReflectionRoutes(server, {
    question: questionService,
    assessment: assessmentService
  });
  const serveHost = env.INNGEST_SERVE_HOST ? env.VERCEL_BYPASS_TOKEN ? `${env.INNGEST_SERVE_HOST}?x-vercel-protection-bypass=${env.VERCEL_BYPASS_TOKEN}` : env.INNGEST_SERVE_HOST : void 0;
  server.register(inngestFastify, {
    client: inngest,
    functions: inngestFunctions,
    options: {
      serveHost
    }
  });
  return server;
}
var isVercel2 = process.env.VERCEL === "1";
if (!isVercel2) {
  const server = buildApp();
  const start = async () => {
    try {
      await server.listen({ port: env.PORT, host: "0.0.0.0" });
      logger.info({ port: env.PORT }, "server started");
    } catch (err) {
      logger.error(err, "failed to start server");
      process.exit(1);
    }
  };
  start();
}

// api/handler.ts
var cachedApp = null;
async function getApp() {
  if (!cachedApp) {
    cachedApp = buildApp();
    await cachedApp.ready();
  }
  return cachedApp;
}
async function handler(req, res) {
  const app = await getApp();
  app.server.emit("request", req, res);
}
export {
  handler as default
};
