import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { GROUNNEL_JUDGING_STAGES, ownKeyTokensForRun, publishOwnKeyTokens, sumJudgingTokenRows } from "../../../src/lib/own-key-tokens.js";

describe("sumJudgingTokenRows (T2018)", () => {
  it("sums extract and verify, drops discovery, and treats null cells as zero", () => {
    expect(GROUNNEL_JUDGING_STAGES).toEqual(["extract", "verify"]);
    expect(sumJudgingTokenRows([
      { stage: "extract", inputTokens: 100, outputTokens: null },
      { stage: "verify", inputTokens: null, outputTokens: 7 },
      { stage: "verify", inputTokens: 20, outputTokens: 3 },
      { stage: "discovery", inputTokens: 999, outputTokens: 999 },
    ])).toEqual({ input: 120, output: 10 });
  });

  it("is null for a site-paid run and for an own-key run that has not finished", () => {
    const totals = { input: 5, output: 1 };
    expect(ownKeyTokensForRun("site", "done", totals)).toBeNull();
    expect(ownKeyTokensForRun(undefined, "done", totals)).toBeNull();
    expect(ownKeyTokensForRun("own", "verifying", totals)).toBeNull();
    expect(ownKeyTokensForRun("own", "extracting", totals)).toBeNull();
    expect(ownKeyTokensForRun("own", "done", null)).toBeNull();
    expect(ownKeyTokensForRun("own", "done", totals)).toEqual(totals);
    expect(ownKeyTokensForRun("own", "failed", totals)).toEqual(totals);
  });

  it("the judging-token query uses the same stage list and coalesces nulls", () => {
    const src = readFileSync(fileURLToPath(new URL("../../../src/db/queries.ts", import.meta.url)), "utf8");
    const start = src.indexOf("export async function sumGrounnelJudgingTokens");
    const end = src.indexOf("export async function", start + 1);
    const fn = src.slice(start, end);
    expect(fn).toContain("GROUNNEL_JUDGING_STAGES");
    expect(fn).toContain("coalesce");
    expect(fn).not.toContain("discovery");
  });

  it("publish skips a site run and stores the sum for an own-key run", async () => {
    const sum = vi.fn().mockResolvedValue({ input: 8, output: 2 });
    const site = { hasOwnKey: vi.fn().mockResolvedValue(false), writeOwnKeyTokens: vi.fn() };
    await publishOwnKeyTokens("run-site", site, sum);
    expect(sum).not.toHaveBeenCalled();
    expect(site.writeOwnKeyTokens).not.toHaveBeenCalled();

    const own = { hasOwnKey: vi.fn().mockResolvedValue(true), writeOwnKeyTokens: vi.fn() };
    await publishOwnKeyTokens("run-own", own, sum);
    expect(sum).toHaveBeenCalledWith("run-own");
    expect(own.writeOwnKeyTokens).toHaveBeenCalledWith("run-own", 8, 2);

    sum.mockRejectedValue(new Error("db down"));
    await expect(publishOwnKeyTokens("run-own", own, sum)).resolves.toBeUndefined();
  });
});
