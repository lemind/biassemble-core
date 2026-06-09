/**
 * Local development entry point.
 * Starts the Fastify server on the configured port.
 * Not used in Vercel serverless — that uses api/index.ts → buildApp().
 */
import { buildApp } from "./server.js";
import { env } from "./lib/env.js";
import { logger } from "./observability/logger.js";

const server = buildApp();

async function start() {
  try {
    await server.listen({ port: env.PORT, host: "0.0.0.0" });
    logger.info({ port: env.PORT }, "server started");
  } catch (err) {
    logger.error(err, "failed to start server");
    process.exit(1);
  }
}

start();
