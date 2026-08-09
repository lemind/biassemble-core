import { z, type ZodTypeAny } from "zod";
import { SchemaType, type Schema } from "@google/generative-ai";

/**
 * Converts a Zod schema to Gemini's native `responseSchema` format, so the API constrains token
 * generation to match the shape directly — not a prompt-text request the model can drift from.
 * Real production case (2026-08-09): VERIFY returned a bare JSON array instead of the requested
 * `{results: [...]}` wrapper, 3/3 retry attempts, discarding a whole batch of otherwise-correct
 * verdicts. Prompt wording alone can't fix a probabilistic failure; this makes the wrong shape
 * structurally unproducible.
 *
 * Built on Zod's own `toJSONSchema` (not a hand-rolled walk of Zod internals) with `io: "input"` —
 * describes the shape BEFORE `.transform()` runs, which is what the model actually has to produce.
 * Only the small, mechanical JSON-Schema -> Gemini-Schema mapping below is our own code.
 */
export function zodToGeminiSchema(schema: ZodTypeAny): Schema {
  const jsonSchema = z.toJSONSchema(schema, { io: "input" }) as JsonSchemaNode;
  return convert(jsonSchema);
}

interface JsonSchemaNode {
  type?: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  required?: string[];
  enum?: unknown[];
  anyOf?: JsonSchemaNode[];
  additionalProperties?: unknown;
}

const TYPE_MAP: Record<string, SchemaType> = {
  string: SchemaType.STRING,
  number: SchemaType.NUMBER,
  integer: SchemaType.INTEGER,
  boolean: SchemaType.BOOLEAN,
};

function convert(node: JsonSchemaNode): Schema {
  // Draft 2020-12's nullable idiom (no bare `nullable` keyword like OpenAPI 3.0 has):
  // anyOf: [{type: X}, {type: "null"}]. Collapse to Gemini's own `nullable: true`.
  if (node.anyOf && node.anyOf.length === 2) {
    const nullBranch = node.anyOf.find((b) => b.type === "null");
    const otherBranch = node.anyOf.find((b) => b.type !== "null");
    if (nullBranch && otherBranch) {
      return { ...convert(otherBranch), nullable: true };
    }
  }

  if (node.type === "object") {
    // z.record()-shaped: an open dictionary, no fixed key set — Gemini's `properties` is a fixed
    // map, so this genuinely can't be represented, not just "an empty object."
    if (!node.properties && node.additionalProperties) {
      throw new Error(`zodToGeminiSchema: unsupported JSON Schema node (open-ended record, no fixed properties) — ${JSON.stringify(node)}`);
    }
    const properties: Record<string, Schema> = {};
    for (const [key, value] of Object.entries(node.properties ?? {})) {
      properties[key] = convert(value);
    }
    return { type: SchemaType.OBJECT, properties, required: node.required ?? [] };
  }

  if (node.type === "array") {
    // No `items` means an untyped array — Gemini requires `items`, string is the closest sane default.
    return { type: SchemaType.ARRAY, items: node.items ? convert(node.items) : { type: SchemaType.STRING } };
  }

  if (node.type && TYPE_MAP[node.type]) {
    const result: Schema = { type: TYPE_MAP[node.type] };
    if (node.enum) result.enum = node.enum as string[];
    return result;
  }

  // Fail loud, not silently permissive (AGENTS.md #5/Forbidden — no silent failures) — an
  // unsupported shape here means the response constraint would be wrong, worse than no constraint.
  throw new Error(`zodToGeminiSchema: unsupported JSON Schema node — ${JSON.stringify(node)}`);
}
