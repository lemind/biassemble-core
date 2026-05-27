import { describe, it, expect } from "vitest";
import { generateRequestId } from "../../../src/lib/request-id.js";

describe("generateRequestId", () => {
  it("should generate a UUID string", () => {
    const id = generateRequestId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it("should generate unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateRequestId());
    }
    expect(ids.size).toBe(100);
  });
});
