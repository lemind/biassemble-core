# Possible Enhancements (not in plan)

Ideas that came up during implementation but are **not** in the current plan. Documented here for future consideration — do not implement without plan update.

## Story-Reference Heuristic Improvements

The current `checkStoryReference()` in `scripts/eval-reflection.ts` uses a simple word-overlap heuristic (`.filter(w => w.length > 4)` to skip short words). Possible improvements:

- Use TF-IDF or embedding similarity instead of word overlap
- Use an LLM-as-judge to rate whether bias explanations reference the story
- Define "story-specific reference" more precisely in spec.md SC-005

## `pnpm-workspace.yaml`

Was added during Phase 3 but removed — not in plan. If monorepo structure is needed later, add to plan first.

## MockProvider Location

`tests/mocks/mock-provider.ts` was created for integration tests. It's not in any Phase 3 task (it's a Phase 2 concern). Consider whether it should be formalized in the plan.