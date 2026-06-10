/**
 * Local development entry point.
 * Starts the Fastify server on the configured port.
 * Not used in Vercel serverless — that uses api/index.ts → buildApp().
 */
import { buildApp } from "./server";
import { env } from "./lib/env";
import { logger } from "./observability/logger";

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
