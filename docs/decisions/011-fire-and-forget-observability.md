# D011 — Fire-and-Forget for Observability Recording

**Decision**: `recordLlmCall()` failures must never break the main flow. Wrap in try/catch, log errors but never propagate.

**Why**: Observability is a side effect, not a critical path. If the recording DB is down, the assessment must still succeed.

**Do not**: Await recording in the hot path. Let recording errors propagate. Test the guarantee explicitly — mock a DB failure and verify the main flow still returns success.

**Source**: specs/003-observability-reliability/plan.md, .skills/llm-pipeline.md
