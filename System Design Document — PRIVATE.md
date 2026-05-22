# BIASSEMBLE AI CORE
## System Design Document — PRIVATE

---

# 1. Purpose

Private AI orchestration layer powering:
- cognitive bias analysis
- persuasion analysis
- future rewrite engine
- future behavioral scoring

This repository contains all proprietary logic.

---

# 2. Strategic Goal

Create reusable behavioral reasoning infrastructure.

This is the long-term moat.

---

# 3. Internal AI Modules

## Prompt Registry
Versioned prompts.

## Evaluation Engine
Golden datasets and regression checks.

## Confidence Engine
Output confidence normalization.

## Persuasion Engine
Commercial persuasion analysis.

## Provider Orchestrator
Smart provider routing.

---

# 4. AI Provider Strategy

| Provider | Role |
|---|---|
| Claude Sonnet | reasoning |
| Claude Haiku | cheap generation |
| Gemini Flash | low-cost scale |
| GPT-5 Mini | fallback/general |
| DeepSeek | experimentation |

---

# 5. Future Commercial Flows

## Persuasion Analyzer
Analyze:
- landing pages
- ads
- emails
- tweets
- product copy

Detect:
- scarcity
- authority bias
- social proof
- anchoring
- reciprocity

---

## Rewrite Engine
Input:
marketing copy.

Output:
more persuasive version.

---

# 6. Proprietary Assets

Protected:
- prompts
- datasets
- evaluation corpora
- scoring logic
- persuasion taxonomies
- confidence heuristics

---

# 7. Internal Architecture

Public App
→ API
→ Private AI Core
→ Provider Layer
→ LLM APIs

---

# 8. Risks

| Risk | Mitigation |
|---|---|
| prompt leakage | private repo |
| provider drift | evaluation suite |
| manipulative misuse | guardrails |
| generic outputs | datasets |

---

# 9. Open Questions

| Question | Priority |
|---|---|
| Do we need embeddings later? | medium |
| Should provider routing become dynamic? | medium |
| Do we need fine-tuning? | low |
| Which persuasion taxonomy should be canonical? | high |