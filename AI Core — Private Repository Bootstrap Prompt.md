# Biassemble AI Core — Private Repository Bootstrap Prompt

Create a private AI-core repository for Biassemble.

Purpose:
Centralized proprietary AI orchestration and behavioral reasoning layer.

This repository contains:
- prompts
- evaluations
- provider orchestration
- scoring logic
- persuasion-analysis logic
- future behavioral intelligence systems

---

# Core Goals

Build reusable infrastructure for:
- cognitive bias analysis
- persuasion analysis
- rewrite systems
- confidence scoring
- AI evaluations
- provider benchmarking

---

# Architecture Requirements

## AI Layer
- provider abstraction
- structured JSON outputs
- retry handling
- deterministic parsing
- provider fallbacks

## Prompt System
- centralized registry
- versioning-ready
- isolated prompt modules
- provider-specific tuning support

## Evaluation System
- golden datasets
- regression checks
- benchmark utilities
- hallucination testing

## Scoring System
- confidence scoring
- consistency scoring
- persuasion scoring later

---

# Folder Structure

biassemble-ai-core/
├── prompts/
├── providers/
├── orchestrators/
├── evaluations/
├── datasets/
├── scoring/
├── parsers/
├── contracts/
├── tests/
├── scripts/
└── docs/

---

# Provider Requirements

Support:
- Anthropic
- Gemini
- OpenAI
- DeepSeek

Architecture must allow:
- adding/removing providers easily
- provider-specific optimizations
- dynamic routing later

---

# Important Constraints

DO NOT:
- implement fine-tuning yet
- implement vector DB yet
- implement RAG yet
- overengineer infrastructure
- create distributed systems

DO:
- keep architecture modular
- keep proprietary logic isolated
- make evaluation-first architecture
- support future monetization flows

---

# Deliverables

Generate:
- architecture draft
- provider abstraction draft
- prompt registry draft
- evaluation framework draft
- scoring module draft
- implementation roadmap
- ADR structure
- README
- env.example

This repository is intended to evolve iteratively using Spec Kit.