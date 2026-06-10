import type { FastifyRequest, FastifyReply } from "fastify";
import { env } from "./env";

const BEARER_PREFIX = "Bearer ";

export async function authHook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
    reply.status(401).send({ error: "Missing or invalid authorization header" });
    return;
  }

  const token = authHeader.slice(BEARER_PREFIX.length);
  if (token !== env.AI_CORE_API_KEY) {
    reply.status(401).send({ error: "Invalid API key" });
    return;
  }
}