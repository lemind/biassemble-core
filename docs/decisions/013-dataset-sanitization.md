# D013 — Dataset Sanitization

**Decision**: All evaluation dataset files must pass `pnpm eval:sanitize` before commit. No 10+ digit sequences, no email addresses in evaluation files.

**Why**: Evaluation files are committed to the repo. Real tracking numbers or PII in test data are a privacy and credibility risk.

**Do not**: Commit evaluation files without running sanitize script. Use real tracking numbers, emails, or phone numbers in stories.

**Source**: scripts/sanitize-evals.ts, evaluations/no_bias/reflection/post-office.json
