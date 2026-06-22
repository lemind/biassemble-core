# Zod Contracts Skill

Load this when working with validation schemas, type contracts, or API boundaries.

## Core Rules

- **All LLM outputs validated through Zod** before use
- **PromptVersion** is a branded type: `z.string().min(1).brand("PromptVersion")`
- **Nullable DB columns**: Use `field: Type | null`, not `field?: Type`
- **AssessmentResponse** is in `reflection.schemas.ts`, NOT in `reasoning.schemas.ts`

## Evidence Validation

- **EvidenceEntry**: Minimum length 1 on `excerpt` field
- **EvidenceMapping.evidence**: Minimum length 1 — empty array is invalid

## Schema Locations

- `src/contracts/reflection.schemas.ts` — AssessmentOutput, QuestionOutput, request/response schemas
- `src/contracts/reasoning.schemas.ts` — ReasoningTrace, Interpretation, BiasHypothesis

## Type Extraction

```typescript
// Extract TypeScript type from Zod schema
export type AssessmentOutput = z.infer<typeof AssessmentOutputSchema>;
```

## Validation at Boundaries

- **API routes**: Parse request body with Zod schema
- **LLM outputs**: Validate with Zod before processing
- **DB reads**: Trust the schema (DB enforces constraints)

## Common Pitfalls

- Don't use `z.any()` — use `z.unknown()` and narrow
- Don't use optional `?` for nullable DB fields — use `| null`
- Don't skip validation "for performance" — validate at boundaries only
