import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NO_BIAS_DIR = resolve(__dirname, "..", "..", "..", "evaluations", "no_bias", "reflection");

interface NoBiasStory {
  id: string;
  title: string;
  story: string;
  isNoBias: boolean;
  confidenceThreshold: number;
  tags: string[];
}

describe("T507 — no_bias dataset format", () => {
  const files = readdirSync(NO_BIAS_DIR).filter((f) => f.endsWith(".json"));

  it("should contain at least 10 stories", () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it.each(files)("file %s should have valid structure", (file) => {
    const raw = readFileSync(resolve(NO_BIAS_DIR, file), "utf-8");
    const story: NoBiasStory = JSON.parse(raw);

    expect(story).toHaveProperty("id");
    expect(typeof story.id).toBe("string");
    expect(story.id.length).toBeGreaterThan(0);

    expect(story).toHaveProperty("title");
    expect(typeof story.title).toBe("string");

    expect(story).toHaveProperty("story");
    expect(typeof story.story).toBe("string");
    expect(story.story.length).toBeGreaterThan(50);

    expect(story).toHaveProperty("isNoBias");
    expect(story.isNoBias).toBe(true);

    expect(story).toHaveProperty("confidenceThreshold");
    expect(typeof story.confidenceThreshold).toBe("number");
    expect(story.confidenceThreshold).toBeGreaterThan(0);
    expect(story.confidenceThreshold).toBeLessThanOrEqual(1);

    expect(story).toHaveProperty("tags");
    expect(Array.isArray(story.tags)).toBe(true);
    expect(story.tags.length).toBeGreaterThan(0);
  });

  it("should have unique ids across all files", () => {
    const ids = files.map((f) => {
      const raw = readFileSync(resolve(NO_BIAS_DIR, f), "utf-8");
      return JSON.parse(raw).id;
    });
    expect(new Set(ids).size).toBe(ids.length);
  });
});