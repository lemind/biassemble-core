# Quickstart: Choice of AI Provider and Bring-Your-Own Key

## Run the comparison (operator)

Evals run on the deployed system; the dev machine is region-blocked for Gemini.

1. Set `DEEPSEEK_API_KEY` and `QWEN_API_KEY` (plus the Qwen workspace id) in the core project's
   Vercel environment. These are the operator exception in FR-009. The eval job reads them
   in-process. It does not send `deepseek` or `qwen` through `POST /extract` without a key.
2. Deploy core, then trigger the golden set once per provider:
   `npx tsx scripts/trigger-eval-grounnel.ts --provider gemini` (repeat for `deepseek`, `qwen`).
3. Run the real texts the same way with `--texts`.
4. Build the report: `npx tsx --env-file=.env scripts/compare-providers.ts`. It scores with
   `evaluateGrounnelRun`, prints the side-by-side table, and writes the JSON for the Stats page.
5. Check SC-002: total model cost of the comparison is printed at the end.

Run DeepSeek off-peak (outside 01–04 and 06–10 UTC on weekdays) to halve its cost.

## Try a provider on the site

- Run a check without an own key. The form has no provider control, and the result says "Checked
  with Gemini".
- Choose **Use my own key**, pick Gemini, Qwen, or DeepSeek, paste a key, and run. A wrong key shows
  an error before any claim is processed.
