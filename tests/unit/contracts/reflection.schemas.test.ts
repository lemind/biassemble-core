import { describe, it, expect } from "vitest";
import {
  GenerateQuestionRequestSchema,
  GenerateAssessmentRequestSchema,
  BiasItemSchema,
  QuestionOutputSchema,
  AssessmentOutputSchema,
} from "../../../src/contracts/reflection.schemas.js";

describe("GenerateQuestionRequestSchema", () => {
  it("should validate a valid request", () => {
    const result = GenerateQuestionRequestSchema.parse({
      sessionId: "00000000-0000-4000-8000-000000000001",
      story: "a".repeat(100),
    });
    expect(result.sessionId).toBe("00000000-0000-4000-8000-000000000001");
    expect(result.story.length).toBe(100);
  });

  it("should reject story shorter than 50 characters", () => {
    expect(() =>
      GenerateQuestionRequestSchema.parse({
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: "too short",
      })
    ).toThrow();
  });

  it("should reject story longer than 3000 characters", () => {
    expect(() =>
      GenerateQuestionRequestSchema.parse({
        sessionId: "00000000-0000-4000-8000-000000000001",
        story: "a".repeat(3001),
      })
    ).toThrow();
  });

  it("should reject non-UUID sessionId", () => {
    expect(() =>
      GenerateQuestionRequestSchema.parse({
        sessionId: "not-a-uuid",
        story: "a".repeat(100),
      })
    ).toThrow();
  });

  it("should reject missing sessionId", () => {
    expect(() =>
      GenerateQuestionRequestSchema.parse({
        story: "a".repeat(100),
      })
    ).toThrow();
  });
});

describe("GenerateAssessmentRequestSchema", () => {
  const valid = {
    sessionId: "00000000-0000-4000-8000-000000000001",
    story: "a".repeat(100),
    questions: ["What makes you feel that way?", "Can you elaborate?"],
    answers: ["I feel frustrated.", "It's complicated."],
  };

  it("should validate a valid request", () => {
    const result = GenerateAssessmentRequestSchema.parse(valid);
    expect(result.questions.length).toBe(2);
    expect(result.answers.length).toBe(2);
  });

  it("should reject mismatched empty questions array", () => {
    expect(() =>
      GenerateAssessmentRequestSchema.parse({
        ...valid,
        questions: [],
      })
    ).toThrow();
  });

  it("should reject empty questions", () => {
    expect(() =>
      GenerateAssessmentRequestSchema.parse({
        ...valid,
        questions: [""],
        answers: ["something"],
      })
    ).toThrow();
  });

  it("should reject empty answers", () => {
    expect(() =>
      GenerateAssessmentRequestSchema.parse({
        ...valid,
        answers: [""],
      })
    ).toThrow();
  });
});

describe("BiasItemSchema", () => {
  const valid = {
    name: "confirmation bias",
    explanation: "This is a detailed explanation of the bias with enough characters.",
    storyConnection: "This connects to the user's story with enough detail.",
    alternativePerspective: "An alternative way of viewing the situation with enough depth.",
  };

  it("should validate a valid bias item", () => {
    const result = BiasItemSchema.parse(valid);
    expect(result.name).toBe("confirmation bias");
  });

  it("should reject name with empty string", () => {
    expect(() =>
      BiasItemSchema.parse({
        ...valid,
        name: "",
      })
    ).toThrow();
  });

  it("should reject explanation shorter than 10 characters", () => {
    expect(() =>
      BiasItemSchema.parse({
        ...valid,
        explanation: "short",
      })
    ).toThrow();
  });

  it("should reject storyConnection shorter than 10 characters", () => {
    expect(() =>
      BiasItemSchema.parse({
        ...valid,
        storyConnection: "short",
      })
    ).toThrow();
  });

  it("should reject alternativePerspective shorter than 10 characters", () => {
    expect(() =>
      BiasItemSchema.parse({
        ...valid,
        alternativePerspective: "short",
      })
    ).toThrow();
  });
});

describe("QuestionOutputSchema", () => {
  it("should validate a valid output with 2 questions", () => {
    const result = QuestionOutputSchema.parse({
      questions: ["Question one?", "Question two?"],
      isComplete: true,
    });
    expect(result.questions.length).toBe(2);
  });

  it("should validate a valid output with 5 questions", () => {
    const qs = Array.from({ length: 5 }, (_, i) => `Question ${i + 1}?`);
    const result = QuestionOutputSchema.parse({
      questions: qs,
      isComplete: false,
    });
    expect(result.questions.length).toBe(5);
  });

  it("should reject fewer than 2 questions", () => {
    expect(() =>
      QuestionOutputSchema.parse({
        questions: ["Only one?"],
        isComplete: true,
      })
    ).toThrow();
  });

  it("should reject more than 5 questions", () => {
    expect(() =>
      QuestionOutputSchema.parse({
        questions: Array.from({ length: 6 }, (_, i) => `Q ${i + 1}?`),
        isComplete: true,
      })
    ).toThrow();
  });

  it("should reject missing isComplete", () => {
    expect(() =>
      QuestionOutputSchema.parse({
        questions: ["Q1?", "Q2?"],
      })
    ).toThrow();
  });
});

describe("AssessmentOutputSchema", () => {
  it("should validate a valid assessment with 1 bias", () => {
    const result = AssessmentOutputSchema.parse({
      biases: [
        {
          name: "confirmation bias",
          explanation: "This is a detailed explanation of the bias with enough characters.",
          storyConnection: "This connects to the user's story with enough detail.",
          alternativePerspective: "An alternative way of viewing the situation with enough depth.",
        },
      ],
      reflectionPrompt: "Consider how confirmation bias might be affecting your decision-making process.",
    });
    expect(result.biases.length).toBe(1);
  });

  it("should reject empty biases array", () => {
    expect(() =>
      AssessmentOutputSchema.parse({
        biases: [],
        reflectionPrompt: "Some reflection prompt here.",
      })
    ).toThrow();
  });

  it("should reject reflectionPrompt shorter than 10 characters", () => {
    expect(() =>
      AssessmentOutputSchema.parse({
        biases: [
          {
            name: "test",
            explanation: "A detailed explanation with enough characters to pass validation.",
            storyConnection: "The connection to the story is described in detail here.",
            alternativePerspective: "An alternative way to view this situation with depth.",
          },
        ],
        reflectionPrompt: "short",
      })
    ).toThrow();
  });

  it("should validate multiple biases", () => {
    const bias = {
      name: "anchoring",
      explanation: "Detailed explanation about anchoring bias with enough chars.",
      storyConnection: "The story connection is described clearly with enough detail here.",
      alternativePerspective: "Alternative perspective with enough characters to explain clearly.",
    };
    const result = AssessmentOutputSchema.parse({
      biases: [bias, { ...bias, name: "confirmation bias" }],
      reflectionPrompt: "Reflect on how these biases may apply to your situation.",
    });
    expect(result.biases.length).toBe(2);
  });
});
