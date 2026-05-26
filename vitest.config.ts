import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    env: {
      GEMINI_API_KEY: "test-key",
      GEMINI_MODEL: "gemini-2.0-flash",
      AI_CORE_API_KEY: "dev-secret-change-me",
      PORT: "3001",
      AI_TIMEOUT_MS: "10000",
      AI_MAX_RETRIES: "3",
      LOG_LEVEL: "error",
    },
    include: ["tests/**/*.test.ts"],
  },
});
