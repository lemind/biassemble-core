/**
 * Emergency switch for MCP starts (spec 021 FR-014b, D034 §6). Reads keep working either way.
 * Needs the production Upstash credentials in the environment.
 *
 * Usage: npx tsx --env-file=.env scripts/mcp-starts.ts on|off|status
 */

import { Redis } from "@upstash/redis";
import { upstashRedisConfig } from "../src/lib/env.js";
import { MCP_STARTS_DISABLED_KEY, mcpStartsDisabled } from "../src/mcp/switch.js";

const command = process.argv[2];
if (!upstashRedisConfig) {
  console.error("Upstash Redis credentials are not set.");
  process.exit(1);
}
const redis = new Redis({ ...upstashRedisConfig, automaticDeserialization: false });

if (command === "off") await redis.set(MCP_STARTS_DISABLED_KEY, "1");
else if (command === "on") await redis.del(MCP_STARTS_DISABLED_KEY);
else if (command !== "status") {
  console.error("Usage: mcp-starts.ts on|off|status");
  process.exit(1);
}
console.log((await mcpStartsDisabled(redis)) ? "MCP starts: OFF" : "MCP starts: on");
