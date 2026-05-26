import pino from "pino";
import { env } from "../lib/env.js";

const isVercel = process.env.VERCEL === "1";

export const logger = pino({
  level: env.LOG_LEVEL,
  ...(isVercel
    ? {}
    : {
        transport:
          env.LOG_LEVEL === "info" || env.LOG_LEVEL === "debug"
            ? { target: "pino-pretty", options: { colorize: true } }
            : undefined,
      }),
  redact: ["GEMINI_API_KEY", "AI_CORE_API_KEY"],
});

export function childLogger(requestId: string) {
  return logger.child({ requestId });
}