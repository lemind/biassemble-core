import { defineConfig } from "drizzle-kit";
import { readFileSync } from "node:fs";

// Load .env manually — drizzle-kit does not auto-load it
const envFile = readFileSync(".env", "utf-8");
for (const line of envFile.split("\n")) {
  const [key, ...rest] = line.split("=");
  if (key && !key.startsWith("#")) {
    const value = rest.join("=").replace(/^"|"$/g, "");
    if (value) process.env[key.trim()] ??= value;
  }
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  schemaFilter: ["core"],
  dbCredentials: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "",
  },
});
