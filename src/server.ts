import Fastify from "fastify";
import { env } from "./lib/env.js";
import { requestIdHook } from "./lib/request-id.js";
import { logger } from "./observability/logger.js";

const server = Fastify({
  logger: false, // we use our own pino logger
});

// Global hooks
server.addHook("onRequest", requestIdHook);

// Health route
server.get("/health", async () => {
  return { status: "ok" };
});

// Start
const start = async () => {
  try {
    await server.listen({ port: env.PORT, host: "0.0.0.0" });
    logger.info({ port: env.PORT }, "server started");
  } catch (err) {
    logger.error(err, "failed to start server");
    process.exit(1);
  }
};

start();

export { server };