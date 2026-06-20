# Testing Philosophy

See AGENTS.md for the one-paragraph testing rule. This document contains the full philosophy.

## Behavioral Testing Principles

**Test behavior, not schema.** A test that only verifies "field X exists and can be stored" is a type check, not a behavioral test. The real question is: "Does the system do the right thing when X happens?"

**Test the mapping logic, not just the storage.** When you implement error classification (e.g., `TimeoutError → status="timeout"`), test that the mapping actually happens. Don't just test that `status="timeout"` can be stored — test that throwing `TimeoutError` results in `status="timeout"` being recorded.

**Test the workflow, not just the components.** If your architecture says "primary call creates one row, fallback creates another row", test that the full workflow (primary fails → fallback succeeds → two rows exist) actually works. Component tests prove each piece works; integration tests prove they work together.

**Test edge cases that matter.** Null `rawResponse` when provider throws before returning. Different providers for primary vs fallback. Token usage present vs absent. These aren't just "nullable field" tests — they're tests of real failure modes.

**Example of weak test:**
```typescript
it("persists timeout status", async () => {
  const recorded = await store.recordCall({ status: "timeout", ... });
  expect(recorded.status).toBe("timeout");
});
```
This only proves the store can hold `status="timeout"`. It doesn't prove anything about error classification.

**Example of strong test:**
```typescript
it("maps TimeoutError to status=timeout", async () => {
  const provider = () => { throw new TimeoutError("timeout"); };
  await expect(executeAndRecordLlmCall(provider, ...)).rejects.toThrow();
  expect(recordedCalls[0].status).toBe("timeout");
  expect(recordedCalls[0].failureType).toBe("timeout");
});
```
This proves the critical mapping logic works end-to-end.

## Critical Guarantee Testing

**Test reliability guarantees explicitly.** When your system makes promises (fire-and-forget, graceful degradation, serialization correctness), test those promises directly.

**Fire-and-forget guarantee:** If recording failures must not break the main flow, test that explicitly:
```typescript
it("does not fail provider call when recordLlmCall throws", async () => {
  vi.spyOn(queries, "recordLlmCall").mockRejectedValueOnce(new Error("DB failed"));
  const { result } = await executeAndRecordLlmCall(mockProvider, ...);
  expect(result).toEqual({ data: "success" }); // Main flow succeeded despite recording failure
});
```

**Serialization correctness:** If you serialize data (JSON.stringify, etc.), test the actual output format:
```typescript
it("serializes raw response as JSON string, not [object Object]", async () => {
  // ... provider returns { foo: "bar" }
  expect(recordedCalls[0].rawResponse).toBe('{"foo":"bar"}');
  expect(recordedCalls[0].rawResponse).not.toContain("[object Object]");
});
```

**Timing calculations:** If you compute durations, test the calculation:
```typescript
it("calculates durationMs from provider call timing", async () => {
  // ... provider takes 50ms
  expect(recordedCalls[0].durationMs).toBeGreaterThanOrEqual(40);
  expect(recordedCalls[0].durationMs).toBeLessThan(200);
});
```

## Weak Test Patterns to Avoid

**"Store can hold data" tests:** Tests that only prove a store can persist data with certain field values are low-value. They test the store implementation, not your business logic.

**Manual workflow tests:** If you manually call `execute(primary)` then `execute(fallback)` and check that two rows exist, you're not testing the fallback workflow — you're testing that the function can be called twice. Real workflow tests should trigger the actual decision logic.

**Redundant field tests:** If you already tested that a field can be stored (via round-trip test), you don't need separate tests for each possible value unless there's specific logic that produces that value.

## Test Criteria (Persistence & Eval Ports)

Tests must verify behavior, not just interface presence. A store that returns `null` from every method must fail.

1. **Round-trip persistence** — Every `recordCall` / `persistResult` write must be readable back via the corresponding read method, with `id` and `createdAt` present.
2. **Filtering correctness** — Queries by session, stage, or provider must return only matching records and exclude others.
3. **Ordering determinism** — Query results must be sorted by `createdAt` (ascending or descending, as documented) — consumers depend on stable ordering.
4. **Schema & field validation** — Persisted records must include all required fields (`id`, `createdAt`, provider, etc.). Invalid or malformed input must be rejected with a clear error.
5. **Evidence validation contract** — Evidence entries must carry `validation_status`. Only validated evidence counts toward `evidenceGroundedRate` in aggregates.
6. **Aggregate computation** — `getEvalRunAggregates` must return correct counts, averages, and pass/fail rates for a given eval run. Test with seeded data.
7. **Edge-case resilience** — Empty results, null fields, missing session IDs, duplicate submissions, and concurrent writes must not corrupt state or throw unhandled errors.
8. **Error handling** — DB failures, invalid inputs, and missing records must surface meaningful typed errors — never silent `null` swallows or untyped throws.
9. **Backward compatibility** — Schema changes must not break reads of previously persisted records. Migrations must preserve historical data.
10. **Integration with real DB** — At least one test per store must exercise actual Drizzle queries against a test Postgres instance (or equivalent), verifying SQL correctness.
