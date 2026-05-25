import { randomUUID } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";

export function generateRequestId(): string {
  return randomUUID();
}

export async function requestIdHook(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const id = (request.headers["x-request-id"] as string) || generateRequestId();
  request.id = id;
  reply.header("x-request-id", id);
}