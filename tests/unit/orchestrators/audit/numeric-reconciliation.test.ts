import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  extractNumericFact,
  reconcileNumericVerdict,
  detectMagnitudeClaim,
  extractCurrentPriorPair,
  reconcileMagnitudeClaim,
  findNearestPassageFact,
} from "../../../../src/orchestrators/audit/verify.service.js";
import type { Claim } from "../../../../src/db/schema.js";

function makeClaim(claimText: string): Claim {
  return {
    claimId: randomUUID(),
    auditId: randomUUID(),
    type: "numeric",
    claimText,
    excerpt: claimText,
    locations: [],
    period: null,
    derived: false,
    passagesRetrievedCount: 1,
    retrievalStatus: "ok",
    verdict: null,
    evidence: null,
    sourceRefs: null,
    synthesized: null,
    confidence: null,
    note: null,
  } as Claim;
}

describe("extractNumericFact", () => {
  it("extracts currency with an explicit scale word", () => {
    expect(extractNumericFact("R&D investment totaled $640 million")).toEqual({ value: 640, unit: "USD", scale: "million" });
  });

  it("extracts currency with no scale word", () => {
    expect(extractNumericFact("Diluted EPS was $2.05 this quarter")).toEqual({ value: 2.05, unit: "USD", scale: null });
  });

  it("extracts a different scale word (billion)", () => {
    expect(extractNumericFact("cash totaled $1.28 billion")).toEqual({ value: 1.28, unit: "USD", scale: "billion" });
  });

  it("extracts percent when no $ is present", () => {
    expect(extractNumericFact("grew 28% year-over-year")).toEqual({ value: 28, unit: "percent", scale: null });
  });

  it("returns null when neither pattern matches", () => {
    expect(extractNumericFact("revenue grew nicely this quarter")).toBeNull();
  });

  it("real production incident (2026-07-29): parses accounting-negative parens as a negative value", () => {
    expect(extractNumericFact("Net loss was $(0.62) per diluted share")).toEqual({ value: -0.62, unit: "USD", scale: null });
  });

  it("parses accounting-negative parens with a scale word", () => {
    expect(extractNumericFact("Net loss was $(190.9) million")).toEqual({ value: -190.9, unit: "USD", scale: "million" });
  });
});

describe("reconcileNumericVerdict — accounting-negative parens (2026-07-29 EPS incident)", () => {
  it("upgrades a false 'supported' to 'contradicted' when claimed and cited EPS disagree under parens notation", () => {
    const claim = makeClaim("Net loss was $(0.62) per diluted share");
    const result = reconcileNumericVerdict(claim, {
      verdict: "supported",
      evidence: ["Diluted EPS was $(0.87) for the quarter"],
      note: "the cited evidence states $(0.87), which is different from the claimed $(0.62).",
    });
    expect(result.verdict).toBe("contradicted");
  });
});

describe("reconcileNumericVerdict — Fix 1 (bidirectional currency/percent check)", () => {
  it("real production incident: upgrades a false 'supported' to 'contradicted' on a scale mismatch ($640M claimed vs $64M evidence)", () => {
    const claim = makeClaim("R&D investment for the quarter totaled $640 million");
    const result = reconcileNumericVerdict(claim, {
      verdict: "supported",
      evidence: ["Research and development expense was $64 million for the third quarter"],
      note: "$64 million actual vs $640 million claimed — scale mismatch",
    });
    expect(result.verdict).toBe("contradicted");
    expect(result.note).toContain("upgraded from supported");
  });

  it("does NOT false-flag the same value written with two different scale words ($640M == $0.64B)", () => {
    const claim = makeClaim("cash and equivalents stood at $640 million at quarter-end");
    const result = reconcileNumericVerdict(claim, {
      verdict: "supported",
      evidence: ["Cash and equivalents totaled $0.64 billion as of quarter-end"],
      note: "matches",
    });
    expect(result.verdict).toBe("supported");
  });

  it("scale-ambiguity guard: does not act when only one side has an explicit scale word (avoids the false-positive the golden set relies on)", () => {
    // Mirrors the real verify-001-style shape: claim states "million" explicitly,
    // a compact evidence table gives a bare dollar figure with no scale word —
    // must NOT be treated as a raw-dollar mismatch.
    const claim = makeClaim("iPhone net sales rose to $56,994 million in the quarter");
    const result = reconcileNumericVerdict(claim, {
      verdict: "supported",
      evidence: ["iPhone $56,994 $46,841 22%"],
      note: "matches source table",
    });
    expect(result.verdict).toBe("supported"); // unchanged — ambiguous, not overridden
  });

  it("downgrades a false 'contradicted' to 'supported' on a genuine rounding near-miss (percent, within compare.ts's 0.1% relative tolerance)", () => {
    const claim = makeClaim("iPhone net sales rose 17% year-over-year");
    const result = reconcileNumericVerdict(claim, {
      verdict: "contradicted",
      evidence: ["iPhone grew 16.99% year-over-year"],
      note: "off by a rounding sliver",
    });
    expect(result.verdict).toBe("supported");
  });

  it("leaves a genuine, precise mismatch as 'contradicted' (verify-004 EPS case, now reachable since currency is recognized)", () => {
    const claim = makeClaim("Diluted earnings per share was $2.05 this quarter.");
    const result = reconcileNumericVerdict(claim, {
      verdict: "contradicted",
      evidence: ["Diluted $2.01 $1.65"],
      note: "source says $2.01",
    });
    expect(result.verdict).toBe("contradicted"); // real mismatch, correctly left alone
  });

  it("leaves partially_supported/unsupported/unverifiable untouched even with a numeric disagreement present", () => {
    const claim = makeClaim("R&D investment totaled $640 million");
    const result = reconcileNumericVerdict(claim, {
      verdict: "partially_supported",
      evidence: ["Research and development expense was $64 million"],
      note: "partial credit given for some other reason",
    });
    expect(result.verdict).toBe("partially_supported");
  });
});

describe("detectMagnitudeClaim", () => {
  it("matches 'more than doubling'", () => {
    expect(detectMagnitudeClaim("Revenue more than doubling year-over-year")).toEqual({ multiple: 2.0 });
  });

  it("matches 'more than tripled'", () => {
    expect(detectMagnitudeClaim("Profit more than tripled")).toEqual({ multiple: 3.0 });
  });

  it("returns null for non-magnitude claims", () => {
    expect(detectMagnitudeClaim("Revenue grew 22% year-over-year")).toBeNull();
  });
});

describe("extractCurrentPriorPair", () => {
  it("extracts the first two numbers from a compact evidence table", () => {
    expect(extractCurrentPriorPair("Total net sales $111,184 $95,359 17% $254,940 $219,659 16%")).toEqual([111184, 95359]);
  });

  it("returns null when fewer than two numbers are present", () => {
    expect(extractCurrentPriorPair("Total net sales $111,184")).toBeNull();
  });
});

describe("reconcileMagnitudeClaim — Fix 2 (T041b, ratio vs magnitude-phrase threshold)", () => {
  const evidence = ["Total net sales $111,184 $95,359 17% $254,940 $219,659 16%"];

  it("real production incident: 1.166x against a claimed 2.0x ('more than doubling') is 'contradicted', not 'supported'", () => {
    const claim = makeClaim("Apple's total net sales more than doubled from a year earlier.");
    const result = reconcileMagnitudeClaim(claim, { verdict: "supported", evidence, note: "$111,184 / $95,359 = 1.166, which is more than doubling" });
    expect(result.verdict).toBe("contradicted");
    expect(result.note).toContain("computed ratio");
  });

  it("boundary case: a ratio within 90% of the claimed multiple (1.9x vs 'doubled') is 'partially_supported', not 'contradicted'", () => {
    const claim = makeClaim("Revenue more than doubled from a year earlier.");
    const result = reconcileMagnitudeClaim(claim, {
      verdict: "supported",
      evidence: ["Revenue $190 $100 90%"], // 190/100 = 1.9x, 95% of the claimed 2.0x
      note: "looks about right",
    });
    expect(result.verdict).toBe("partially_supported");
  });

  it("a ratio at or above the claimed multiple is 'supported'", () => {
    const claim = makeClaim("Revenue more than doubled from a year earlier.");
    const result = reconcileMagnitudeClaim(claim, {
      verdict: "contradicted",
      evidence: ["Revenue $210 $100 110%"], // 210/100 = 2.1x, genuinely more than doubled
      note: "should be supported",
    });
    expect(result.verdict).toBe("supported");
  });

  it("does not touch unsupported/unverifiable verdicts", () => {
    const claim = makeClaim("Revenue more than doubled from a year earlier.");
    const result = reconcileMagnitudeClaim(claim, { verdict: "unsupported", evidence, note: "no evidence found" });
    expect(result.verdict).toBe("unsupported");
  });

  it("does not engage for claims with no magnitude phrase", () => {
    const claim = makeClaim("Revenue grew 22% year-over-year");
    const result = reconcileMagnitudeClaim(claim, { verdict: "supported", evidence, note: "matches" });
    expect(result.verdict).toBe("supported");
  });
});

describe("findNearestPassageFact — real production incident (2026-07-29, Allogene Therapeutics)", () => {
  // The actual submitted 8-K passage: one dense sentence with three dollar
  // figures for three different measures (net loss, EPS, cash), plus two
  // more sentences each with exactly one figure (assets, liabilities).
  const passages = [
    {
      text: "Allogene Therapeutics reports 2025 net loss of $190.9 million or $(0.87) per share, ends Q4 with $258.3 million cash and extends runway into Q1 2028. Total assets $415,905 thousand. Total liabilities $123,363 thousand.",
    },
  ];

  it("finds the net loss figure, not the nearer-in-string EPS or cash figures, via keyword proximity", () => {
    const snippet = findNearestPassageFact("Net loss narrowed to $143.2 million.", passages);
    expect(snippet).toContain("$190.9 million");
  });

  it("declines rather than guesses on the EPS-vs-aggregate-net-loss case — a genuine, accepted lexical ambiguity", () => {
    // "net"/"loss" sit closer to the wrong (aggregate) figure than "share"
    // sits to the right one — none of them are repeated words, so the
    // unique-keyword safety pass can't disambiguate this one either. Staying
    // silent here is the correct, safe outcome, not a bug: this is the one
    // real-incident case this heuristic knowingly cannot resolve.
    const snippet = findNearestPassageFact("Net loss was $(0.62) per diluted share.", passages);
    expect(snippet).toBeNull();
  });

  it("finds total assets in its own short sentence", () => {
    const snippet = findNearestPassageFact("Total assets stood at $389.5 million at year-end.", passages);
    expect(snippet).toContain("$415,905");
  });

  it("finds total liabilities in its own short sentence", () => {
    const snippet = findNearestPassageFact("Total liabilities stood at $97.8 million at year-end.", passages);
    expect(snippet).toContain("$123,363");
  });

  it("returns null for a claim with fewer than 2 measure keywords (too generic to anchor safely)", () => {
    expect(findNearestPassageFact("It was $5 million.", passages)).toBeNull();
  });

  it("returns null when no keyword appears in any passage", () => {
    expect(findNearestPassageFact("Marketing spend was $5 million.", passages)).toBeNull();
  });
});

describe("reconcileNumericVerdict — unsupported-to-contradicted fallback (2026-07-29 incident)", () => {
  const passages = [
    {
      text: "Allogene Therapeutics reports 2025 net loss of $190.9 million or $(0.87) per share, ends Q4 with $258.3 million cash and extends runway into Q1 2028. Total assets $415,905 thousand. Total liabilities $123,363 thousand.",
    },
  ];

  it("upgrades a same-period net loss conflict from unsupported to contradicted, with real evidence attached", () => {
    const claim = makeClaim("Net loss narrowed to $143.2 million.");
    const result = reconcileNumericVerdict(
      claim,
      { verdict: "unsupported", evidence: [], note: "The provided passages do not state the net loss as $143.2 million." },
      passages
    );
    expect(result.verdict).toBe("contradicted");
    expect(result.evidence).toBeTruthy();
    expect(result.evidence?.[0]).toContain("$190.9 million");
  });

  it("leaves the EPS claim unchanged (known, accepted limitation — ambiguous against the aggregate net loss figure in the same sentence)", () => {
    const claim = makeClaim("Net loss was $(0.62) per diluted share.");
    const result = reconcileNumericVerdict(
      claim,
      { verdict: "unsupported", evidence: [], note: "does not state $(0.62) per diluted share" },
      passages
    );
    expect(result.verdict).toBe("unsupported");
  });

  it("upgrades total assets and total liabilities conflicts", () => {
    const assetsClaim = makeClaim("Total assets stood at $389.5 million at year-end.");
    const assetsResult = reconcileNumericVerdict(
      assetsClaim,
      { verdict: "unsupported", evidence: [], note: "does not state total assets as $389.5 million" },
      passages
    );
    expect(assetsResult.verdict).toBe("contradicted");

    const liabilitiesClaim = makeClaim("Total liabilities stood at $97.8 million at year-end.");
    const liabilitiesResult = reconcileNumericVerdict(
      liabilitiesClaim,
      { verdict: "unsupported", evidence: [], note: "does not state total liabilities as $97.8 million" },
      passages
    );
    expect(liabilitiesResult.verdict).toBe("contradicted");
  });

  it("leaves unsupported unchanged when the fallback-found figure actually agrees (within tolerance)", () => {
    const claim = makeClaim("Total assets stood at $415.9 million at year-end.");
    const result = reconcileNumericVerdict(
      claim,
      { verdict: "unsupported", evidence: [], note: "does not state total assets as $415.9 million" },
      passages
    );
    expect(result.verdict).not.toBe("contradicted");
  });

  it("leaves unsupported unchanged when no passages are provided (existing behavior, no regression)", () => {
    const claim = makeClaim("Net loss narrowed to $143.2 million.");
    const result = reconcileNumericVerdict(claim, { verdict: "unsupported", evidence: [], note: "no evidence" });
    expect(result.verdict).toBe("unsupported");
  });

  it("leaves unsupported unchanged when the claim has no numeric figure to anchor on", () => {
    const claim = makeClaim("Management flagged substantial doubt about going concern.");
    const result = reconcileNumericVerdict(
      claim,
      { verdict: "unsupported", evidence: [], note: "does not mention going concern" },
      passages
    );
    expect(result.verdict).toBe("unsupported");
  });
});
