import type { FastifyInstance } from "fastify";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { logger } from "../observability/logger.js";
import { createGrounnelMcpServer } from "../mcp/server.js";
import type { StartToolDeps } from "../mcp/tools/start.js";
import type { ReadToolDeps } from "../mcp/tools/read.js";

const MODULE = "routes-mcp";
// Browser-originated calls are refused: no site of ours calls /mcp from a page (contracts/mcp-tools.md).
const ALLOWED_ORIGINS = new Set<string>();

/** POST /mcp: stateless MCP over HTTP, outside authHook like /assessment/:token (D034 §7). */
export function registerMcpRoute(server: FastifyInstance, deps: StartToolDeps & ReadToolDeps): void {
  const handler = createMcpHandler(() => createGrounnelMcpServer(deps));

  server.post("/mcp", async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin === "string" && !ALLOWED_ORIGINS.has(origin)) {
      return reply.status(403).send({ error: "origin not allowed" });
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (name === "content-length" || value === undefined) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const webRequest = new Request(`https://${request.hostname}${request.url}`, {
      method: "POST",
      headers,
      body: JSON.stringify(request.body ?? null),
    });

    let response: Response;
    try {
      response = await handler.fetch(webRequest);
    } catch (err) {
      // Never the headers: they carry the provider key.
      logger.error({ module: MODULE, operation: "POST /mcp", requestId: request.id, err }, "MCP handler threw");
      return reply.status(500).send({ error: "internal error" });
    }
    reply.status(response.status);
    response.headers.forEach((value, name) => reply.header(name, value));
    return reply.send(await response.text());
  });

  // Stateless server: no standalone stream to open and no session to end (2026-07-28).
  for (const method of ["GET", "DELETE"] as const) {
    server.route({ method, url: "/mcp", handler: async (_request, reply) => reply.status(405).header("Allow", "POST").send({ error: "method not allowed" }) });
  }
}
