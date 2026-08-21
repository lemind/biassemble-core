import { describe, it, expect } from "vitest";
import {
  applyClaimReasonOverlapGate,
  applyContradictionEvidenceGate,
  applyCounterfactIgnoredGate,
  applyImplicitNegationGate,
  applyNumericGate,
  applyReasonConsistencyGate,
  applyReasonOrdinalGate,
  applyReasonYearGate,
  applyYearGate,
} from "../../../../src/orchestrators/grounnel/gates.js";

describe("gate #1 — contradiction evidence gate (T003)", () => {
  it("passes through non-contradicted verdicts unchanged", () => {
    const result = applyContradictionEvidenceGate({
      verdict: "supported",
      evidence: "anything",
      passageText: "some other text entirely",
    });
    expect(result).toEqual({ verdict: "supported", evidence: "anything", overridden: false, reason: null });
  });

  it("keeps a contradicted verdict whose evidence is a real substring of the passage", () => {
    const result = applyContradictionEvidenceGate({
      verdict: "contradicted",
      evidence: "attended Los Angeles City College",
      passageText: "Bukowski attended Los Angeles City College for two years.",
    });
    expect(result).toEqual({
      verdict: "contradicted",
      evidence: "attended Los Angeles City College",
      overridden: false,
      reason: null,
    });
  });

  it("matches after whitespace/punctuation normalization, not exact byte-for-byte", () => {
    const result = applyContradictionEvidenceGate({
      verdict: "contradicted",
      evidence: "attended Los Angeles City College!",
      passageText: "  Bukowski   attended Los Angeles City College for two years.",
    });
    expect(result.verdict).toBe("contradicted");
  });

  it("downgrades to unsupported and nulls the evidence when evidence is absent from the passage", () => {
    const result = applyContradictionEvidenceGate({
      verdict: "contradicted",
      evidence: "attended Harvard University",
      passageText: "Bukowski attended Los Angeles City College for two years.",
    });
    expect(result).toEqual({ verdict: "unsupported", evidence: null, overridden: true, reason: "evidence_not_grounded" });
  });

  it("downgrades a contradicted verdict with null evidence", () => {
    const result = applyContradictionEvidenceGate({
      verdict: "contradicted",
      evidence: null,
      passageText: "Bukowski attended Los Angeles City College for two years.",
    });
    expect(result).toEqual({ verdict: "unsupported", evidence: null, overridden: true, reason: "evidence_null" });
  });

  it("treats whitespace-only evidence the same as null, not as 'given but ungrounded' (reviewed finding)", () => {
    const result = applyContradictionEvidenceGate({
      verdict: "contradicted",
      evidence: "   ",
      passageText: "Bukowski attended Los Angeles City College for two years.",
    });
    expect(result).toEqual({ verdict: "unsupported", evidence: null, overridden: true, reason: "evidence_null" });
  });

  it("never uses fuzzy/semantic matching — a paraphrase that isn't a substring still downgrades", () => {
    const result = applyContradictionEvidenceGate({
      verdict: "contradicted",
      evidence: "went to college in Los Angeles",
      passageText: "Bukowski attended Los Angeles City College for two years.",
    });
    expect(result.verdict).toBe("unsupported");
  });

  it("matches across straight vs smart quote style, not just whitespace/basic punctuation", () => {
    const result = applyContradictionEvidenceGate({
      verdict: "contradicted",
      evidence: "the world's largest museum",
      passageText: "The Louvre is often called “the world’s largest museum” by visitors.",
    });
    expect(result.verdict).toBe("contradicted");
  });

  it("real g04 case: an ellipsis joining two genuine, non-adjacent excerpts from the same passage still passes (2026-08-07 live-eval finding)", () => {
    // Real evidence/passage pair from a live run — both halves are verbatim, ~1000 words apart
    // in the source's dated timeline (confirmed by fetching the real page). Before this fix, gate
    // #1 required the whole string to be one contiguous span and downgraded this to `unsupported`.
    const result = applyContradictionEvidenceGate({
      verdict: "contradicted",
      evidence:
        "September 1, 1939 Germany invades Poland, initiating World War II in Europe. ... September 2, 1945 Having agreed in principle to unconditional surrender on August 14, 1945, Japan formally surrenders, ending World War II.",
      passageText:
        "September 1, 1939 Germany invades Poland, initiating World War II in Europe. September 3, 1939 Great Britain and France declare war on Germany. [lots of other dated entries in between] September 2, 1945 Having agreed in principle to unconditional surrender on August 14, 1945, Japan formally surrenders, ending World War II.",
    });
    expect(result).toEqual({
      verdict: "contradicted",
      evidence:
        "September 1, 1939 Germany invades Poland, initiating World War II in Europe. ... September 2, 1945 Having agreed in principle to unconditional surrender on August 14, 1945, Japan formally surrenders, ending World War II.",
      overridden: false,
      reason: null,
    });
  });

  it("still rejects an ellipsis-joined evidence string when only one fragment is real — splitting doesn't weaken the hallucination check", () => {
    const result = applyContradictionEvidenceGate({
      verdict: "contradicted",
      evidence: "Germany invades Poland ... Japan launches a surprise invasion of California",
      passageText: "Germany invades Poland in 1939. Japan formally surrenders in 1945, ending the war.",
    });
    expect(result).toEqual({ verdict: "unsupported", evidence: null, overridden: true, reason: "evidence_not_grounded" });
  });
});

describe("gate #1b — claim/reason key-term overlap, cross-claim contamination backstop (D026 §12, real live-test finding, 2026-08-10)", () => {
  it("passes through non-contradicted verdicts unchanged", () => {
    const result = applyClaimReasonOverlapGate({
      verdict: "unsupported",
      reason: "totally unrelated text",
      claimText: "Marie Curie won Nobel Prizes in chemistry and physics.",
    });
    expect(result).toEqual({ verdict: "unsupported", overridden: false, reason: null });
  });

  it("real cross-claim contamination case: reason shares zero key terms with the claim it's attached to", () => {
    // Real production shape (2026-08-10): a batched VERIFY call answered the Marie Curie claim's id
    // with the Camp David Accords claim's reasoning. The citation still resolved to real, grounded
    // text (Marie Curie's own passage), so gate #1 alone passed it — this gate catches the reason.
    const result = applyClaimReasonOverlapGate({
      verdict: "contradicted",
      reason: "Sentence A5 explicitly states the Camp David Accords were signed on 17 September 1978.",
      claimText: "Marie Curie won Nobel Prizes in chemistry and physics.",
    });
    expect(result).toEqual({ verdict: "unsupported", overridden: true, reason: "claim_reason_no_overlap" });
  });

  it("keeps a contradicted verdict whose reason shares at least one of the claim's own key terms", () => {
    const result = applyClaimReasonOverlapGate({
      verdict: "contradicted",
      reason: "Sentence A5 states the Camp David Accords were signed on 17 September 1978, not 1998.",
      claimText: "The Camp David Accords were signed in 1998.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: false, reason: null });
  });

  it("real g05 shape: a paraphrase-heavy reason that quotes the passage instead of the claim's exact wording still keeps its key terms and isn't flagged", () => {
    const result = applyClaimReasonOverlapGate({
      verdict: "contradicted",
      reason: 'Sentence 18 states that the Emu War "failed most miserably, and which brought for the bird its most complete victory", directly contradicting the claim that it was not declared a total failure.',
      claimText: "The Emu War campaign was declared a total failure within days.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: false, reason: null });
  });

  it("fail-open: a claim with no extractable key terms at all abstains rather than flagging every such claim", () => {
    // D026 §21 — extractKeyTerms now falls back to stopword-filtered common nouns/adjectives when
    // there's no entity/number, so a genuinely empty term set needs an all-stopword claim to test.
    const result = applyClaimReasonOverlapGate({
      verdict: "contradicted",
      reason: "totally unrelated text sharing nothing with the claim",
      claimText: "It was there before that.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: false, reason: null });
  });

  it("abstains on a null reason — nothing to check overlap against", () => {
    const result = applyClaimReasonOverlapGate({
      verdict: "contradicted",
      reason: null,
      claimText: "Marie Curie won Nobel Prizes in chemistry and physics.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: false, reason: null });
  });
});

describe("gate #2 — numeric normalization/comparison in code (T004)", () => {
  it("does nothing when the claim has no numeric fact", () => {
    const result = applyNumericGate({
      claimText: "Bukowski attended Los Angeles City College.",
      verdict: "supported",
      evidence: "Bukowski attended Los Angeles City College for two years.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("does nothing when there is no evidence to compare against", () => {
    const result = applyNumericGate({
      claimText: "The grant was worth $350,000.",
      verdict: "unsupported",
      evidence: null,
    });
    expect(result).toEqual({ verdict: "unsupported", overridden: false, reason: null });
  });

  it("overrides to supported when the numbers are equal but VERIFY said otherwise", () => {
    const result = applyNumericGate({
      claimText: "UC Riverside received a $350,000 grant.",
      verdict: "unsupported",
      evidence: "The NEH awarded UC Riverside a $350,000 grant to expand the project.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: true, reason: "equality_comparison" });
  });

  it("overrides to contradicted when the numbers genuinely differ beyond tolerance (wrong scale)", () => {
    const result = applyNumericGate({
      claimText: "UC Riverside received a $1.2 million grant.",
      verdict: "supported",
      evidence: "The NEH awarded UC Riverside a $350,000 grant to expand the project.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "equality_comparison" });
  });

  it("overrides an inverted-sign case (negative vs positive)", () => {
    const result = applyNumericGate({
      claimText: "The fund reported a loss of $(52) million.",
      verdict: "supported",
      evidence: "The fund reported net income of $52 million.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "equality_comparison" });
  });

  it("leaves the verdict unchanged when code and VERIFY already agree", () => {
    const result = applyNumericGate({
      claimText: "UC Riverside received a $350,000 grant.",
      verdict: "supported",
      evidence: "The NEH awarded UC Riverside a $350,000 grant to expand the project.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("does nothing when claim and evidence units aren't comparable (percent vs currency)", () => {
    const result = applyNumericGate({
      claimText: "Enrollment grew by 12%.",
      verdict: "supported",
      evidence: "The university received a $12 million endowment.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("overrides to supported when a 'surpassed X' threshold claim's evidence is above X (real live-eval miss, g11 2026-08-06)", () => {
    const result = applyNumericGate({
      claimText: "Bloomberg reported that Apple's market capitalization surpassed $3.5 trillion in 2024.",
      verdict: "contradicted",
      evidence: "Apple's market capitalization was $3.57 trillion in November 2024.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: true, reason: "threshold_comparison" });
  });

  it("overrides to contradicted when a 'surpassed X' threshold claim's evidence is actually below X", () => {
    const result = applyNumericGate({
      claimText: "The company's revenue surpassed $10 million in 2024.",
      verdict: "supported",
      evidence: "The company's revenue was $8 million in 2024.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "threshold_comparison" });
  });

  it("D026 §22/T064, real bug found in self-review: a strict 'surpassed X' claim is NOT satisfied by evidence exactly equal to X — an exact match only satisfies inclusive wording ('at least X'), never strict wording", () => {
    const result = applyNumericGate({
      claimText: "Apple's market capitalization exceeded $3.5 trillion in 2024.",
      verdict: "supported",
      evidence: "Apple's market capitalization was $3.5 trillion in 2024.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "threshold_comparison" });
  });

  it("companion to the above: inclusive 'at least X' wording IS satisfied by an exact match, unlike strict 'exceeded'", () => {
    const result = applyNumericGate({
      claimText: "Apple's market capitalization was at least $3.5 trillion in 2024.",
      verdict: "contradicted",
      evidence: "Apple's market capitalization was $3.5 trillion in 2024.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: true, reason: "threshold_comparison" });
  });

  it("overrides to supported when an 'under X' threshold claim's evidence is below X", () => {
    const result = applyNumericGate({
      claimText: "Unemployment stayed under 5% in 2024.",
      verdict: "contradicted",
      evidence: "Unemployment was 3.9% in 2024.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: true, reason: "threshold_comparison" });
  });

  // D030 §3d (code-review finding, 2026-08-21) — a numeric MATCH must not silently un-contradict
  // a verdict reason_ordinal itself produced (same %, different ordinal position); real reachable
  // shape via runGateChain's actual gate order, unlike the g11 case above which stays correctable
  // (contradictionProtectedFromForceSupported omitted/false there).
  it("(review finding) does NOT override to supported on an equality match when the contradiction is protected (reason_ordinal-originated)", () => {
    const result = applyNumericGate({
      claimText: "The third trial showed a 40% success rate.",
      verdict: "contradicted",
      evidence: "The first trial showed a 40% success rate.",
      contradictionProtectedFromForceSupported: true,
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: false, reason: null });
  });

  it("(review finding) still overrides to supported on an equality match when NOT protected — the g11-style correction path stays intact", () => {
    const result = applyNumericGate({
      claimText: "The third trial showed a 40% success rate.",
      verdict: "contradicted",
      evidence: "The first trial showed a 40% success rate.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: true, reason: "equality_comparison" });
  });

  it("(review finding) forcing contradicted on a genuine mismatch stays unconditional even when the protected flag is set", () => {
    const result = applyNumericGate({
      claimText: "The third trial showed a 40% success rate.",
      verdict: "supported",
      evidence: "The first trial showed a 55% success rate.",
      contradictionProtectedFromForceSupported: true,
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "equality_comparison" });
  });

  it("overrides to contradicted when an 'under X' threshold claim's evidence is actually above X", () => {
    const result = applyNumericGate({
      claimText: "Unemployment stayed under 5% in 2024.",
      verdict: "supported",
      evidence: "Unemployment was 6.1% in 2024.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "threshold_comparison" });
  });

  it("abstains (does not force contradicted) on the real g11 near-miss — evidence spans multiple years for unrelated figures, only one of which overlaps the claim's year (D026 §5, 2026-08-10)", () => {
    // Verbatim real evidence: a $3.2T figure "as of July 2025", plus unrelated 2022/2023 mentions —
    // none of it actually confirms or denies the claimed 2024 threshold crossing.
    const result = applyNumericGate({
      claimText: "Apple's market capitalization surpassed $3.5 trillion in 2024",
      verdict: "partially_supported",
      evidence:
        "As of July 2025, Apple Inc. (AAPL), listed on the NASDAQ, has a market capitalization of approximately $3.2 trillion, per Yahoo Finance.\n\nApple first touched $3 trillion intraday on January 3, 2022, but did not close at that level and subsequently pulled back amid rising interest rate concerns.\n\nApple crossed and held the $3 trillion threshold more reliably beginning in June 2023, and maintained it through 2024.",
    });
    expect(result).toEqual({ verdict: "partially_supported", overridden: false, reason: null });
  });

  it("still overrides normally when the claim's year and evidence's year genuinely match, even though a year is present in both (guard doesn't over-trigger)", () => {
    const result = applyNumericGate({
      claimText: "The company's revenue surpassed $10 million in 2024.",
      verdict: "supported",
      evidence: "In 2024 filings, the company reported revenue of $8 million.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "threshold_comparison" });
  });

  it("abstains when the claim names a year the evidence doesn't confirm at all, even outside threshold language (equality path)", () => {
    const result = applyNumericGate({
      claimText: "In 2024, UC Riverside received a $350,000 grant.",
      verdict: "unsupported",
      evidence: "In 2019, the NEH awarded UC Riverside a $350,000 grant to expand the project.",
    });
    expect(result).toEqual({ verdict: "unsupported", overridden: false, reason: null });
  });

  it("reviewed finding: still detects a year mismatch when BOTH the claim and evidence end their sentence right after the year — the original regex silently missed this, the most ordinary claim phrasing", () => {
    const result = applyNumericGate({
      claimText: "Bloomberg reported that Apple's market capitalization surpassed $3.5 trillion in 2024.",
      verdict: "contradicted",
      evidence: "Apple's market capitalization was $3.2 trillion in 2025.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: false, reason: null });
  });

  it("reviewed finding: a dollar-prefixed number in the same numeric range as a year is not misread as a year", () => {
    const result = applyNumericGate({
      claimText: "The foundation awarded a $2000 stipend in 2024.",
      verdict: "unsupported",
      evidence: "In 2024, the foundation awarded a $1998 stipend.",
    });
    // Years match (2024=2024); the guard must not treat "$1998" as a competing year 1998.
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "equality_comparison" });
  });

  it("abstains when evidence contains more than one number — whole-sentence evidence (D026 §7) can contain an unrelated earlier figure extractNumericFact would grab instead", () => {
    const result = applyNumericGate({
      claimText: "UC Riverside's grant reached $50 million.",
      verdict: "unsupported",
      // extractNumericFact would greedily match "$40 million" (the FIRST figure), not the $50
      // million the claim and evidence both actually agree on — must abstain, not force a verdict
      // off the wrong number.
      evidence: "UC Riverside's grant grew from $40 million to $50 million over three years.",
    });
    expect(result).toEqual({ verdict: "unsupported", overridden: false, reason: null });
  });

  it("leaves a threshold claim unchanged when code and VERIFY already agree", () => {
    const result = applyNumericGate({
      claimText: "Revenue exceeded $1 million.",
      verdict: "supported",
      evidence: "Revenue reached $1.4 million.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });
});

describe("gate #2b — year/date comparison (real live-run finding, 2026-08-13: a wrong-year claim was graded supported since gate #2's extractNumericFact never recognizes bare years)", () => {
  it("overrides to contradicted when the same month+day appears with a different year", () => {
    const result = applyYearGate({
      claimText: "Bukowski was born on August 16, 1930.",
      verdict: "supported",
      evidence: "Bukowski was born on August 16, 1920, in Andernach.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "year_role_mismatch" });
  });

  it("overrides to supported when the same month+day+year matches but VERIFY was overly cautious", () => {
    const result = applyYearGate({
      claimText: "Bukowski was born on August 16, 1920.",
      verdict: "unverifiable",
      evidence: "Bukowski was born on August 16, 1920, in Andernach.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: true, reason: "year_role_match" });
  });

  it("does nothing when the month or day differs — not the same dated event", () => {
    const result = applyYearGate({
      claimText: "Bukowski was born on August 16, 1920.",
      verdict: "supported",
      evidence: "Bukowski was born on August 17, 1920, in Andernach.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("overrides to contradicted on the real death-year case (role-anchored, parenthetical range)", () => {
    const result = applyYearGate({
      claimText: "Bukowski's father was Heinrich (Henry) Bukowski, born in 1895 and died in 1948.",
      verdict: "supported",
      evidence: "His father was Heinrich (Henry) Bukowski (1895–1958), an American of German descent.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "year_role_mismatch" });
  });

  it("overrides to supported when a role-anchored parenthetical range matches exactly", () => {
    const result = applyYearGate({
      claimText: "Heinrich (Henry) Bukowski was born in 1895 and died in 1958.",
      verdict: "unverifiable",
      evidence: "His father was Heinrich (Henry) Bukowski (1895–1958), an American of German descent.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: true, reason: "year_role_match" });
  });

  it("overrides to contradicted on a keyword-anchored (non-parenthetical) role mismatch", () => {
    const result = applyYearGate({
      claimText: "Heinrich Bukowski died in 1948.",
      verdict: "supported",
      evidence: "Heinrich Bukowski died in 1958 after a long illness.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "year_role_mismatch" });
  });

  it("(review finding) does NOT match a claim's death year against evidence only stating a birth year, even when the numbers happen to be equal", () => {
    const result = applyYearGate({
      claimText: "Heinrich Bukowski died in 1948.",
      verdict: "unverifiable",
      evidence: "Heinrich Bukowski was born in 1948.",
    });
    expect(result).toEqual({ verdict: "unverifiable", overridden: false, reason: null });
  });

  it("(review finding) does NOT match when the role-anchored year belongs to a different, unrelated named entity", () => {
    const result = applyYearGate({
      claimText: "Charles Bukowski was born in 1920.",
      verdict: "unverifiable",
      evidence: "John Smith was born in 1920 in a small town.",
    });
    expect(result).toEqual({ verdict: "unverifiable", overridden: false, reason: null });
  });

  it("(review finding) does NOT force supported when the matched date sits inside hedged/disputed evidence", () => {
    const result = applyYearGate({
      claimText: "Bukowski was born on August 16, 1920.",
      verdict: "unverifiable",
      evidence: "Bukowski was reportedly born on August 16, 1920, according to unreliable early biographers.",
    });
    expect(result).toEqual({ verdict: "unverifiable", overridden: false, reason: null });
  });

  it("still forces contradicted on a genuine mismatch even inside hedged evidence — a wrong value is wrong regardless of confidence", () => {
    const result = applyYearGate({
      claimText: "Bukowski was born on August 16, 1930.",
      verdict: "supported",
      evidence: "Bukowski was reportedly born on August 16, 1920, according to unreliable early biographers.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "year_role_mismatch" });
  });

  it("does nothing when there is no evidence to compare against", () => {
    const result = applyYearGate({
      claimText: "Bukowski was born on August 16, 1920.",
      verdict: "unsupported",
      evidence: null,
    });
    expect(result).toEqual({ verdict: "unsupported", overridden: false, reason: null });
  });

  it("does nothing on an ordinary sentence with no recognizable date structure on either side", () => {
    const result = applyYearGate({
      claimText: "The company was profitable in 1998.",
      verdict: "supported",
      evidence: "By 2005 the company had expanded internationally.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  // Code-review findings, 2026-08-16 — all reproduced live against the pre-fix code before fixing.

  it("(review finding) never overwrites an already-contradicted verdict back to supported on an unrelated date match — a coincidentally-matching date doesn't excuse a genuine mismatch gate #2 already found on a different fact", () => {
    const result = applyYearGate({
      claimText: "The company's revenue was $500 million, founded on August 16, 1920.",
      // Simulates gate #2 having already, correctly, flipped this to contradicted over the wrong revenue figure.
      verdict: "contradicted",
      evidence: "The company's revenue was $300 million. It was founded on August 16, 1920, in Chicago.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: false, reason: null });
  });

  it("(review finding) Detector 1 (month+day) abstains when claim and evidence name clearly different, unrelated subjects", () => {
    const result = applyYearGate({
      claimText: "Alice's wedding was announced for June 5, 2021.",
      verdict: "unverifiable",
      evidence: "Bob Smith won the marathon on June 5, 2019, setting a new record.",
    });
    expect(result).toEqual({ verdict: "unverifiable", overridden: false, reason: null });
  });

  it("(review finding) the entity guard is not defeated by a shared month name alone — two different people both 'born in December' must not match", () => {
    const result = applyYearGate({
      claimText: "Ada Lovelace was born on December 10, 1815.",
      verdict: "unverifiable",
      evidence: "Nikola Tesla was born on December 25, 1856.",
    });
    expect(result).toEqual({ verdict: "unverifiable", overridden: false, reason: null });
  });

  it("(review finding) a year-shaped substring inside a longer digit run (e.g. a record number) is not extracted as a role year", () => {
    const result = applyYearGate({
      claimText: "Heinrich Bukowski died in 1937.",
      verdict: "unverifiable",
      evidence: "Heinrich Bukowski died; see record no. 1937004 in the archive index.",
    });
    expect(result).toEqual({ verdict: "unverifiable", overridden: false, reason: null });
  });

  // Real live-run finding, 2026-08-17/18: "Pluto was reclassified... in 2005" against evidence
  // agreeing "2006" was graded supported — ROLE_KEYWORDS had no "reclassified" entry, so this
  // gate abstained entirely instead of catching a plain, unambiguous year mismatch.
  it("overrides to contradicted on the real Pluto reclassification-year miss", () => {
    const result = applyYearGate({
      claimText: "Pluto was reclassified as a dwarf planet by the International Astronomical Union in 2005.",
      verdict: "supported",
      evidence: "In 2006, the International Astronomical Union (IAU) reclassified Pluto as a dwarf planet.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "year_role_mismatch" });
  });

  it("overrides to supported on a matching reclassification year", () => {
    const result = applyYearGate({
      claimText: "Pluto was reclassified as a dwarf planet in 2006.",
      verdict: "unverifiable",
      evidence: "In 2006, the International Astronomical Union reclassified Pluto as a dwarf planet.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: true, reason: "year_role_match" });
  });

  it("recognizes the new 'launched' role", () => {
    const result = applyYearGate({
      claimText: "The satellite Voyager 2 was launched in 1978.",
      verdict: "supported",
      evidence: "Voyager 2 was launched in 1977, a year before its sister probe.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "year_role_mismatch" });
  });

  it("recognizes the new 'released' role", () => {
    const result = applyYearGate({
      claimText: "The film was released in 2001.",
      verdict: "supported",
      evidence: "The film was released in 1999 to critical acclaim.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "year_role_mismatch" });
  });

  // Review finding, 2026-08-18: widening ROLE_YEAR_WINDOW to 100 (tried first) let "nearest year
  // wins" reach past the claim's own entity into an unrelated relative's year, 93 chars from the
  // keyword — reproduced live, then fixed by settling on 80 instead. This locks in the fix.
  it("(review finding) does NOT reach past a different named relative's year at the widened window distance", () => {
    const result = applyYearGate({
      claimText: "Charles Bukowski was born in 1920.",
      verdict: "supported",
      evidence:
        "Charles Bukowski was born in the city of Andernach, in the German Rhineland region, while his brother was born in 1925.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });
});

describe("reason-consistency gate (real live-eval findings, 2026-08-06)", () => {
  it("forces contradicted when the reason explicitly says 'directly contradicting the claim' (g04)", () => {
    const result = applyReasonConsistencyGate({
      verdict: "unsupported",
      reason: "The passage states that World War II began in 1939 and ended in 1945, directly contradicting the claim that it ended in 1943.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "contradiction_language_in_model_reason" });
  });

  it("does NOT catch a bare 'X, not Y' correction with no contradiction verb (g05 — a real, known, separate gap)", () => {
    // "a gift from France, not Canada" uses none of CONTRADICTION_LANGUAGE_RE's verbs — deliberately
    // not force-matched here: a bare `,\s*not\b` pattern would false-positive on filler phrases like
    // "grew significantly, not surprisingly" or "not coincidentally". Needs a real prompt-side fix
    // (clearer VERDICT/REASON language) or a claim-aware heuristic, not a blind regex widening.
    const result = applyReasonConsistencyGate({
      verdict: "unsupported",
      reason: "The passage states the statue was a gift from France, not Canada.",
    });
    expect(result).toEqual({ verdict: "unsupported", overridden: false, reason: null });
  });

  it("leaves a verdict already at contradicted unchanged", () => {
    const result = applyReasonConsistencyGate({ verdict: "contradicted", reason: "This contradicts the claim." });
    expect(result).toEqual({ verdict: "contradicted", overridden: false, reason: null });
  });

  it("does nothing when there's no reason", () => {
    const result = applyReasonConsistencyGate({ verdict: "supported", reason: null });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("does not fire on a negated contradiction ('does not contradict')", () => {
    const result = applyReasonConsistencyGate({
      verdict: "supported",
      reason: "This does not contradict the earlier report.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("does nothing when the reason has no contradiction language at all", () => {
    const result = applyReasonConsistencyGate({
      verdict: "supported",
      reason: "The passage directly confirms the claim's figures.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("D026 §22, real bug: does NOT force-flip a CONFIDENCE-downgraded 'unverifiable' back to 'contradicted', even though its reason still legitimately describes the conflict it was downgraded from", () => {
    // Same exclusion applyImplicitNegationGate already has, for the same reason — 'unverifiable' is
    // a confidence-level downgrade of whatever relationship was found, not a different relationship
    // judgment, so it must not be treated as a verdict this gate should override.
    const result = applyReasonConsistencyGate({
      verdict: "unverifiable",
      reason: "The passage states the bridge opened in 1931, which conflicts with the claim's 1937 date, but the match is only approximate so confidence is low.",
    });
    expect(result).toEqual({ verdict: "unverifiable", overridden: false, reason: null });
  });
});

describe("Case A gate — implicit negation, bare 'X, not Y' (D022 §4, real live-eval gap: g05)", () => {
  it("forces contradicted for the real g05 case: 'gift from France, not Canada', a second entity (United States) shared with the passage", () => {
    const result = applyImplicitNegationGate({
      verdict: "unsupported",
      reason: "The passage states the statue was a gift from France, not Canada.",
      claimText: "The Statue of Liberty was a gift from Canada to the United States, unveiled in 1886.",
      passageText: "The Statue of Liberty was a gift from France to the United States, dedicated in 1886 to celebrate the friendship between the two nations.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "bare_negation_matched" });
  });

  it("abstains (retrieval-miss counter-example) when the passage shares no entity with the claim beyond Y", () => {
    const result = applyImplicitNegationGate({
      verdict: "unsupported",
      reason: "The passage states the gift was from France, not Canada.",
      claimText: "The Statue of Liberty was a gift from Canada.",
      passageText: "France has given many diplomatic gifts to other nations over the centuries.",
    });
    expect(result).toEqual({ verdict: "unsupported", overridden: false, reason: null });
  });

  it("abstains on a common-noun-only Y (no proper-noun claim entity to match against)", () => {
    const result = applyImplicitNegationGate({
      verdict: "unsupported",
      reason: "The passage says the material is steel, not concrete.",
      claimText: "The bridge is made of concrete.",
      passageText: "The bridge is made of steel, a common material for suspension bridges.",
    });
    expect(result).toEqual({ verdict: "unsupported", overridden: false, reason: null });
  });

  it("abstains on a single-entity claim ('the winner was Bob, not Alice') — accepted recall cost, condition 3 by design (D022 §4)", () => {
    const result = applyImplicitNegationGate({
      verdict: "unsupported",
      reason: "The passage says the winner was Bob, not Alice.",
      claimText: "The winner of the race was Alice.",
      passageText: "The winner of the race was Bob, who finished in record time.",
    });
    expect(result).toEqual({ verdict: "unsupported", overridden: false, reason: null });
  });

  it("leaves a verdict already at contradicted unchanged", () => {
    const result = applyImplicitNegationGate({
      verdict: "contradicted",
      reason: "The passage says France, not Canada.",
      claimText: "The gift was from Canada to the United States.",
      passageText: "The gift was from France to the United States.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: false, reason: null });
  });

  it("does nothing when there's no reason", () => {
    const result = applyImplicitNegationGate({
      verdict: "unsupported",
      reason: null,
      claimText: "The gift was from Canada.",
      passageText: "The gift was from France.",
    });
    expect(result).toEqual({ verdict: "unsupported", overridden: false, reason: null });
  });

  it("does not fire when the reason has no 'X, not Y' shape at all", () => {
    const result = applyImplicitNegationGate({
      verdict: "supported",
      reason: "The passage directly confirms the claim.",
      claimText: "The gift was from France to the United States.",
      passageText: "The gift was from France to the United States.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("does not fire when Y isn't actually present in the claim text (a different correction, not this claim's negation)", () => {
    const result = applyImplicitNegationGate({
      verdict: "unsupported",
      reason: "The passage discusses trade policy, not tariffs.",
      claimText: "The Statue of Liberty was a gift from Canada to the United States.",
      passageText: "The Statue of Liberty was a gift from France to the United States.",
    });
    expect(result).toEqual({ verdict: "unsupported", overridden: false, reason: null });
  });

  it("does not swallow trailing words after Y into the match (regex fix — 'not Canada to the United States' must capture only 'Canada')", () => {
    const result = applyImplicitNegationGate({
      verdict: "unsupported",
      reason: "The passage states it was a gift from France, not Canada to the United States.",
      claimText: "The Statue of Liberty was a gift from Canada to the United States, unveiled in 1886.",
      passageText: "The Statue of Liberty was a gift from France to the United States, dedicated in 1886.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "bare_negation_matched" });
  });

  it("abstains on a single-entity claim even when Y is multi-word (fix — a multi-word Y's own words no longer count as the second entity)", () => {
    const result = applyImplicitNegationGate({
      verdict: "unsupported",
      reason: "Museum records show the painting was donated by an anonymous donor, not the United Kingdom.",
      claimText: "The painting was donated by the United Kingdom.",
      passageText: "Some visitors assume the painting was donated by the United Kingdom, but museum records list the donor as anonymous.",
    });
    expect(result).toEqual({ verdict: "unsupported", overridden: false, reason: null });
  });

  it("does not fire on a correct 'supported' verdict, even when the reason has a narrative 'X, not Y' correction shape", () => {
    const result = applyImplicitNegationGate({
      verdict: "supported",
      reason: "The article confirms the current mascot is Wildcat, not Tiger as it was previously known, matching the claim.",
      claimText: "The team's mascot, previously called Tiger, is now called Wildcat.",
      passageText: "The team's mascot was renamed from Tiger to Wildcat last season.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("does not fire on 'unverifiable' — a confidence downgrade this gate must not override", () => {
    const result = applyImplicitNegationGate({
      verdict: "unverifiable",
      reason: "The passage states the gift was from France, not Canada.",
      claimText: "The Statue of Liberty was a gift from Canada to the United States.",
      passageText: "The Statue of Liberty was a gift from France to the United States, dedicated in 1886.",
    });
    expect(result).toEqual({ verdict: "unverifiable", overridden: false, reason: null });
  });

  it("does NOT catch the real g11-mixed-content Einstein case: 'won for relativity' vs 'won for the photoelectric effect' (named, known, separate gap)", () => {
    // Real production reason text (run 9eed3c3a, 2026-08-07) — mutually exclusive award-reasons
    // for the same Nobel Prize, but phrased as "does not state X... it mentions Y instead", not
    // IMPLICIT_NEGATION_RE's bare ", not Y" shape (g05's "gift from France, not Canada"). Widening
    // the regex to catch this too would mean matching "does not... mentions Y instead" generally —
    // a much broader, under-tested pattern, exactly what this file's own incident history (see
    // gates.ts's applyReasonConsistencyGate doc comment) warns against introducing casually. Needs
    // a real VERIFY-prompt fix (asking the model to state contradictions explicitly) or a
    // claim-aware heuristic, not a blind regex widening — same category of gap as the g05 test above.
    const result = applyImplicitNegationGate({
      verdict: "unsupported",
      reason:
        "The passage lists many of Einstein's known for contributions, including General Relativity and Special Relativity, but it does not explicitly state that he won the Nobel Prize for his theory of relativity. It mentions he won the Nobel Prize for his discovery of the law of the photoelectric effect.",
      claimText: "Albert Einstein won the Nobel Prize in Physics for his theory of relativity.",
      passageText:
        "Einstein won the 1921 Nobel Prize in Physics for his services to theoretical physics, and especially for his discovery of the law of the photoelectric effect.",
    });
    expect(result).toEqual({ verdict: "unsupported", overridden: false, reason: null });
  });
});

describe("gate #5 — counterfact-ignored, LLM-classifier-driven (D025, real live-eval finding: g04 recurrence)", () => {
  it("flags when the classifier says the reason doesn't support the verdict", () => {
    const result = applyCounterfactIgnoredGate({ verdict: "unsupported", reasonSupportsVerdict: false });
    expect(result).toEqual({ flagged: true, reason: "counterfact_ignored" });
  });

  it("does nothing when the classifier says the reason does support the verdict", () => {
    const result = applyCounterfactIgnoredGate({ verdict: "unsupported", reasonSupportsVerdict: true });
    expect(result).toEqual({ flagged: false, reason: null });
  });

  it("does nothing when the classifier result is null (skipped upstream or the call failed)", () => {
    const result = applyCounterfactIgnoredGate({ verdict: "unsupported", reasonSupportsVerdict: null });
    expect(result).toEqual({ flagged: false, reason: null });
  });

  it("never fires on a verdict already 'contradicted' — mutually exclusive with gate #1 (D025 §3)", () => {
    const result = applyCounterfactIgnoredGate({ verdict: "contradicted", reasonSupportsVerdict: false });
    expect(result).toEqual({ flagged: false, reason: null });
  });

  it("never changes the verdict itself, unlike gates #1-4 — only ever flags for a reconciliation retry", () => {
    const result = applyCounterfactIgnoredGate({ verdict: "unsupported", reasonSupportsVerdict: false });
    expect(result).not.toHaveProperty("verdict");
  });
});

describe("reason/verdict consistency gate — year mismatch (candidate; NOT wired into runGateChain, tasks.md Phase 35/36)", () => {
  const claim = "The International Astronomical Union reclassified Pluto as a dwarf planet in 2005.";
  const altYearSentence = "The International Astronomical Union confirms Pluto's reclassification occurred in 2006.";

  it("forces contradicted when reason states only a different year for the claim's fact (Pluto run 7 shape)", () => {
    const result = applyReasonYearGate({ verdict: "supported", claimText: claim, reason: altYearSentence });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "reason_year_mismatch" });
  });

  it("forces contradicted when the claim's year is a NEGATED mention, not a confirmation (Pluto run 8 shape)", () => {
    const reason =
      "None of the provided sentences mention the year 2005 in relation to the International Astronomical Union's reclassification of Pluto. " +
      altYearSentence;
    const result = applyReasonYearGate({ verdict: "supported", claimText: claim, reason });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "reason_year_mismatch" });
  });

  it("does nothing when reason positively confirms the claim's own year among others", () => {
    const reason = "Multiple sources confirm the reclassification occurred in 2005, though a minority report incorrectly cited 1999.";
    const result = applyReasonYearGate({ verdict: "supported", claimText: claim, reason });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("abstains on a compound claim with 2+ year tokens — scope-limiting guard", () => {
    const compoundClaim = "Pluto was discovered in 1930 and reclassified as a dwarf planet in 2005.";
    const result = applyReasonYearGate({ verdict: "supported", claimText: compoundClaim, reason: altYearSentence });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("abstains when reason mentions no year at all", () => {
    const reason = "Sources broadly agree with the claim as stated, with no specific date given.";
    const result = applyReasonYearGate({ verdict: "supported", claimText: claim, reason });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("no-ops on a verdict already contradicted", () => {
    const result = applyReasonYearGate({ verdict: "contradicted", claimText: claim, reason: altYearSentence });
    expect(result).toEqual({ verdict: "contradicted", overridden: false, reason: null });
  });

  it("no-ops on 'unverifiable' — CONFIDENCE-downgrade exclusion, mirrors applyReasonConsistencyGate", () => {
    const result = applyReasonYearGate({ verdict: "unverifiable", claimText: claim, reason: altYearSentence });
    expect(result).toEqual({ verdict: "unverifiable", overridden: false, reason: null });
  });

  it("still forces contradicted when reason also uses explicit contradiction language — no conflict with applyReasonConsistencyGate", () => {
    const reason =
      "This contradicts the claim; the International Astronomical Union confirms Pluto's reclassification occurred in 2006, not 2005.";
    const result = applyReasonYearGate({ verdict: "supported", claimText: claim, reason });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "reason_year_mismatch" });
  });

  it("(review finding) abstains when reason mentions an unrelated year for a DIFFERENT fact — locality guard", () => {
    const reason = "The source discusses Pluto's reclassification but does not mention 2005. The IAU was founded in 1919.";
    const result = applyReasonYearGate({ verdict: "supported", claimText: claim, reason });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  // Review finding: a decimal point ("$3.5 million") was being treated as a sentence terminator,
  // splitting the sentence mid-number and losing the entity terms the locality check needs.
  it("(review finding) a dollar figure with a decimal point next to the year doesn't defeat the locality check", () => {
    const reason = "The International Astronomical Union confirmed a $3.5 million budget when it reclassified Pluto in 2006.";
    const result = applyReasonYearGate({ verdict: "supported", claimText: claim, reason });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "reason_year_mismatch" });
  });

  describe("negation-window adversarial phrasings", () => {
    it("'did not occur in 2005' — negated", () => {
      const reason = "The reclassification did not occur in 2005. " + altYearSentence;
      const result = applyReasonYearGate({ verdict: "supported", claimText: claim, reason });
      expect(result.verdict).toBe("contradicted");
    });

    it("'None of the sources mention the year 2005' — negated", () => {
      const reason =
        "None of the sources mention the year 2005 regarding the International Astronomical Union's reclassification of Pluto. " + altYearSentence;
      const result = applyReasonYearGate({ verdict: "supported", claimText: claim, reason });
      expect(result.verdict).toBe("contradicted");
    });

    it("'never occurred in 2005' — negated", () => {
      const reason = "The reclassification never occurred in 2005. " + altYearSentence;
      const result = applyReasonYearGate({ verdict: "supported", claimText: claim, reason });
      expect(result.verdict).toBe("contradicted");
    });

    it("'Notably, 2005 was...' — NOT negated (word boundary stops 'not' matching inside 'notably')", () => {
      const reason = "Notably, 2005 was suggested by early reports. " + altYearSentence;
      const result = applyReasonYearGate({ verdict: "supported", claimText: claim, reason });
      expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
    });

    it("'not X; the event occurred in 2005' — NOT negated (clause boundary stops negation crossing the semicolon)", () => {
      const reason = "This is not correct; the reclassification occurred in 2005. " + altYearSentence;
      const result = applyReasonYearGate({ verdict: "supported", claimText: claim, reason });
      expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
    });

    // Review finding: "n't" has no leading \b (contractions have no word boundary before 'n') —
    // a naive \b-wrapped alternation silently never matches "wasn't"/"didn't"/etc.
    it("'wasn't dated 2005' — negated (contraction, no word boundary before 'n't')", () => {
      const reason = "The reclassification wasn't dated 2005; it occurred in 2006. " + altYearSentence;
      const result = applyReasonYearGate({ verdict: "supported", claimText: claim, reason });
      expect(result.verdict).toBe("contradicted");
    });

    // Review finding: the decimal point in "$3.5 million" was wrongly treated as a clause boundary,
    // stripping an earlier negation word ("never") from the window tested for negation.
    it("'never confirmed a $3.5 million reclassification in 2005' — negated (decimal point isn't a clause boundary)", () => {
      const reason = "The IAU never confirmed a $3.5 million reclassification in 2005. " + altYearSentence;
      const result = applyReasonYearGate({ verdict: "supported", claimText: claim, reason });
      expect(result.verdict).toBe("contradicted");
    });
  });
});

describe("reason/verdict consistency gate — ordinal mismatch (D030, tasks.md T002/T003)", () => {
  // The real regression this gate exists for (tasks.md Phase 34, D030 §1): VERIFY's own reason
  // correctly named the fourth-and-final flight, but the stored verdict still said `supported`.
  it("real Wright-brothers regression: forces contradicted when reason names a different ordinal on the same anchor", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "The first flight covered 852 ft.",
      reason: "The passage states the airplane flew 852 ft on its fourth and final flight.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "reason_ordinal_mismatch" });
  });

  it("fires on a plain second/third-attempt mismatch", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "The second attempt reached 100m.",
      reason: "The evidence indicates the third attempt reached 100m.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "reason_ordinal_mismatch" });
  });

  it("(data-model.md §1 matrix) fires when a modifier sits between the ordinal and its anchor noun", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "The second attempt reached 100m.",
      reason: "The third unsuccessful attempt reached 100m.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "reason_ordinal_mismatch" });
  });

  it("fires under negation — 'it was not the first flight'", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "The first flight covered 852 ft.",
      reason: "It was not the first flight; the fourth and final flight reached 852 ft.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "reason_ordinal_mismatch" });
  });

  it("fires when a real competing ordinal is mixed with a discourse-enumeration ordinal in the same reason", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "The first flight covered 852 ft.",
      reason: "First, the source discusses the history of the program. The fourth flight covered 852 ft.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "reason_ordinal_mismatch" });
  });

  it("does NOT fire when reason restates the claim's own ordinal+anchor, even alongside a different ordinal at the same value", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "The first flight covered 852 ft.",
      reason: "The passage states the first flight reached 852 ft, while the fourth flight also reached 852 ft.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("abstains on discourse-enumeration ordinals with no anchor noun attached ('First,... Second,...')", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "The first flight covered 852 ft.",
      reason: "First, the source reports 852 ft. Second, it says the flight lasted 59 seconds.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("abstains (via confirmation precedence) when reason mentions the claim's own ordinal+anchor ambiguously alongside another", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "The first flight covered 852 ft.",
      reason: "The passage discusses the first flight and later the fourth flight.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  // Reviewer-flagged adversarial case: a competing ordinal on the same anchor coexists with the
  // claim's own ordinal+anchor also appearing (at a different, unrelated value) — confirmation
  // precedence means this abstains rather than confidently firing on a genuinely ambiguous case.
  it("abstains when the claim's own ordinal+anchor also appears in reason, even at a different value", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "The first flight covered 852 ft.",
      reason: "The fourth flight covered 852 ft, while the first flight lasted 59 seconds.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("abstains when the claim has zero ordinal words", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "The flight covered 852 ft.",
      reason: "The fourth flight covered 852 ft.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("abstains on a compound claim with 2+ ordinal words — scope-limiting guard, same precedent as applyReasonYearGate's 2+ year abstain", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "The first flight covered 852 ft and the second flight covered 900 ft.",
      reason: "The fourth flight covered 852 ft.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("abstains when reason contains no ordinal words at all", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "The first flight covered 852 ft.",
      reason: "The passage confirms the distance figure.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("no-ops on a verdict already contradicted", () => {
    const result = applyReasonOrdinalGate({
      verdict: "contradicted",
      claimText: "The first flight covered 852 ft.",
      reason: "The fourth flight covered 852 ft.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: false, reason: null });
  });

  it("no-ops on 'unverifiable' — CONFIDENCE-downgrade exclusion, same precedent as applyReasonYearGate", () => {
    const result = applyReasonOrdinalGate({
      verdict: "unverifiable",
      claimText: "The first flight covered 852 ft.",
      reason: "The fourth flight covered 852 ft.",
    });
    expect(result).toEqual({ verdict: "unverifiable", overridden: false, reason: null });
  });

  it("no-ops when reason is null", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "The first flight covered 852 ft.",
      reason: null,
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  // Review finding (code-review, high effort): a decimal point near the ordinal was being treated
  // as a clause boundary, truncating the anchor window to nothing and silently defeating the gate —
  // same bug class isSentenceTerminator was introduced to fix for the year gate's negation window.
  it("(review finding) a decimal-figure near the ordinal doesn't collapse the anchor window to empty", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "This was the third $3.5 million funding round for the company.",
      reason: "Filings show this was the fourth $3.5 million funding round for the company.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "reason_ordinal_mismatch" });
  });

  // Review finding (code-review, high effort): two unrelated ordinal mentions sharing only a
  // generic preposition ("for") as their second anchor word were wrongly treated as the same
  // anchor, forcing a false contradiction between claims about entirely different facts.
  it("(review finding) a shared generic preposition alone does not count as anchor overlap", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "This was the third time for the team.",
      reason: "Sources say it was the second attempt for the group.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });
});

// T009 (D030, spec.md SC-002) — held-out generalization measurement, deliberately different
// domains/phrasing from T002's fixture set (flights/attempts) so this isn't just re-testing the
// same cases the implementation was tuned against.
describe("reason/verdict consistency gate — ordinal mismatch: held-out generalization (T009, SC-002)", () => {
  // Must NOT fire — genuinely correct claim/reason pairs. False-downgrade rate on this set is a
  // hard requirement of zero (SC-002); this is the dangerous failure direction.
  const heldOutCorrect: Array<{ claim: string; reason: string }> = [
    { claim: "The second novel in the series was published in 1998.", reason: "The series' second novel was published in 1998, according to the publisher's archive." },
    { claim: "The third experiment yielded a positive result.", reason: "Researchers confirmed the third experiment yielded a positive result in their published paper." },
    { claim: "The fifth season premiered in March.", reason: "The network's fifth season premiered in March, ahead of the previous year's April launch." },
    { claim: "The first candidate withdrew from the race.", reason: "News reports confirm the first candidate withdrew from the race shortly before the primary." },
    { claim: "The seventh album topped the charts.", reason: "The artist's seventh album topped the charts upon release, label records show." },
    { claim: "The fourth prototype passed all tests.", reason: "Engineers confirmed the fourth prototype passed all tests during the final review." },
    { claim: "The second referendum failed to pass.", reason: "Official results show the second referendum failed to pass by a narrow margin." },
    { claim: "The eighth episode revealed the twist.", reason: "Viewers were surprised when the eighth episode revealed the twist, critics noted." },
    { claim: "The third quarter showed revenue growth.", reason: "The company's third quarter showed revenue growth compared to the prior year." },
    { claim: "The sixth chapter introduced the villain.", reason: "The book's sixth chapter introduced the villain, per a published summary." },
  ];

  // Must fire — genuine ordinal contradictions, same domains as above with a different competing
  // ordinal on the same anchor. Recall on this set is measured and reported, not required to hit
  // 100% (SC-002) — 100% on a hand-built set isn't evidence of generalization by itself.
  const heldOutContradictions: Array<{ claim: string; reason: string }> = [
    { claim: "The second novel in the series was published in 1998.", reason: "Records show the third novel in the series was published in 1998." },
    { claim: "The third experiment yielded a positive result.", reason: "The report states the second experiment yielded a positive result." },
    { claim: "The fifth season premiered in March.", reason: "According to the network, the sixth season premiered in March." },
    { claim: "The first candidate withdrew from the race.", reason: "News sources confirm the second candidate withdrew from the race." },
    { claim: "The seventh album topped the charts.", reason: "Chart data shows the eighth album topped the charts upon release." },
    { claim: "The fourth prototype passed all tests.", reason: "Engineering logs show the fifth prototype passed all tests." },
    { claim: "The second referendum failed to pass.", reason: "Official records show the first referendum failed to pass." },
    { claim: "The eighth episode revealed the twist.", reason: "Critics noted that the ninth episode revealed the twist." },
    { claim: "The third quarter showed revenue growth.", reason: "Financial filings show the fourth quarter showed revenue growth." },
    { claim: "The sixth chapter introduced the villain.", reason: "Reviewers noted the seventh chapter introduced the villain." },
  ];

  it("false-downgrade rate on held-out correct claims is zero (hard requirement, SC-002)", () => {
    const falseDowngrades = heldOutCorrect.filter(({ claim, reason }) => {
      const result = applyReasonOrdinalGate({ verdict: "supported", claimText: claim, reason });
      return result.overridden;
    });
    expect(falseDowngrades, `Unexpected false downgrades: ${JSON.stringify(falseDowngrades)}`).toHaveLength(0);
  });

  // Reports the actual recall rate rather than asserting a specific number — this is a measurement,
  // not a pass/fail gate (SC-002 explicitly does not require 100%). Observed: 10/10 on this set —
  // recorded here so a future change to the anchor/negation logic has a concrete regression signal.
  it("contradiction-detection recall on held-out mismatches (measured, not required to hit 100%)", () => {
    const caught = heldOutContradictions.filter(({ claim, reason }) => {
      const result = applyReasonOrdinalGate({ verdict: "supported", claimText: claim, reason });
      return result.overridden && result.reason === "reason_ordinal_mismatch";
    });
    console.log(`[T009] ordinal-gate held-out recall: ${caught.length}/${heldOutContradictions.length}`);
    expect(caught).toHaveLength(10);
  });
});
