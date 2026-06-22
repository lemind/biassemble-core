# D003 — `prompt_version` Stamped by Orchestrator

**Decision**: `prompt_version` is stamped AFTER parsing by the orchestrator. The LLM does NOT produce it. It is a branded Zod type on every reasoning trace step.

**Why**: Without `prompt_version`, eval results are unattributable across prompt iterations. The orchestrator is the authority on which prompt was used.

**Do not**: Ask the LLM to output `prompt_version`. Throw (not warn) if missing on any reasoning trace step.

**Source**: specs/002-reasoning-infrastructure/spec.md (FR-014), .skills/llm-pipeline.md
