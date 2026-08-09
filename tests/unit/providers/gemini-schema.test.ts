import { describe, it, expect } from "vitest";
import { z } from "zod";
import { SchemaType } from "@google/generative-ai";
import { zodToGeminiSchema } from "../../../src/providers/gemini-schema.js";

describe("zodToGeminiSchema", () => {
  it("converts the real VERIFY response schema, including .nullable().optional().transform() fields (the real production case, 2026-08-09)", () => {
    const VerdictEnum = z.enum(["supported", "partially_supported", "unsupported", "contradicted", "unverifiable"]);
    const VerifyResultSchema = z.object({
      id: z.string(),
      verdict: VerdictEnum,
      evidence: z
        .string()
        .nullable()
        .optional()
        .transform((v) => v ?? null),
      reason: z
        .string()
        .nullable()
        .optional()
        .transform((v) => v ?? null),
      confidence: z.number().min(0).max(1),
    });
    const VerifyResponseSchema = z.object({ results: z.array(VerifyResultSchema) });

    const schema = zodToGeminiSchema(VerifyResponseSchema);

    expect(schema.type).toBe(SchemaType.OBJECT);
    expect(schema.required).toEqual(["results"]);
    const resultItem = schema.properties!.results!.items!;
    expect(resultItem.type).toBe(SchemaType.OBJECT);
    // id/verdict/confidence are required; evidence/reason are optional (dropped from `.optional()`).
    expect(resultItem.required).toEqual(["id", "verdict", "confidence"]);
    expect(resultItem.properties!.verdict).toEqual({ type: SchemaType.STRING, enum: VerdictEnum.options });
    // nullable().optional() collapses to nullable:true on the still-present property.
    expect(resultItem.properties!.evidence).toEqual({ type: SchemaType.STRING, nullable: true });
    expect(resultItem.properties!.confidence).toEqual({ type: SchemaType.NUMBER });
  });

  it("converts a simple flat object (the consistency-check response shape)", () => {
    const ConsistencyCheckResponseSchema = z.object({
      results: z.array(z.object({ id: z.string(), consistent: z.boolean() })),
    });

    const schema = zodToGeminiSchema(ConsistencyCheckResponseSchema);

    expect(schema).toEqual({
      type: SchemaType.OBJECT,
      required: ["results"],
      properties: {
        results: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            required: ["id", "consistent"],
            properties: {
              id: { type: SchemaType.STRING },
              consistent: { type: SchemaType.BOOLEAN },
            },
          },
        },
      },
    });
  });

  it("throws on an unsupported shape rather than silently producing a permissive schema", () => {
    // z.record has no fixed property set — not representable in Gemini's fixed `properties` map.
    expect(() => zodToGeminiSchema(z.record(z.string(), z.string()))).toThrow(/unsupported/i);
  });
});
