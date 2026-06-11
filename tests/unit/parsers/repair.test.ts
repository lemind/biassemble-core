import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tryRepairJson } from "../../../src/parsers/repair.js";
import { repairWithFallback } from "../../../src/parsers/repair.js";

const TestSchema = z.object({
  name: z.string().min(1),
  value: z.number().int().positive(),
});

describe("tryRepairJson", () => {
  it("should parse clean JSON", () => {
    const input = '{"name": "test", "value": 42}';
    const result = tryRepairJson(input, TestSchema);
    expect(result).toEqual({ name: "test", value: 42 });
  });

  it("should strip markdown code blocks", () => {
    const input = "```json\n{\"name\": \"test\", \"value\": 42}\n```";
    const result = tryRepairJson(input, TestSchema);
    expect(result).toEqual({ name: "test", value: 42 });
  });

  it("should strip markdown code blocks without json tag", () => {
    const input = "```\n{\"name\": \"test\", \"value\": 42}\n```";
    const result = tryRepairJson(input, TestSchema);
    expect(result).toEqual({ name: "test", value: 42 });
  });

  it("should parse JSON embedded in prose", () => {
    const input = 'Here is the result: {"name": "test", "value": 42}. Please review.';
    const result = tryRepairJson(input, TestSchema);
    expect(result).toEqual({ name: "test", value: 42 });
  });

  it("should parse JSON with trailing text after close brace", () => {
    const input = '{"name": "test", "value": 42} and some more text after';
    const result = tryRepairJson(input, TestSchema);
    expect(result).toEqual({ name: "test", value: 42 });
  });

  it("should parse JSON with leading text before open brace", () => {
    const input = 'Explanation: {"name": "test", "value": 42}';
    const result = tryRepairJson(input, TestSchema);
    expect(result).toEqual({ name: "test", value: 42 });
  });

  it("should throw on invalid JSON with no structure", () => {
    const input = "not json at all";
    expect(() => tryRepairJson(input, TestSchema)).toThrow();
  });

  it("should recover valid fields on schema validation failure", () => {
    const input = '{"name": "test", "value": "not-a-number"}';
    const result = tryRepairJson(input, TestSchema);
    expect(result.name).toBe("test");
    expect(result.value).toBeNull();
  });

  it("should set null for missing fields", () => {
    const input = '{"name": "test"}';
    const result = tryRepairJson(input, TestSchema);
    expect(result.name).toBe("test");
    expect(result.value).toBeNull();
  });

  it("should handle extra fields gracefully", () => {
    const input = '{"name": "test", "value": 42, "extra": "field"}';
    const result = tryRepairJson(input, TestSchema);
    expect(result).toEqual({ name: "test", value: 42 });
  });

  it("should handle nested JSON objects in prose", () => {
    const input = 'Some text {"name": "nested", "value": 5} and done.';
    const result = tryRepairJson(input, TestSchema);
    expect(result).toEqual({ name: "nested", value: 5 });
  });

  it("should handle empty string", () => {
    expect(() => tryRepairJson("", TestSchema)).toThrow();
  });
});

describe("partialParseObject — field-by-field recovery", () => {
  it("should normalize snake_case fields before parsing", () => {
    const SnakeSchema = z.object({
      reasoningTrace: z.string(),
      noBiasDetected: z.boolean(),
    });
    const input = '{"reasoning_trace": "some data", "no_bias_detected": true}';
    const result = tryRepairJson(input, SnakeSchema);
    expect(result.reasoningTrace).toBe("some data");
    expect(result.noBiasDetected).toBe(true);
  });

  it("should return full result when no fields fail", () => {
    const input = '{"name": "ok", "value": 7}';
    const result = tryRepairJson(input, TestSchema);
    expect(result).toEqual({ name: "ok", value: 7 });
  });
});

describe("repairWithFallback", () => {
  it("should succeed on first try with clean JSON", async () => {
    const fallbackProvider = async () => {
      throw new Error("should not be called");
    };
    const input = '{"name": "success", "value": 1}';
    const result = await repairWithFallback(input, TestSchema, fallbackProvider);
    expect(result).toEqual({ name: "success", value: 1 });
  });

  it("should call fallback when repair fails on invalid JSON", async () => {
    let fallbackCalled = false;
    const fallbackProvider = async () => {
      fallbackCalled = true;
      return { name: "fallback", value: 99 };
    };
    const input = "not valid json at all";
    const result = await repairWithFallback(input, TestSchema, fallbackProvider);
    expect(fallbackCalled).toBe(true);
    expect(result).toEqual({ name: "fallback", value: 99 });
  });

  it("should throw when both repair and fallback fail", async () => {
    const fallbackProvider = async () => {
      throw new Error("fallback also failed");
    };
    const input = "totally invalid";
    await expect(
      repairWithFallback(input, TestSchema, fallbackProvider)
    ).rejects.toThrow("Failed to produce valid output after repair and fallback");
  });

  it("should throw when no fallback provider is given and repair fails", async () => {
    const input = "nonsense data";
    await expect(
      repairWithFallback(input, TestSchema, null)
    ).rejects.toThrow("Failed to produce valid output after repair and fallback");
  });

  it("should succeed with prose-wrapped JSON and fallback available", async () => {
    const fallbackProvider = async () => {
      throw new Error("should not be called since repair works");
    };
    const input = 'Analysis: {"name": "prose", "value": 7} End.';
    const result = await repairWithFallback(input, TestSchema, fallbackProvider);
    expect(result).toEqual({ name: "prose", value: 7 });
  });

  it("should succeed with markdown wrapped JSON and fallback available", async () => {
    const fallbackProvider = async () => {
      throw new Error("should not be called since repair works");
    };
    const input = "```json\n{\"name\": \"md\", \"value\": 3}\n```";
    const result = await repairWithFallback(input, TestSchema, fallbackProvider);
    expect(result).toEqual({ name: "md", value: 3 });
  });
});
