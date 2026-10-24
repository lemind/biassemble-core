# Quickstart: Choice of AI Provider and Bring-Your-Own Key

## Keys, then a check

1. Set `DEEPSEEK_API_KEY`, `QWEN_API_KEY`, and `QWEN_WORKSPACE_ID` (the Singapore workspace
   id, the host prefix) in the core project's environment, next to the existing Gemini key.
2. Run `npx tsx --env-file=.env scripts/check-provider-keys.ts`. All three must print ok.
3. A normal site check stays on Gemini. There is no provider control.

A comparison is not part of this slice. Do not build a report script. Do not curl the public check
and treat it as the reading: that route stores a production run. When the providers work, run the
existing evaluation job once per provider and read it by hand. That reading does not change the
own-key list.

## Try a provider on the site

- Run a check without an own key. The form has no provider control, and the result says "Checked
  with Gemini". The site can run Qwen or DeepSeek on its own keys, and that choice stays hidden.
- Choose **Use my own key**, pick Gemini, Qwen, or DeepSeek, paste a key, and run.
- A wrong key shows an error within 10 seconds, before the article is sent and before any claim is
  processed. The message names the problem. The check does not fall back to the site key.
