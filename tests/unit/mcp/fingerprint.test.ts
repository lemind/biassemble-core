import { describe, it, expect } from "vitest";
import { keyHmac, textHmac } from "../../../src/mcp/fingerprint.js";

const SECRET = "s".repeat(64);

describe("MCP fingerprints", () => {
  it("is stable for the same input", () => {
    expect(keyHmac(SECRET, "qwen", "sk-1")).toBe(keyHmac(SECRET, "qwen", "sk-1"));
    expect(textHmac(SECRET, "Paris is in France.")).toBe(textHmac(SECRET, "Paris is in France."));
  });

  it("separates providers and the two purposes", () => {
    expect(keyHmac(SECRET, "qwen", "sk-1")).not.toBe(keyHmac(SECRET, "deepseek", "sk-1"));
    expect(keyHmac(SECRET, "qwen", "x")).not.toBe(textHmac(SECRET, "qwen:x"));
  });

  it("never contains the key", () => {
    expect(keyHmac(SECRET, "qwen", "sk-secret-value")).not.toContain("sk-secret-value");
  });

  it("throws without a secret", () => {
    expect(() => keyHmac(undefined, "qwen", "sk-1")).toThrow("MCP_HMAC_SECRET");
    expect(() => textHmac("", "t")).toThrow("MCP_HMAC_SECRET");
  });
});
