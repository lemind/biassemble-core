import type { FastifyRequest, FastifyReply } from "fastify";
import { env } from "./env.js";

export async function authHook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    reply.status(401).send({ error: "Missing or invalid authorization header" });
    return;
  }

  const token = authHeader.slice(7);
  if (token !== env.AI_CORE_API_KEY) {
    reply.status(401).send({ error: "Invalid API key" });
    return;
  }
}