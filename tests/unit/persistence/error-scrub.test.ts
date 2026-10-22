import { describe, expect, it } from "vitest";
import { scrubErrorMessage } from "../../../src/persistence/error-scrub.js";

describe("scrubErrorMessage", () => {
  it("leaves a status line that has no key", () => {
    expect(scrubErrorMessage("HTTP 429")).toBe("HTTP 429");
    expect(scrubErrorMessage(null)).toBeNull();
  });

  it("drops a key echoed in an OpenAI-shaped 401 body", () => {
    const key = "sk-718b19a4ca734c818479eb2d52f655a7";
    const body = `Incorrect API key provided: ${key}.`;
    const stored = scrubErrorMessage(body);
    expect(stored).not.toContain(key);
    expect(stored).toContain("[REDACTED]");
  });

  it("drops a Qwen key and a Gemini key that are not in a query string", () => {
    const qwen = "sk-ws-H.DIMLIYY.fSwe.MEYCIQDexample";
    const gemini = "AIzaSyTESTKEYMATERIAL1234567890";
    const stored = scrubErrorMessage(`rejected ${qwen} and ${gemini}`);
    expect(stored).not.toContain(qwen);
    expect(stored).not.toContain(gemini);
  });
});
