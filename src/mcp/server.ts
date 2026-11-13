import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { handleStartFactCheck, type StartToolDeps } from "./tools/start.js";
import { handleGetFactCheck, type ReadToolDeps } from "./tools/read.js";

// FR-008/FR-013: what the assistant is told before it sends anything (D034 §2).
const START_DESCRIPTION = [
  "Starts a fact-check of a text and returns at once with a share token; read the result with get_fact_check after readAfterSeconds.",
  "The text goes to the model provider chosen in the connection settings, using the user's own key, for claim extraction and verification.",
  "Grounnel also uses its own Google (Gemini) and Tavily accounts to search for and fetch sources.",
  "The text and the results are published at a permanent link anyone with it can open.",
  "Confirm with the user before checking anything sensitive. A check takes up to a few minutes.",
  "Generate a unique requestToken for each new check. If the start call times out and you retry that same check, reuse the same token and the exact same text. Never reuse a token for a different check.",
].join(" ");

const READ_DESCRIPTION =
  "Reads a fact-check started with start_fact_check: status, each claim with its verdict, confidence, reason, sources and cited sentences. " +
  "While status is running, read again after readAfterSeconds. A failed check, or one the provider stopped early (failureReason set), still returns every finished claim.";

// Permissive on purpose: the SDK answers a schema failure with its own generic error, so the handlers check lengths and patterns (D034 §7).
const startInput = z.object({ text: z.string(), requestToken: z.string().optional() });
const readInput = z.object({ shareToken: z.string() });

const startOutput = z.object({
  shareToken: z.string(),
  shareUrl: z.string(),
  status: z.enum(["running", "done"]),
  phase: z.enum(["extracting", "verifying"]).nullable(),
  claimsFound: z.number().int(),
  readAfterSeconds: z.number().int().nullable(),
});

const readOutput = z.object({
  status: z.enum(["running", "done", "failed"]),
  phase: z.enum(["extracting", "verifying"]).nullable(),
  progress: z.object({ finished: z.number().int(), total: z.number().int().nullable() }),
  readAfterSeconds: z.number().int().nullable(),
  failureReason: z.string().nullable(),
  provider: z.string(),
  model: z.string().nullable(),
  capHit: z.boolean(),
  counts: z.record(z.string(), z.number()).nullable(),
  tokens: z.object({ input: z.number(), output: z.number() }).nullable(),
  shareUrl: z.string(),
  claims: z.array(
    z.object({
      text: z.string(),
      status: z.enum(["done", "failed"]),
      verdict: z.string().nullable(),
      confidence: z.number().nullable(),
      reason: z.string().nullable(),
      sources: z.array(z.record(z.string(), z.unknown())),
      citations: z.array(z.record(z.string(), z.unknown())),
    })
  ),
});

/** One server per request (stateless). The handlers read the connection headers from the HTTP request, never from arguments. */
export function createGrounnelMcpServer(deps: StartToolDeps & ReadToolDeps): McpServer {
  const server = new McpServer({ name: "grounnel", version: "1.0.0" });

  server.registerTool(
    "start_fact_check",
    {
      title: "Start a fact-check",
      description: START_DESCRIPTION,
      inputSchema: startInput,
      outputSchema: startOutput,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, ctx) => handleStartFactCheck(args, ctx.http?.req?.headers, deps)
  );

  server.registerTool(
    "get_fact_check",
    {
      title: "Read a fact-check",
      description: READ_DESCRIPTION,
      inputSchema: readInput,
      outputSchema: readOutput,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => handleGetFactCheck(args, deps)
  );

  return server;
}
