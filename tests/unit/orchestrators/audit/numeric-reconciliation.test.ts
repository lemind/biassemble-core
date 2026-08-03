import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  extractNumericFact,
  reconcileNumericVerdict,
  reconcileVerdictNoteConsistency,
  reconcileTemporalVerdict,
  reconcileDefinedTermVerdict,
  detectMagnitudeClaim,
  extractCurrentPriorPair,
  reconcileMagnitudeClaim,
  extractComparisonClaim,
  reconcileComparisonVerdict,
} from "../../../../src/orchestrators/audit/verify-reconcilers.js";
import type { Claim } from "../../../../src/db/schema.js";
import type { RetrievedPassage } from "../../../../src/rag/corpus-client.js";

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

  it("real production incident (2026-07-29): picks the EPS figure, not the net-loss figure, out of a multi-number evidence sentence", () => {
    // The original single-number test fixture above didn't exercise this shape — the real
    // audit run's evidence had both figures in one sentence, and a plain .match() always took
    // the first ($190.9 million, the aggregate net loss), not the $(0.87) EPS figure the claim
    // is actually comparable to. That wrong pick hit the scale-ambiguity guard and left the
    // LLM's wrong "supported" verdict unreconciled.
    const claim = makeClaim("Net loss was $(0.62) per diluted share.");
    const result = reconcileNumericVerdict(claim, {
      verdict: "supported",
      evidence: ["Allogene Therapeutics reports 2025 net loss of $190.9 million or $(0.87) per share"],
      note: "the passage states the net loss per share for 2025 was $(0.87)",
    });
    expect(result.verdict).toBe("contradicted");
    expect(result.note).toContain("-0.62");
    expect(result.note).toContain("-0.87");
  });

  it("stays unchanged when a multi-number evidence sentence has two candidates with the same scale-presence as the claim (genuinely ambiguous)", () => {
    // Both evidence numbers are scale-less, same as the claim — cannot disambiguate which is
    // "the" comparable figure, so must not guess.
    const claim = makeClaim("Net loss was $(0.62) per diluted share.");
    const result = reconcileNumericVerdict(claim, {
      verdict: "supported",
      evidence: ["EPS was $(0.87) under GAAP or $(0.91) non-GAAP"],
      note: "matches",
    });
    expect(result.verdict).toBe("supported");
  });
});

describe("reconcileVerdictNoteConsistency — Fix 3 (2026-07-29, generalizes VERDICT/NOTE CONSISTENCY beyond numeric claims)", () => {
  const evidence = ["The Company operates and manages its business as one reportable segment."];

  it("downgrades 'supported' to 'contradicted' when the note itself says the evidence contradicts the claim (entity claim, e.g. two-segments)", () => {
    const result = reconcileVerdictNoteConsistency({
      verdict: "supported",
      evidence,
      note: "The passages state that the company operates as a single reportable segment, which contradicts the claim of two reportable segments.",
    });
    expect(result.verdict).toBe("contradicted");
    expect(result.note).toContain("verdict overridden by code");
  });

  it("downgrades 'supported' to 'contradicted' when the note uses 'differs from' instead of 'contradicts'", () => {
    const result = reconcileVerdictNoteConsistency({
      verdict: "supported",
      evidence,
      note: "The cited figure differs from the value stated in the claim.",
    });
    expect(result.verdict).toBe("contradicted");
  });

  it("does NOT downgrade when the note uses negated contradiction language ('does not contradict')", () => {
    const result = reconcileVerdictNoteConsistency({
      verdict: "supported",
      evidence,
      note: "The passage confirms the claim and does not contradict it.",
    });
    expect(result.verdict).toBe("supported");
  });

  it("real bug found on review (2026-07-29): a real English contraction ('doesn't contradict') must be recognized as negated, not trigger a false downgrade", () => {
    // The negation regex's original "n't" alternative had a leading \b, which can never match
    // inside a real contraction — the 'n' in "doesn't" is preceded by a letter ('s'), not a word
    // boundary, so `\bn't` never matched and every standard negated contraction slipped through
    // as if it weren't negated at all.
    const result = reconcileVerdictNoteConsistency({
      verdict: "supported",
      evidence,
      note: "The passage doesn't contradict the claim, it merely restates it.",
    });
    expect(result.verdict).toBe("supported");
  });

  it("real bug found on review (2026-07-29): does not downgrade to 'contradicted' when evidence is null — never assign contradicted without evidence", () => {
    const result = reconcileVerdictNoteConsistency({
      verdict: "supported",
      evidence: null,
      note: "which contradicts the claim",
    });
    expect(result.verdict).toBe("supported");
  });

  it("does not touch verdicts other than 'supported'", () => {
    const result = reconcileVerdictNoteConsistency({
      verdict: "unsupported",
      evidence,
      note: "which contradicts the claim",
    });
    expect(result.verdict).toBe("unsupported");
  });

  it("leaves 'supported' unchanged when the note contains no contradiction language", () => {
    const result = reconcileVerdictNoteConsistency({
      verdict: "supported",
      evidence,
      note: "the passage states the same figure as the claim",
    });
    expect(result.verdict).toBe("supported");
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
    expect(result.note).toContain("verdict set by code");
    expect(result.confidence).toBe(1);
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

  it("real production incident (run 9, 2026-07-29): upgrades 'unverifiable' at confidence 0 to 'contradicted' at confidence 1 when a real, quoted, same-measure figure disagrees — compare.ts must run regardless of the model's raw verdict", () => {
    // A live deployed run showed four numeric claims (net loss, EPS, total assets, total
    // liabilities) whose own note named the real conflicting figure, but the raw verdict was
    // "unverifiable" at confidence 0 — never reaching this function under the old
    // supported/contradicted-only gate. This reproduces the total-assets shape verbatim.
    const claim = makeClaim("Total assets stood at $389.5 million at year-end.");
    const result = reconcileNumericVerdict(claim, {
      verdict: "unverifiable",
      evidence: ["Total assets stood at $415,905 thousand at year-end."],
      note: "the passages do not state that total assets stood at $389.5 million; they state $415,905 thousand",
      confidence: 0,
    });
    expect(result.verdict).toBe("contradicted");
    // Confidence must clear the gate threshold, or GateService (gate.service.ts) re-gates this
    // straight back to "unverifiable" and wipes evidence to null one pipeline stage later.
    expect(result.confidence).toBe(1);
  });

  it("also upgrades 'unsupported' (not just 'unverifiable') to 'contradicted' when evidence disagrees", () => {
    const claim = makeClaim("Total liabilities stood at $97.8 million at year-end.");
    const result = reconcileNumericVerdict(claim, {
      verdict: "unsupported",
      evidence: ["Total liabilities were $123,363 thousand at year-end."],
      note: "the passages state total liabilities were $123,363 thousand, not $97.8 million",
      confidence: 0.4,
    });
    expect(result.verdict).toBe("contradicted");
    expect(result.confidence).toBe(1);
  });

  it("also upgrades 'partially_supported' to 'supported' when the numbers actually agree", () => {
    const claim = makeClaim("R&D investment totaled $640 million");
    const result = reconcileNumericVerdict(claim, {
      verdict: "partially_supported",
      evidence: ["Research and development expense was $640 million"],
      note: "hedged for an unrelated reason",
      confidence: 0.5,
    });
    expect(result.verdict).toBe("supported");
    expect(result.confidence).toBe(1);
  });

  it("does not touch confidence or verdict when no comparable evidence is extractable (still trusts the LLM)", () => {
    const claim = makeClaim("R&D investment totaled $640 million");
    const result = reconcileNumericVerdict(claim, {
      verdict: "unsupported",
      evidence: null,
      note: "no evidence found",
      confidence: 0,
    });
    expect(result.verdict).toBe("unsupported");
    expect(result.confidence).toBe(0);
  });
});

function makePassage(text: string, passageId = randomUUID()): RetrievedPassage {
  return { passageId, docId: "doc1", location: null, text, rank: 1, score: 1 };
}

describe("reconcileNumericVerdict — passage fallback (2026-07-30, found on review of real A/B run data)", () => {
  it("real production shape: resolves an EPS claim by scanning retrieved passages directly when VERIFY's evidence is empty", () => {
    const claim = makeClaim("Net loss was $(0.62) per diluted share.");
    const passages = [
      makePassage("Allogene Therapeutics reports 2025 net loss of $190.9 million or $(0.87) per share, ends Q4 with $258.3 million cash and extends runway into Q1 2028."),
    ];
    const result = reconcileNumericVerdict(claim, { verdict: "unsupported", evidence: [], note: "no evidence", confidence: 1 }, passages);
    expect(result.verdict).toBe("contradicted");
    expect(result.evidence).toEqual([passages[0]!.text]);
    expect(result.sourceRefs).toEqual([passages[0]!.passageId]);
    expect(result.confidence).toBe(1);
  });

  it("real regression found on review (verify-009 scope trap): does NOT fire when a passage contains two percent values for different scopes — must not credit a segment's growth rate as if it were the consolidated total's", () => {
    // "Greater China ... 28% ..." (segment growth) vs "Total net sales ... 17%" (consolidated) —
    // both retrieved for a claim about the consolidated total. Percent has no scale-word signal
    // to disambiguate, so a passage with 2+ percent values must be skipped, not guessed at.
    const claim = makeClaim("Apple's total net sales grew 28% year-over-year this quarter.");
    const passages = [
      makePassage("Greater China 20,497 16,002 28% 46,023 34,515 33%"),
      makePassage("Total net sales $111,184 $95,359 17% $254,940 $219,659 16%"),
    ];
    const result = reconcileNumericVerdict(claim, { verdict: "contradicted", evidence: [], note: "no evidence", confidence: 1 }, passages);
    expect(result.verdict).toBe("contradicted"); // unchanged — must not flip to 'supported'
  });

  it("previously-accepted limitation, now CLOSED (2026-07-30): resolves a claim whose passage holds a second same-scale figure, via the measure label attached to each figure", () => {
    // Was pinned as a permanent gap: 190.9 (net loss) and 258.3 (cash) are both scale=million, so
    // scale-presence alone couldn't tell them apart and the whole passage was skipped — which is why
    // net loss/total assets/total liabilities all went silent across four consecutive real runs.
    // Now each figure carries the content-word label it sits behind, so "net loss" selects 190.9 and
    // excludes the cash figure. D018 §5.2.
    const claim = makeClaim("Net loss narrowed to $143.2 million.");
    const passages = [
      makePassage("Allogene Therapeutics reports 2025 net loss of $190.9 million or $(0.87) per share, ends Q4 with $258.3 million cash and extends runway into Q1 2028."),
    ];
    const result = reconcileNumericVerdict(claim, { verdict: "unsupported", evidence: [], note: "no evidence", confidence: 1 }, passages);
    expect(result.verdict).toBe("contradicted");
    expect(result.confidence).toBe(1);
  });

  it("does not engage when no passages are provided (default empty array, backward compatible)", () => {
    const claim = makeClaim("Net loss narrowed to $143.2 million.");
    const result = reconcileNumericVerdict(claim, { verdict: "unsupported", evidence: [], note: "no evidence", confidence: 1 });
    expect(result.verdict).toBe("unsupported");
  });
});

describe("reconcileNumericVerdict — real regression (2026-07-30, third A/B run confirmation): a truncated single-number evidence snippet blocks the passage fallback from ever running", () => {
  it("a lone, wrong-measure evidence snippet no longer short-circuits the passage scan that finds the right figure", () => {
    // Real A/B pair, same code, same claim, same passages: one run corrected this EPS claim to
    // `contradicted` (raw evidence was empty, so pickPassageFact ran and found the unambiguous
    // scale-null $(0.87) figure). The other run left it `unverifiable`, gated at confidence 0.
    // The only variable between runs is what the LLM chose to put in `evidence` — this reproduces
    // the losing shape: a single, truncated, WRONG-measure number ("$190.9 million", the net-loss
    // aggregate, not the per-share figure this claim is actually comparable to). pickEvidenceFact's
    // one-candidate branch trusts it without checking whether it's the right measure at all, then
    // the scale-mismatch guard bails out — and because an evidenceFact was "found" (unit matches),
    // the passage fallback below it is never even attempted, even though the same passages that
    // would have resolved this correctly are sitting right there, unused.
    const claim = makeClaim("Net loss was $(0.62) per diluted share.");
    const passages = [
      makePassage("Allogene Therapeutics reports 2025 net loss of $190.9 million or $(0.87) per share, ends Q4 with $258.3 million cash and extends runway into Q1 2028."),
    ];
    const result = reconcileNumericVerdict(
      claim,
      { verdict: "unverifiable", evidence: ["net loss of $190.9 million"], note: "no comparable figure found", confidence: 0 },
      passages
    );
    expect(result.verdict).toBe("contradicted");
    expect(result.confidence).toBe(1);
  });
});

describe("CANONICAL NUMERIC-CONFLICT GATE (2026-07-30) — the four real Allogene claims, asserted every run", () => {
  // Ten consecutive live runs disagreed with each other on these four. They are structurally
  // identical (claimed figure vs. a conflicting same-measure figure sitting in a retrieved passage),
  // so all four MUST be resolved deterministically by code, never left to whatever the LLM guessed.
  // Seeded with the worst raw shape a real run produced: evidence empty, confidence 0.
  // If any of these regress to silence, the numeric comparator is broken again. D018 §5.2.
  const BALANCE = "Total assets $415,905 thousand. Total liabilities $123,363 thousand.";
  const LIQUIDITY =
    "Allogene Therapeutics reports 2025 net loss of $190.9 million or $(0.87) per share, ends Q4 with $258.3 million cash and extends runway into Q1 2028.";

  const canonical = [
    { claim: "Total assets stood at $389.5 million at year-end.", period: "FY2025 year-end" },
    { claim: "Total liabilities stood at $97.8 million at year-end.", period: "FY2025 year-end" },
    { claim: "Net loss narrowed to $143.2 million.", period: "FY2025" },
    { claim: "Net loss was $(0.62) per diluted share.", period: "FY2025" },
  ];

  for (const { claim: claimText, period } of canonical) {
    it(`resolves to contradicted, tagged and at confidence 1: "${claimText}"`, () => {
      const claim = makeClaim(claimText);
      claim.period = period;
      const passages = [makePassage(BALANCE), makePassage(LIQUIDITY)];
      const result = reconcileNumericVerdict(claim, { verdict: "unverifiable", evidence: [], note: "n", confidence: 0 }, passages);

      expect(result.verdict).toBe("contradicted");
      expect(result.note).toContain("verdict set by code");
      // Confidence must clear GateService's threshold, or the override is wiped one stage later.
      expect(result.confidence).toBe(1);
      // "contradicted" is never allowed without evidence (data-model.md Verdict validation).
      expect(result.evidence?.length).toBeGreaterThan(0);
      expect(result.sourceRefs?.length).toBeGreaterThan(0);
    });
  }

  // The other half of the gate: claims whose measure appears in NO retrieved passage must stay
  // silent. Without these, the four assertions above could be "passed" by firing on everything.
  const mustStaySilent = [
    { claim: "Capital expenditures were $14.2 million.", period: "FY2025" },
    { claim: "Allogene Therapeutics closed FY2025 with total revenue of $12.4 million.", period: "FY2025" },
    { claim: "Net loss was $257.6 million in FY2024.", period: "FY2024" }, // passage covers FY2025 only
  ];

  for (const { claim: claimText, period } of mustStaySilent) {
    it(`stays silent (no false accusation): "${claimText}"`, () => {
      const claim = makeClaim(claimText);
      claim.period = period;
      const passages = [makePassage(BALANCE), makePassage(LIQUIDITY)];
      const result = reconcileNumericVerdict(claim, { verdict: "unverifiable", evidence: [], note: "n", confidence: 0 }, passages);

      expect(result.verdict).toBe("unverifiable");
      expect(result.note).not.toContain("verdict set by code");
    });
  }
});

describe("MULTI-ENTITY TABLE GATE (2026-07-30, Apple probe) — a row's figures belong to that row's subject", () => {
  // Live probe: "Americas net sales grew 12%" — verbatim correct — was returned `contradicted` at
  // confidence 1, cited against (17%, 16%) from the Total net sales row. Bigram labels could not form
  // for a single-word row name followed by digits, so only the generic "net sales" matched. D018 §5.2.
  const SEGMENTS = makePassage(
    "The following table shows net sales by reportable segment for the three- and six-month periods ended March 28, 2026 and March 29, 2025 (dollars in millions): Three Months Ended Six Months Ended March 28, 2026 March 29, 2025 Change March 28, 2026 March 29, 2025 Change Americas $45,093 $40,315 12% $103,622 $92,963 11% Europe 28,055 24,454 15% 66,201 58,315 14% Greater China 20,497 16,002 28% 46,023 34,515 33% Japan 8,401 7,298 15% 17,814 16,285 9% Rest of Asia Pacific 9,138 7,290 25% 21,280 17,581 21% Total net sales $111,184 $95,359 17% $254,940 $219,659 16%"
  );

  it("does NOT contradict a true single-word-segment claim by comparing it to the Total row", () => {
    const claim = makeClaim("Americas net sales grew 12% year over year.");
    claim.period = "Q2 2026";
    const result = reconcileNumericVerdict(claim, { verdict: "supported", evidence: [], note: "matches", confidence: 0.9 }, [SEGMENTS]);
    expect(result.verdict).toBe("supported");
    expect(result.note).not.toContain("verdict set by code");
  });

  it("contradicts a false segment claim against that segment's OWN row, not the Total row", () => {
    const claim = makeClaim("Europe net sales grew 22% year over year.");
    claim.period = "Q2 2026";
    const result = reconcileNumericVerdict(claim, { verdict: "unverifiable", evidence: [], note: "n", confidence: 0 }, [SEGMENTS]);
    expect(result.verdict).toBe("contradicted");
    expect(result.note).toContain("15%"); // Europe's real figure
    expect(result.note).not.toContain("17%"); // Total's figure must not be what it argues from
  });
});

describe("pickBestRow — exact-tie decline path (2026-08-03, found on review: zero prior coverage, exercised indirectly via reconcileNumericVerdict)", () => {
  // Three rows share identical matched-word rarity+coverage against "Alpha Revenue" — a genuine
  // 3-way tie, not just no-match. None of the three should be picked; the verdict must decline (stay
  // unchanged) rather than confidently citing one at random.
  const THREE_WAY_TIE = makePassage(
    "Alpha Revenue Foo was $100 million. Alpha Revenue Bar was $200 million. Alpha Revenue Baz was $300 million."
  );

  it("declines (leaves verdict unchanged) on a genuine 3-way tie", () => {
    const claim = makeClaim("Alpha Revenue was $150 million.");
    const result = reconcileNumericVerdict(claim, { verdict: "unverifiable", evidence: [], note: "n", confidence: 0 }, [THREE_WAY_TIE]);
    expect(result.verdict).toBe("unverifiable");
    expect(result.note).not.toContain("verdict set by code");
  });

  // A 4th row adds "Corp" — a third matched word unique to it — giving it strictly higher rarity than
  // the three tied rows above, which only ever match on "alpha"/"revenue". The unique winner must still
  // be selected correctly even though ties exist among the OTHER candidates.
  const ONE_WINNER_PLUS_TIE = makePassage(
    "Alpha Revenue Corp was $999 million. Alpha Revenue Foo was $100 million. Alpha Revenue Bar was $200 million."
  );

  it("still picks the unique winner when a tie exists only among the non-winning candidates", () => {
    const claim = makeClaim("Alpha Revenue Corp was $1 million.");
    const result = reconcileNumericVerdict(claim, { verdict: "supported", evidence: [], note: "n", confidence: 0.9 }, [ONE_WINNER_PLUS_TIE]);
    expect(result.verdict).toBe("contradicted");
    expect(result.note).toContain("999"); // Corp's own figure, not Foo's or Bar's
  });
});

describe("COLUMN/PERIOD GATE (2026-07-31) — a row's figures belong to a specific column", () => {
  // Both claims quote a REAL figure from the right row, in the prior-year column. Unanimity can never
  // catch that: the value genuinely appears in the row. Locked in together because the tax row is bare
  // (no `$`), so CURRENCY_RE never saw it and it was compared against the Net income row instead —
  // "correct by accident". D018 §5.2.
  const INCOME = makePassage(
    "Gross margin 54,781 44,867 124,012 103,142. Research and development 11,419 8,550 22,306 16,818. Total operating expenses 18,896 15,278 37,275 30,721. Operating income 35,885 29,589 86,737 72,421. Provision for income taxes 6,255 4,530 15,160 10,784. Net income $29,578 $24,780 $71,675 $61,110. Column order throughout this section: Three Months Ended March 28 2026, Three Months Ended March 29 2025, Six Months Ended March 28 2026, Six Months Ended March 29 2025, dollars in millions."
  );
  const SEGMENTS = makePassage(
    "The following table shows net sales by reportable segment for the three- and six-month periods ended March 28, 2026 and March 29, 2025 (dollars in millions): Three Months Ended Six Months Ended March 28, 2026 March 29, 2025 Change March 28, 2026 March 29, 2025 Change Americas $45,093 $40,315 12% $103,622 $92,963 11% Europe 28,055 24,454 15% 66,201 58,315 14% Greater China 20,497 16,002 28% 46,023 34,515 33% Japan 8,401 7,298 15% 17,814 16,285 9% Rest of Asia Pacific 9,138 7,290 25% 21,280 17,581 21% Total net sales $111,184 $95,359 17% $254,940 $219,659 16%"
  );

  const wrongColumn = [
    { claim: "Total operating expenses were $15,278 for the quarter.", passage: INCOME, cites: "18896", never: "15278" },
    { claim: "Provision for income taxes was $4,530 for the quarter.", passage: INCOME, cites: "6255", never: "4530" },
    { claim: "Europe net sales were $24,454 million for the second quarter.", passage: SEGMENTS, cites: "28055", never: "24454" },
    { claim: "Japan net sales were $7,298 million for the second quarter.", passage: SEGMENTS, cites: "8401", never: "7298" },
  ];

  for (const { claim: text, passage, cites, never } of wrongColumn) {
    it(`contradicts a prior-year-column figure using its own row's current column: "${text.slice(0, 46)}"`, () => {
      const claim = makeClaim(text);
      claim.period = "fiscal Q2 2026";
      const result = reconcileNumericVerdict(claim, { verdict: "supported", evidence: [], note: "matches", confidence: 0.9 }, [passage]);
      // A real figure from the wrong column is NOT a contradiction — the source states it, for another
      // period. Only a figure absent from the whole row is contradicted. D018 §5.11.
      expect(result.verdict).toBe("unsupported");
      expect(result.note).toContain(cites); // the claimed period's actual figure
      expect(result.note).toContain("not for the claimed period");
    });
  }

  it("reads bare (non-$) rows at all — SEC tables mark only the first and total row", () => {
    const claim = makeClaim("Mac net sales were $9,138 million for the second quarter.");
    claim.period = "fiscal Q2 2026";
    const products = makePassage(
      "The following table shows net sales by category for the three- and six-month periods ended March 28, 2026 and March 29, 2025 (dollars in millions): Three Months Ended Six Months Ended March 28, 2026 March 29, 2025 Change March 28, 2026 March 29, 2025 Change iPhone $56,994 $46,841 22% $142,263 $115,979 23% Mac 8,399 7,949 6% 16,785 16,936 (1)% iPad 6,914 6,402 8% 15,509 14,490 7% Services 30,976 26,645 16% 60,989 52,985 15% Total net sales $111,184 $95,359 17% $254,940 $219,659 16%"
    );
    const result = reconcileNumericVerdict(claim, { verdict: "supported", evidence: [], note: "matches", confidence: 0.9 }, [products]);
    expect(result.verdict).toBe("contradicted"); // 9,138 is Rest of Asia Pacific, not Mac
    expect(result.note).toContain("8399");
  });

  const trueClaims = [
    "Europe net sales were $28,055 million for the second quarter.",
    "Greater China net sales were $20,497 million for the second quarter.",
    "Total net sales were $111,184 million for the second quarter.",
    "Americas net sales grew 12% year over year.",
  ];
  for (const text of trueClaims) {
    it(`never contradicts a true current-column claim: "${text.slice(0, 46)}"`, () => {
      const claim = makeClaim(text);
      claim.period = "fiscal Q2 2026";
      const result = reconcileNumericVerdict(claim, { verdict: "supported", evidence: [], note: "matches", confidence: 0.9 }, [SEGMENTS]);
      expect(result.verdict).toBe("supported");
    });
  }

  it("declines when the block states no column header (headerless tables stay unresolvable)", () => {
    const noHeader = makePassage("Total operating expenses 18,896 15,278 37,275 30,721.");
    const claim = makeClaim("Total operating expenses were $15,278 for the quarter.");
    claim.period = "fiscal Q2 2026";
    const result = reconcileNumericVerdict(claim, { verdict: "supported", evidence: [], note: "n", confidence: 0.9 }, [noHeader]);
    expect(result.verdict).toBe("supported");
  });
});

describe("WRONG-PERIOD GATE (2026-07-31) — an inferred claim.period must never select a cell", () => {
  // Live stress run: EXTRACT tagged all 46 claims "Q3 2025" on a Q2 2026 filing, the comparator selected
  // the prior-year column, and 9 verbatim-true income-statement claims were contradicted at confidence 1.
  // Every claim here carries that WRONG period on purpose. D018 §5.11.
  const INCOME = makePassage(
    "Gross margin 54,781 44,867 124,012 103,142. Research and development 11,419 8,550 22,306 16,818. Total operating expenses 18,896 15,278 37,275 30,721. Operating income 35,885 29,589 86,737 72,421. Other income/(expense), net (52) (279) 98 (527). Provision for income taxes 6,255 4,530 15,160 10,784. Net income $29,578 $24,780 $71,675 $61,110. Column order throughout this section: Three Months Ended March 28 2026, Three Months Ended March 29 2025, Six Months Ended March 28 2026, Six Months Ended March 29 2025, dollars in millions."
  );
  const withBadPeriod = (text: string) => {
    const claim = makeClaim(text);
    claim.period = "Q3 2025"; // what EXTRACT actually produced
    return claim;
  };

  const trueClaims = [
    "Gross margin was $54,781 million during the quarter.",
    "Research and development expense was $11,419 million during the quarter.",
    "Total operating expenses were $18,896 million during the quarter.",
    "Net income was $29,578 million during the quarter.",
    "Provision for income taxes was $6,255 million during the quarter.",
    "Other income and expense, net, was negative $52 million during the quarter.",
  ];
  for (const text of trueClaims) {
    it(`never contradicts a true claim when the inferred period is wrong: "${text.slice(0, 44)}"`, () => {
      const result = reconcileNumericVerdict(withBadPeriod(text), { verdict: "supported", evidence: [], note: "m", confidence: 0.9 }, [INCOME]);
      expect(result.verdict).toBe("supported");
    });
  }

  const falseClaims = [
    { text: "Total operating expenses were $15,278 million during the quarter.", cites: "18896" },
    { text: "Provision for income taxes was $4,530 million during the quarter.", cites: "6255" },
  ];
  for (const { text, cites } of falseClaims) {
    it(`marks a prior-year-column claim unsupported despite the wrong period: "${text.slice(0, 44)}"`, () => {
      const result = reconcileNumericVerdict(withBadPeriod(text), { verdict: "supported", evidence: [], note: "m", confidence: 0.9 }, [INCOME]);
      expect(result.verdict).toBe("unsupported");
      expect(result.note).toContain(cites);
    });
  }

  it("parses an accounting-negative bare cell and the prose form of the same sign", () => {
    expect(extractNumericFact("Other income was negative $52 million")).toEqual({ value: -52, unit: "USD", scale: "million" });
  });
});

describe("COMPARATIVE-ASIDE GATE (2026-07-31) — a year after the figure must not retarget the column", () => {
  // A bare year in a comparative aside ("versus 2025 levels") was narrowing the table to the prior-year
  // column, so verbatim-true figures were contradicted. Phrase-dependent, which made it unpredictable:
  // "up from 2025" survived while "from the 2025 figure" did not. D018 §5.11.
  const INCOME = makePassage(
    "Gross margin 54,781 44,867 124,012 103,142. Research and development 11,419 8,550 22,306 16,818. Total operating expenses 18,896 15,278 37,275 30,721. Operating income 35,885 29,589 86,737 72,421. Provision for income taxes 6,255 4,530 15,160 10,784. Net income $29,578 $24,780 $71,675 $61,110. Column order throughout this section: Three Months Ended March 28 2026, Three Months Ended March 29 2025, Six Months Ended March 28 2026, Six Months Ended March 29 2025, dollars in millions."
  );
  const run = (text: string) =>
    reconcileNumericVerdict(makeClaim(text), { verdict: "supported", evidence: [], note: "m", confidence: 0.9 }, [INCOME]);

  const trueWithAside = [
    "Gross margin was $54,781 million, versus 2025 levels.",
    "Net income of $29,578 million in the quarter compares with the 2025 result.",
    "Operating income grew to $35,885 million from the 2025 figure.",
    "Research and development expense was $11,419 million, up from 2025.",
    "Net income of $29,578 million compared with $24,780 million a year earlier.",
  ];
  for (const text of trueWithAside) {
    it(`never contradicts a true figure because of a comparative aside: "${text.slice(0, 46)}"`, () => {
      expect(run(text).verdict).toBe("supported");
    });
  }

  it("still honours a period the claim genuinely states about its own figure", () => {
    expect(run("Operating income reached $35,885 million in Q2 2026.").verdict).toBe("supported");
    expect(run("Total operating expenses were $18,896 million for the three months ended March 28, 2026.").verdict).toBe("supported");
  });

  it("marks a prior-year-column figure unsupported, not contradicted", () => {
    expect(run("Total operating expenses were $15,278 million during the quarter.").verdict).toBe("unsupported");
    expect(run("Provision for income taxes was $4,530 million during the quarter.").verdict).toBe("unsupported");
  });

  it("still contradicts a figure that appears nowhere in the measure's row", () => {
    expect(run("Net income was $35,885 million during the quarter.").verdict).toBe("contradicted");
  });

  it("declines rather than picks when the claim names two different periods", () => {
    // Two period signals and no way to tell which governs the figure — must not narrow to one column.
    expect(run("Revenue rose from $95,359 million in 2025 to $111,184 million in 2026.").verdict).toBe("supported");
  });
});

describe("reconcileVerdictNoteConsistency — verb inflections (2026-07-30, Apple probe)", () => {
  const evidence = ["Total operating expenses 18,896 15,278 37,275 30,721."];

  it("catches the passive past tense — 'the claim is contradicted' shipped as supported before this", () => {
    const result = reconcileVerdictNoteConsistency({
      verdict: "supported",
      evidence,
      note: "The passage states $18,896 for the quarter. Therefore, the claim is contradicted.",
    });
    expect(result.verdict).toBe("contradicted");
  });

  it("does NOT fire when the note merely mentions the word rather than asserting a contradiction", () => {
    const result = reconcileVerdictNoteConsistency({
      verdict: "supported",
      evidence,
      note: "the real run's own note agreed with this claim while its verdict field said contradicted",
    });
    expect(result.verdict).toBe("supported");
  });
});

describe("reconcileVerdictNoteConsistency — inequality vocabulary (2026-08-02, crossrow probe F6)", () => {
  it("catches 'did not exceed' — a comparison claim's own note said false while verdict said supported", () => {
    const result = reconcileVerdictNoteConsistency({
      verdict: "supported",
      evidence: ["iPad net sales were $6,914 million and Wearables, Home and Accessories net sales were $7,901 million."],
      note: "In the three months ended March 28, 2026, iPad net sales were $6,914 million and Wearables, Home and Accessories net sales were $7,901 million. Therefore, iPad net sales did not exceed Wearables, Home and Accessories net sales.",
    });
    expect(result.verdict).toBe("contradicted");
  });

  it("catches 'did not fall short of'", () => {
    const result = reconcileVerdictNoteConsistency({
      verdict: "supported",
      evidence: ["Revenue was $50 million against a $45 million target."],
      note: "Revenue did not fall short of the target.",
    });
    expect(result.verdict).toBe("contradicted");
  });

  it("found on review (2026-08-03): catches 'did not match' as its own eq-negation, not grouped with the gt verbs it used to sit alongside", () => {
    const result = reconcileVerdictNoteConsistency({
      verdict: "supported",
      evidence: ["Revenue was $50 million against a stated $45 million."],
      note: "Revenue did not match the stated figure.",
    });
    expect(result.verdict).toBe("contradicted");
  });

  it("does NOT fire on an affirming note ('was higher than') even though it shares vocabulary with the negated form", () => {
    const result = reconcileVerdictNoteConsistency({
      verdict: "supported",
      evidence: ["iPhone net sales were $56,994 million; Services net sales were $30,976 million."],
      note: "iPhone net sales were higher than Services net sales.",
    });
    expect(result.verdict).toBe("supported");
  });

  it("found on review (2026-08-03): does NOT fire on a bare affirmative 'was lower than' — the function has no claim param, so it cannot tell this apart from a note describing a TRUE lt-shaped claim; false-flagging it would be an uncorrectable false accusation", () => {
    const result = reconcileVerdictNoteConsistency({
      verdict: "supported",
      evidence: ["Japan net sales were $8,401 million; Greater China net sales were $20,497 million."],
      note: "Japan net sales were $8,401 million, which was lower than Greater China's $20,497 million, confirming the claim.",
    });
    expect(result.verdict).toBe("supported");
  });

  it("found on review (2026-08-03): does NOT fire on a bare affirmative 'fell short of'", () => {
    const result = reconcileVerdictNoteConsistency({
      verdict: "supported",
      evidence: ["Revenue was $40 million against a $45 million target."],
      note: "Revenue fell short of the target, as the claim states.",
    });
    expect(result.verdict).toBe("supported");
  });
});

describe("reconcileDefinedTermVerdict — topicality gate (2026-07-30, Apple probe)", () => {
  const goingConcern = () => makeClaim("Management flagged substantial doubt about the ability of the company to continue as a going concern.");

  it("does NOT grant partial support when no retrieved passage is even on-topic", () => {
    // Live probe: a fabricated going-concern claim about Apple came back partially_supported,
    // "evidenced" by five iPhone/Mac/iPad sales narratives. D018 §5.4.
    const passages = [
      makePassage("iPhone net sales increased during the second quarter due to higher net sales of Pro models."),
      makePassage("Mac net sales increased during the second quarter of 2026 due to higher net sales of laptops."),
    ];
    const result = reconcileDefinedTermVerdict(goingConcern(), { verdict: "unsupported", evidence: [], note: "n", confidence: 1 }, passages);
    expect(result.verdict).toBe("unsupported");
    expect(result.evidence).toBeUndefined();
  });

  it("still downgrades when a passage IS on-topic but never uses the term verbatim (Allogene shape)", () => {
    const passages = [makePassage("The Company has sustained operating losses and recognizes the need to raise additional capital.")];
    const result = reconcileDefinedTermVerdict(goingConcern(), { verdict: "unverifiable", evidence: [], note: "n", confidence: 0 }, passages);
    expect(result.verdict).toBe("partially_supported");
    expect(result.evidence).toEqual([passages[0]!.text]);
  });
});

describe("reconcileDefinedTermVerdict — passage fallback (2026-07-30, third A/B run confirmation)", () => {
  it("real production incident: resolves a going-concern claim by scanning retrieved passages directly when VERIFY's evidence is empty", () => {
    const claim = makeClaim("Management flagged substantial doubt about the Company's ability to continue as a going concern.");
    const passages = [
      makePassage("The Company has sustained operating losses and expects to continue to generate operating losses for the foreseeable future."),
    ];
    const result = reconcileDefinedTermVerdict(
      claim,
      { verdict: "unverifiable", evidence: null, note: "the passage does not mention going concern", confidence: 0 },
      passages
    );
    expect(result.verdict).toBe("partially_supported");
    // Forced to 1 (2026-07-30): passing the model's confidence through meant a raw 0 let GateService
    // re-gate this straight back to unverifiable, which is why going-concern claims kept vanishing
    // from Eligible between runs on identical code.
    expect(result.confidence).toBe(1);
    // A partially_supported verdict with an empty evidence array is unbackable in the report —
    // observed in two real runs (2026-07-30) before this. Cite what the decision was made against.
    expect(result.evidence).toEqual([passages[0]!.text]);
    expect(result.sourceRefs).toEqual([passages[0]!.passageId]);
  });

  it("does not overwrite evidence the model did supply — only fills the gap when it supplied none", () => {
    const claim = makeClaim("Management flagged substantial doubt about the Company's ability to continue as a going concern.");
    const modelEvidence = ["The Company has sustained operating losses."];
    const result = reconcileDefinedTermVerdict(
      claim,
      { verdict: "unverifiable", evidence: modelEvidence, note: "n", confidence: 0 },
      [makePassage("An unrelated retrieved passage about manufacturing capacity.")]
    );
    expect(result.verdict).toBe("partially_supported");
    expect(result.evidence).toBeUndefined(); // caller keeps the model's own evidence
  });

  it("leaves the verdict unchanged when the term IS present verbatim in a retrieved passage, even with no LLM evidence", () => {
    const claim = makeClaim("Management flagged substantial doubt about the Company's ability to continue as a going concern.");
    const passages = [makePassage("Management has concluded there is substantial doubt about the Company's ability to continue as a going concern.")];
    const result = reconcileDefinedTermVerdict(claim, { verdict: "supported", evidence: null, note: "no evidence field populated", confidence: 0.9 }, passages);
    expect(result.verdict).toBe("supported");
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

describe("reconcileTemporalVerdict — date comparator (2026-07-29, reproduced across 3 consecutive real runs)", () => {
  it("real production incident: upgrades a false 'supported' to 'contradicted' when the claim's quarter and the evidence's quarter differ", () => {
    // Verbatim repro: claim asserts the runway extends into Q3 2026; the real filing's own
    // passage states it extends into Q1 2028 — a materially later, different quarter. The model
    // reasoned "Q1 2028 is later than Q3 2026, so it supports the claim" three runs in a row.
    const claim = makeClaim("Cash runway extends into Q3 2026.");
    const result = reconcileTemporalVerdict(claim, {
      verdict: "supported",
      evidence: ["Allogene Therapeutics reports 2025 net loss of $190.9 million or $(0.87) per share, ends Q4 with $258.3 million cash and extends runway into Q1 2028."],
      note: "the passage states runway extends into Q1 2028, which supports the claim of Q3 2026",
      confidence: 1,
    });
    expect(result.verdict).toBe("contradicted");
    expect(result.note).toContain("Q3 2026");
    expect(result.note).toContain("Q1 2028");
    expect(result.confidence).toBe(1);
  });

  it("real bug found on review (2026-07-30, real A/B run comparison): the corrected note must LEAD with the code's conclusion, not bury it after the model's original (conflicting) wording", () => {
    // A real run showed verdict='contradicted' persisted next to a note ending "...which supports
    // the claim that cash runway extends into Q3 2026" — the override appended its tag AFTER the
    // model's own sentence instead of leading with the correction, so a reader saw "CONTRADICTED"
    // next to text arguing the opposite. The corrected conclusion must come first; the model's
    // original wording, if kept at all, must be clearly marked as superseded context.
    const claim = makeClaim("Cash runway extends into Q3 2026.");
    const result = reconcileTemporalVerdict(claim, {
      verdict: "supported",
      evidence: ["extends runway into Q1 2028"],
      note: "The passage states runway extends into Q1 2028, which supports the claim that cash runway extends into Q3 2026.",
    });
    expect(result.verdict).toBe("contradicted");
    expect(result.note?.indexOf("verdict set by code")).toBeLessThan(result.note?.indexOf("which supports the claim") ?? -1);
    expect(result.note).toContain("superseded");
  });

  it("does not get confused by a bare quarter mention with no attached year (e.g. 'ends Q4 with $258.3 million cash') — only one unambiguous quarter+year pair exists in that evidence", () => {
    // Confirms the disambiguation: "Q4" alone (no 4-digit year immediately after) must not parse
    // as a quarter fact at all, leaving exactly one real candidate (Q1 2028) to compare against.
    const claim = makeClaim("Cash runway extends into Q3 2026.");
    const result = reconcileTemporalVerdict(claim, {
      verdict: "supported",
      evidence: ["ends Q4 with $258.3 million cash and extends runway into Q1 2028"],
      note: "matches",
    });
    expect(result.verdict).toBe("contradicted"); // still resolves — only one real quarter+year candidate
  });

  it("stays unchanged when evidence names two full quarter+year pairs (genuinely ambiguous, no signal to pick one)", () => {
    const claim = makeClaim("Cash runway extends into Q3 2026.");
    const result = reconcileTemporalVerdict(claim, {
      verdict: "supported",
      evidence: ["runway extends into Q1 2028 under the base case or Q3 2027 under the downside case"],
      note: "matches",
    });
    expect(result.verdict).toBe("supported"); // ambiguous — don't guess, trust the LLM
  });

  it("upgrades a false 'contradicted' to 'supported' when both state the identical quarter", () => {
    const claim = makeClaim("Cash runway extends into Q1 2028.");
    const result = reconcileTemporalVerdict(claim, {
      verdict: "contradicted",
      evidence: ["extends runway into Q1 2028"],
      note: "should be supported",
    });
    expect(result.verdict).toBe("supported");
    expect(result.confidence).toBe(1);
  });

  it("does not engage for claims with no quarter+year reference at all", () => {
    const claim = makeClaim("Cash runway extends into 2028.");
    const result = reconcileTemporalVerdict(claim, {
      verdict: "supported",
      evidence: ["extends runway into Q1 2028"],
      note: "matches",
    });
    expect(result.verdict).toBe("supported"); // no quarter token in the claim itself — out of scope
  });

  it("found on review: does NOT engage when raw verdict is 'unsupported' or 'unverifiable' — unlike reconcileNumericVerdict, there is no same-measure safety signal for a bare quarter+year token, so this stays scoped to supported/contradicted only", () => {
    // Unlike currency (typed as USD vs percent, plus a scale-presence guard), a date has no
    // secondary signal distinguishing "the date this claim is about" from an unrelated date the
    // passage also happens to mention. Restricting to supported/contradicted-only avoids trusting
    // that signal on retrieval the model hasn't even vouched is about the same subject.
    const claim = makeClaim("Cash runway extends into Q3 2026.");
    const result = reconcileTemporalVerdict(claim, {
      verdict: "unverifiable",
      evidence: ["Management expects the Q2 2026 patent-litigation ruling to have no material impact on operations."],
      note: "the passage does not mention cash runway",
      confidence: 0,
    });
    expect(result.verdict).toBe("unverifiable"); // unchanged — an unrelated Q2 2026 mention must not force a verdict
  });

  it("does not touch a verdict already carrying a code-override tag from an earlier reconciler in the chain (chain-reversal guard)", () => {
    // Regression test for a real bug found on review: chaining reconcilers sequentially, each
    // fed the previous one's output, let a later reconciler silently undo an earlier one's
    // correct override for an unrelated reason (e.g. a numeric contradiction reversed back to
    // "supported" because an unrelated quarter mention happened to match).
    const claim = makeClaim("R&D investment totaled $640 million in Q3 2026.");
    const result = reconcileTemporalVerdict(claim, {
      verdict: "contradicted",
      evidence: ["R&D investment totaled $64 million in Q3 2026."],
      note: "[verdict set by code: 640 and 64 disagree beyond tolerance — compare.ts, D018 §2.3]",
      confidence: 1,
    });
    // The quarters DO match (both Q3 2026), which would normally force "supported" — but the
    // note already carries an earlier stage's code-override tag, so this must defer, not overwrite.
    expect(result.verdict).toBe("contradicted");
  });

  it("passage fallback (2026-07-30, added preemptively): resolves the quarter comparison from retrieved passages when VERIFY's evidence is empty", () => {
    const claim = makeClaim("Cash runway extends into Q3 2026.");
    const passages = [
      makePassage("Allogene Therapeutics reports 2025 net loss of $190.9 million or $(0.87) per share, ends Q4 with $258.3 million cash and extends runway into Q1 2028."),
    ];
    const result = reconcileTemporalVerdict(claim, { verdict: "supported", evidence: [], note: "no evidence field populated", confidence: 1 }, passages);
    expect(result.verdict).toBe("contradicted");
    expect(result.evidence).toEqual([passages[0]!.text]);
    expect(result.sourceRefs).toEqual([passages[0]!.passageId]);
    expect(result.confidence).toBe(1);
  });
});

describe("reconcileDefinedTermVerdict — going-concern-style rule-3 policy (2026-07-29)", () => {
  const goingConcernClaim = () => makeClaim("Management flagged substantial doubt about the Company's ability to continue as a going concern.");

  it("caps a false 'supported' down to 'partially_supported' when the defined term is absent from evidence (verify-034 shape)", () => {
    const result = reconcileDefinedTermVerdict(goingConcernClaim(), {
      verdict: "supported",
      evidence: [
        "The Company has sustained operating losses and expects to continue to generate operating losses for the foreseeable future.",
        "We will need substantial additional financing to develop our products and implement our operating plans.",
      ],
      note: "the passages discuss sustained losses and financing need",
      confidence: 0.9,
    });
    expect(result.verdict).toBe("partially_supported");
    // Forced to 1 — the presence/negation check is deterministic given claim+evidence, and the old
    // passthrough let GateService discard the override on a low model confidence. D018 §5.8.
    expect(result.confidence).toBe(1);
  });

  it("real production incident: raises a false 'unsupported'/'unverifiable' to 'partially_supported' when on-topic evidence exists but the term is absent", () => {
    const result = reconcileDefinedTermVerdict(goingConcernClaim(), {
      verdict: "unverifiable",
      evidence: ["The Company has sustained operating losses and expects to continue to generate operating losses for the foreseeable future."],
      note: "the passage does not use the term going concern",
      confidence: 0.7,
    });
    expect(result.verdict).toBe("partially_supported");
    expect(result.confidence).toBe(1); // forced, not passed through — see comment above
  });

  it("leaves 'supported' unchanged when the defined term IS present verbatim somewhere in evidence (direct restatement)", () => {
    const result = reconcileDefinedTermVerdict(goingConcernClaim(), {
      verdict: "supported",
      evidence: ["Management has concluded there is substantial doubt about the Company's ability to continue as a going concern."],
      note: "direct statement",
      confidence: 0.95,
    });
    expect(result.verdict).toBe("supported");
  });

  it("does not touch 'contradicted' — a stronger finding this presence-check has no basis to override", () => {
    const result = reconcileDefinedTermVerdict(goingConcernClaim(), {
      verdict: "contradicted",
      evidence: ["Management has no substantial doubt about the Company's ability to continue as a going concern."],
      note: "explicit denial",
    });
    expect(result.verdict).toBe("contradicted");
  });

  it("does not engage when the claim has no evidence at all", () => {
    const result = reconcileDefinedTermVerdict(goingConcernClaim(), {
      verdict: "unverifiable",
      evidence: null,
      note: "no evidence found",
      confidence: 0,
    });
    expect(result.verdict).toBe("unverifiable");
  });

  it("does not engage for claims that don't assert a curated defined term", () => {
    const result = reconcileDefinedTermVerdict(makeClaim("Revenue grew 22% year-over-year"), {
      verdict: "supported",
      evidence: ["Revenue grew 22%"],
      note: "matches",
    });
    expect(result.verdict).toBe("supported");
  });

  it("found on review: does not misfire on a claim that NEGATES the defined term instead of asserting it", () => {
    // "does not believe there is substantial doubt" contains the raw phrase but asserts its
    // ABSENCE — must not be treated as an assertion of the term needing verbatim confirmation.
    const claim = makeClaim("Management does not believe there is substantial doubt about the Company's ability to continue as a going concern.");
    const result = reconcileDefinedTermVerdict(claim, {
      verdict: "supported",
      evidence: ["The Company expects to continue generating profits and has no need for additional financing."],
      note: "the passage supports a healthy financial position",
    });
    expect(result.verdict).toBe("supported"); // unchanged — this claim asserts absence, not presence
  });

  it("found on review: requires 'going concern' to co-occur near 'substantial doubt' — a bare match in an unrelated (e.g. litigation) context must not engage", () => {
    const claim = makeClaim("The court expressed substantial doubt about the validity of the patent claims in the infringement suit.");
    const result = reconcileDefinedTermVerdict(claim, {
      verdict: "supported",
      evidence: ["The judge questioned whether the asserted claims met the novelty requirement."],
      note: "paraphrase of the court's skepticism",
    });
    expect(result.verdict).toBe("supported"); // unchanged — not a going-concern claim at all
  });

  it("does not touch a verdict already carrying a code-override tag from an earlier reconciler in the chain (chain-reversal guard)", () => {
    const result = reconcileDefinedTermVerdict(goingConcernClaim(), {
      verdict: "contradicted",
      evidence: ["Management has no substantial doubt about the Company's ability to continue as a going concern."],
      note: "[verdict overridden by code: 'supported' is invalid when its own note asserts a contradiction — D018 §2.3 VERDICT/NOTE CONSISTENCY]",
    });
    expect(result.verdict).toBe("contradicted"); // deferred to the earlier stage's decision, not re-evaluated
  });
});

describe("chain-reversal guard — CODE_OVERRIDE_TAG_RE (2026-07-29, found on review)", () => {
  it("reconcileNumericVerdict defers to a verdict reconcileVerdictNoteConsistency already deterministically set, even when its own numeric check would otherwise disagree", () => {
    // Compound claim: entity assertion (segments) the note already flagged as contradicted, PLUS
    // a dollar figure that happens to match evidence. Without the guard, the numeric check would
    // silently flip the already-correct "contradicted" back to "supported" because $100M == $100M.
    const claim = makeClaim("The company operates two reportable segments and revenue was $100 million.");
    const consistencyOutput = reconcileVerdictNoteConsistency({
      verdict: "supported",
      evidence: ["The company operates as a single reportable segment; revenue was $100 million."],
      note: "The passage states the company operates as a single reportable segment, which contradicts the claim of two reportable segments; revenue figure of $100 million matches.",
    });
    expect(consistencyOutput.verdict).toBe("contradicted"); // sanity check: stage 1 behaves as expected

    const numericOutput = reconcileNumericVerdict(claim, {
      verdict: consistencyOutput.verdict,
      evidence: ["The company operates as a single reportable segment; revenue was $100 million."],
      note: consistencyOutput.note,
      confidence: consistencyOutput.confidence,
    });
    expect(numericOutput.verdict).toBe("contradicted"); // must NOT be flipped back to "supported" by the $100M match
  });
});

describe("extractComparisonClaim (2026-08-02, D018 §5.14)", () => {
  it("splits a claim into left subject, right subject, and operator", () => {
    const result = extractComparisonClaim("iPhone net sales were higher than Services net sales");
    expect(result).toEqual({ leftSubject: "iPhone net sales", rightSubject: "Services net sales", operator: "gt" });
  });

  it("recognizes lt and eq phrasing", () => {
    expect(extractComparisonClaim("Japan net sales were lower than Greater China net sales")?.operator).toBe("lt");
    expect(extractComparisonClaim("Alpha revenue matched Beta revenue")?.operator).toBe("eq");
  });

  it("found on review (2026-08-03): recognizes vocabulary CONTRADICTION_LANGUAGE_RE already had a negated form for, added here to keep the two lists in sync", () => {
    expect(extractComparisonClaim("Alpha revenue outperformed Beta revenue")?.operator).toBe("gt");
    expect(extractComparisonClaim("Alpha revenue topped Beta revenue")?.operator).toBe("gt");
    expect(extractComparisonClaim("Alpha revenue was larger than Beta revenue")?.operator).toBe("gt");
    expect(extractComparisonClaim("Alpha revenue was smaller than Beta revenue")?.operator).toBe("lt");
  });

  it("declines when no comparator phrase is present", () => {
    expect(extractComparisonClaim("Revenue grew this quarter.")).toBeNull();
  });

  it("declines on an ambiguous claim naming more than one comparator phrase", () => {
    expect(
      extractComparisonClaim("Americas net sales exceeded Europe net sales, which exceeded Japan net sales.")
    ).toBeNull();
  });
});

describe("reconcileComparisonVerdict — cross-row/cross-metric comparison claims (2026-08-02, D018 §5.14 / T045, crossrow probe F6)", () => {
  const SEGMENTS = makePassage(
    "The following table shows net sales by reportable segment for the three- and six-month periods ended March 28, 2026 and March 29, 2025 (dollars in millions): Three Months Ended Six Months Ended March 28, 2026 March 29, 2025 Change March 28, 2026 March 29, 2025 Change Americas $45,093 $40,315 12% $103,622 $92,963 11% Europe 28,055 24,454 15% 66,201 58,315 14% Greater China 20,497 16,002 28% 46,023 34,515 33% Japan 8,401 7,298 15% 17,814 16,285 9% Rest of Asia Pacific 9,138 7,290 25% 21,280 17,581 21% Total net sales $111,184 $95,359 17% $254,940 $219,659 16%"
  );
  const EQUAL_PAIR = makePassage("Alpha revenue was $100 million for the quarter. Beta revenue was $100 million for the quarter.");
  const AMBIGUOUS_PAIR = makePassage(
    "Americas Digital revenue was $500 million. Americas Digital services revenue was $505 million. International revenue was $900 million."
  );

  it("overrides a wrong LLM verdict to supported when both sides resolve and the claimed direction genuinely holds (real Americas > Europe)", () => {
    const claim = makeClaim("Americas net sales for the quarter were greater than Europe net sales.");
    const result = reconcileComparisonVerdict(claim, { verdict: "unverifiable", evidence: [], note: null, confidence: 0 }, [SEGMENTS]);
    expect(result.verdict).toBe("supported");
    expect(result.note).toContain("D018 §5.14");
  });

  it("overrides a wrong LLM verdict to contradicted when both sides resolve and the claimed direction is false (F6 shape: reversed Americas/Europe)", () => {
    const claim = makeClaim("Europe net sales for the quarter were greater than Americas net sales.");
    const result = reconcileComparisonVerdict(claim, { verdict: "supported", evidence: ["e"], note: "n", confidence: 0.9 }, [SEGMENTS]);
    expect(result.verdict).toBe("contradicted");
  });

  it("contradicts a strict-inequality claim ('exceeded') when both sides resolve to the SAME value", () => {
    const claim = makeClaim("Alpha revenue exceeded Beta revenue.");
    const result = reconcileComparisonVerdict(claim, { verdict: "supported", evidence: [], note: null, confidence: 0.9 }, [EQUAL_PAIR]);
    expect(result.verdict).toBe("contradicted");
  });

  it("supports an equality claim ('matched') when both sides resolve to the same value", () => {
    const claim = makeClaim("Alpha revenue matched Beta revenue.");
    const result = reconcileComparisonVerdict(claim, { verdict: "unverifiable", evidence: [], note: null, confidence: 0 }, [EQUAL_PAIR]);
    expect(result.verdict).toBe("supported");
  });

  it("found on review (2026-08-03): resolves the SIX MONTHS column when the period phrase is stated AFTER the comparator word ('...than Europe net sales for the six months ended...'), not just before it", () => {
    // Previously narrowByPeriod was fed the raw claim.claimText, whose own COMPARATIVE_RE treats "than"
    // as a baseline-marker and truncates everything after it — silently dropping this exact period
    // phrase and declining. periodText (leftSubject+rightSubject, comparator word removed) fixes it.
    const claim = makeClaim("Americas net sales were greater than Europe net sales for the six months ended March 28, 2026.");
    const result = reconcileComparisonVerdict(claim, { verdict: "unverifiable", evidence: [], note: null, confidence: 0 }, [SEGMENTS]);
    expect(result.verdict).toBe("supported"); // six-months Americas 103,622 > six-months Europe 66,201
    expect(result.note).toContain("103622");
  });

  it("found on review (2026-08-03): declines rather than compares two sides whose scale-presence disagrees (one side scaled, other side scale-less) — same discipline as isUsableNumericFact", () => {
    const mismatchedScale = makePassage("Alpha revenue was $100 million for the quarter. Beta revenue was $100 for the quarter.");
    const claim = makeClaim("Alpha revenue exceeded Beta revenue.");
    const result = reconcileComparisonVerdict(claim, { verdict: "supported", evidence: [], note: null, confidence: 0.9 }, [mismatchedScale]);
    expect(result.verdict).toBe("supported"); // unchanged — must not confidently compare $100M against a bare, unscaled $100
  });

  it("never overrides when only the LEFT side resolves — decline, don't guess with one resolved side", () => {
    const claim = makeClaim("Vibranium revenue exceeded International revenue.");
    const result = reconcileComparisonVerdict(claim, { verdict: "unverifiable", evidence: [], note: null, confidence: 0 }, [AMBIGUOUS_PAIR]);
    expect(result.verdict).toBe("unverifiable"); // unchanged — left side ("Vibranium") never resolves anywhere
  });

  it("never overrides when only the RIGHT side resolves — decline, don't guess with one resolved side", () => {
    const claim = makeClaim("International revenue exceeded Vibranium revenue.");
    const result = reconcileComparisonVerdict(claim, { verdict: "supported", evidence: [], note: null, confidence: 0.9 }, [AMBIGUOUS_PAIR]);
    expect(result.verdict).toBe("supported"); // unchanged — right side ("Vibranium") never resolves anywhere
  });

  it("declines on a near-tied row match (ambiguity margin), not just an exact tie — a close call must not silently pick the wrong row", () => {
    // "Americas ... revenue" is genuinely ambiguous between the Digital and Digital-services rows here —
    // close but not identical scores, unlike a pure tie. The reviewer's own example: 0.81 vs 0.80 must
    // decline the same way 0.81 vs 0.81 would. D018 §5.14.
    const claim = makeClaim("Americas revenue exceeded International revenue.");
    const result = reconcileComparisonVerdict(claim, { verdict: "unverifiable", evidence: [], note: null, confidence: 0 }, [AMBIGUOUS_PAIR]);
    expect(result.verdict).toBe("unverifiable"); // unchanged — left side is ambiguous between two similarly-labeled rows
  });

  it("does not fire on a claim shape it can't parse (extractComparisonClaim declines) — no-op passthrough", () => {
    const claim = makeClaim("Revenue grew this quarter.");
    const result = reconcileComparisonVerdict(claim, { verdict: "supported", evidence: [], note: null, confidence: 0.9 }, [SEGMENTS]);
    expect(result.verdict).toBe("supported");
  });

  it("respects the chain-reversal guard — defers to an already-code-tagged verdict from an earlier reconciler", () => {
    const claim = makeClaim("Americas net sales for the quarter were greater than Europe net sales.");
    const result = reconcileComparisonVerdict(
      claim,
      { verdict: "unsupported", evidence: [], note: "[verdict set by code: some earlier reconciler already decided this]", confidence: 1 },
      [SEGMENTS]
    );
    expect(result.verdict).toBe("unsupported");
  });
});

