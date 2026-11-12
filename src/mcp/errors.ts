import type { CallToolResult } from "@modelcontextprotocol/server";

/** Tool-level error codes from contracts/mcp-tools.md. Protocol errors stay with the SDK. */
export type McpErrorCode =
  | "key_required"
  | "provider_not_chosen"
  | "unsupported_provider"
  | "empty_text"
  | "text_too_large"
  | "invalid_request_token"
  | "token_conflict"
  | "in_progress"
  | "rate_limited"
  | "preflight_invalid_key"
  | "preflight_no_balance"
  | "preflight_provider_rate_limited"
  | "preflight_provider_unavailable"
  | "extraction_failed"
  | "service_unavailable"
  | "not_found";

export interface McpError {
  code: McpErrorCode;
  message: string;
  retryAfterSeconds: number | null;
}

/** An isError tool result carrying the same JSON as structured content and as text. */
export function mcpError(code: McpErrorCode, message: string, retryAfterSeconds: number | null = null): CallToolResult {
  const error: McpError = { code, message, retryAfterSeconds };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(error) }], structuredContent: { ...error } };
}

/** A successful tool result, structured content plus the same JSON as text. */
export function mcpResult(payload: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}
