import { describe, it, expect } from "vitest";
import { extractJson } from "../../../src/parsers/json-from-llm.js";

describe("extractJson", () => {
  it("should return clean JSON as-is", () => {
    const input = '{"hello": "world"}';
    expect(extractJson(input)).toBe(input);
  });

  it("should strip markdown code blocks with json tag", () => {
    const input = "```json\n{\"hello\": \"world\"}\n```";
    expect(extractJson(input)).toBe('{"hello": "world"}');
  });

  it("should strip markdown code blocks without tag", () => {
    const input = "```\n{\"hello\": \"world\"}\n```";
    expect(extractJson(input)).toBe('{"hello": "world"}');
  });

  it("should extract JSON when embedded in prose", () => {
    const input = "Here is the result: {\"name\": \"test\"}. Let me know.";
    expect(extractJson(input)).toBe('{"name": "test"}');
  });

  it("should extract array JSON from prose", () => {
    const input = 'Array: [1, 2, 3] is the answer.';
    expect(extractJson(input)).toBe('[1, 2, 3]');
  });

  it("should handle object inside array", () => {
    const input = '[{"a": 1}, {"b": 2}]';
    expect(extractJson(input)).toBe('[{"a": 1}, {"b": 2}]');
  });

  it("should handle no JSON structure", () => {
    const input = "Just plain text with no JSON";
    expect(extractJson(input)).toBe("Just plain text with no JSON");
  });

  it("should prefer first JSON object if both object and array exist", () => {
    const input = 'some text {"obj": 1} and then [1, 2]';
    expect(extractJson(input)).toBe('{"obj": 1}');
  });

  it("should handle leading/trailing whitespace", () => {
    const input = '  \n  {"key": "value"}  \n  ';
    expect(extractJson(input)).toBe('{"key": "value"}');
  });

  it("should handle nested JSON objects", () => {
    const input = '{"outer": {"inner": [1, 2, 3], "name": "test"}}';
    expect(extractJson(input)).toBe(input);
  });

  it("should handle empty string", () => {
    expect(extractJson("")).toBe("");
  });

  it("should handle string that starts with array bracket", () => {
    const input = '[{"questions": ["q1", "q2"], "isComplete": true}]';
    expect(extractJson(input)).toBe(input);
  });
});
