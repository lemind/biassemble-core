/** Present means MCP starts are off; reads keep working. Set and cleared by scripts/mcp-starts.ts (D034 §6). */
export const MCP_STARTS_DISABLED_KEY = "grounnel:mcp:starts-disabled";

export interface SwitchRedisClient {
  exists(key: string): Promise<number>;
}

/** Throws on a Redis error, so the caller fails closed. */
export async function mcpStartsDisabled(redis: SwitchRedisClient): Promise<boolean> {
  return (await redis.exists(MCP_STARTS_DISABLED_KEY)) > 0;
}
