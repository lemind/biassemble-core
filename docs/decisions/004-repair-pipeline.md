# D004 — Repair Pipeline: JSON Repair → Fallback → Fail

**Decision**: All LLM output goes through: invalid JSON → regex/structural repair → Zod revalidate → fallback model call (if repair fails) → fail → 502. `repairWithFallback()` is the sole owner of LLM call recording — services never call `recordLlmCall()` directly.

**Why**: LLMs produce malformed JSON regularly. Repair handles common cases (trailing commas, missing quotes) without wasting a full LLM retry.

**Do not**: Skip repair and go straight to fallback.

**Source**: specs/001-reflection-core/plan.md, specs/001-reflection-core/architecture.md
