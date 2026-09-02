import { describe, it, expect } from "vitest";
import {
  applyAffirmationEvidenceGate,
  applyClaimReasonOverlapGate,
  applyContradictionEvidenceGate,
  applyCounterfactIgnoredGate,
  applyInstanceAttributionGate,
  applyImplicitNegationGate,
  applyNumericGate,
  applyReasonConsistencyGate,
  applyReasonOrdinalGate,
  applyReasonYearGate,
  applySubjectEntityGate,
  applyYearGate,
  composeUserFacingReason,
  labelSubjectEntityDowngrade,
  rewriteUngroundedAffirmativeReason,
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
      claimText: "World War II ended in 1943.",
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
      claimText: "The Statue of Liberty was a gift from France.",
      reason: "The passage states the statue was a gift from France, not Canada.",
    });
    expect(result).toEqual({ verdict: "unsupported", overridden: false, reason: null });
  });

  it("leaves a verdict already at contradicted unchanged", () => {
    const result = applyReasonConsistencyGate({ verdict: "contradicted", claimText: "The bridge opened in 1937.", reason: "This contradicts the claim." });
    expect(result).toEqual({ verdict: "contradicted", overridden: false, reason: null });
  });

  it("does nothing when there's no reason", () => {
    const result = applyReasonConsistencyGate({ verdict: "supported", claimText: "The bridge opened in 1937.", reason: null });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("does not fire on a negated contradiction ('does not contradict')", () => {
    const result = applyReasonConsistencyGate({
      verdict: "supported",
      claimText: "The report is accurate.",
      reason: "This does not contradict the earlier report.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("does nothing when the reason has no contradiction language at all", () => {
    const result = applyReasonConsistencyGate({
      verdict: "supported",
      claimText: "The passage's figures are accurate.",
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
      claimText: "The bridge opened in 1937.",
      reason: "The passage states the bridge opened in 1931, which conflicts with the claim's 1937 date, but the match is only approximate so confidence is low.",
    });
    expect(result).toEqual({ verdict: "unverifiable", overridden: false, reason: null });
  });

  describe("negation-scope guard (D032 §9/§3k) — claim's own negation must not be read as the negated fact asserted positively", () => {
    // Real captured reason (D032 §3k) — "World War II did not end in 1943" is TRUE; the reason's
    // own verdict was `supported`, but its prose says "contradicts", which is what this gate keyed
    // on pre-fix. 7/10 real repetitions took exactly this path to a false accusation.
    it("abstains on the real WWII case even though the reason literally says 'contradicts'", () => {
      const result = applyReasonConsistencyGate({
        verdict: "supported",
        claimText: "World War II did not end in 1943.",
        reason:
          "The passage states that World War II ended on September 2, 1945, and that it lasted from 1939 to 1945, which contradicts the claim that it did not end in 1943.",
      });
      expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
    });

    it("abstains on a negated claim with the strongest 'directly contradicting' phrasing too", () => {
      const result = applyReasonConsistencyGate({
        verdict: "supported",
        claimText: "Microsoft did not create the iPhone.",
        reason: "Apple created the iPhone, directly contradicting any claim that Microsoft did.",
      });
      expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
    });

    it("still fires on a non-negated claim with the same contradiction language (no regression)", () => {
      const result = applyReasonConsistencyGate({
        verdict: "unsupported",
        claimText: "World War II ended in 1943.",
        reason: "The passage states that World War II ended in 1945, directly contradicting the claim that it ended in 1943.",
      });
      expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "contradiction_language_in_model_reason" });
    });

    // (review finding) Known, accepted gap — presence-only scoping (containsNegationCue's own doc
    // comment, D032 §9c): this gate has no single extracted claim token to scope a check around, so
    // an unrelated negation ANYWHERE in a compound claim also suppresses a genuine contradiction
    // catch elsewhere in the same claim. Safe-side (lost detection, not a manufactured accusation —
    // same asymmetry the Cardinal Rule treats as acceptable), and EXTRACT's own atomicity rule means
    // a real compound claim like this shouldn't reach VERIFY as one claim in the first place — but
    // that rule isn't code-enforced, so this stays a real, documented gap, not a hypothetical one.
    it("(known gap) an unrelated negation elsewhere in a compound claim suppresses a genuine, unrelated contradiction catch", () => {
      const result = applyReasonConsistencyGate({
        verdict: "supported",
        claimText: "The unarmed suspect, who did not resist arrest, was taken into custody in 1990.",
        reason: "Sources contradict the claim; records show custody was taken in 1975.",
      });
      // Documents current behavior (abstains) rather than asserting it's correct — this is exactly
      // the accepted tradeoff, not a case this gate is claimed to handle.
      expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
    });
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

describe("instance-attribution gate — passage-grounded, LLM-checker-driven (spec 013 T21, the g17 shape)", () => {
  it("forces contradicted when the passages attribute the fact to a different member — the real g17 failure", () => {
    const result = applyInstanceAttributionGate({ claimText: "The first flight covered 852 feet.", verdict: "supported", attribution: "different" });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "instance_attribution_mismatch" });
  });

  it("leaves the verdict alone on 'same'", () => {
    const result = applyInstanceAttributionGate({ claimText: "The first flight covered 852 feet.", verdict: "supported", attribution: "same" });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("leaves the verdict alone on 'absent' — the checker's abstain, and its most common answer", () => {
    const result = applyInstanceAttributionGate({ claimText: "The first flight covered 852 feet.", verdict: "supported", attribution: "absent" });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("downgrades rather than accuses on 'conflict' — disagreeing sources are not a falsehood finding (Cardinal Rule)", () => {
    const result = applyInstanceAttributionGate({ claimText: "The first flight covered 852 feet.", verdict: "supported", attribution: "conflict" });
    expect(result).toEqual({ verdict: "unverifiable", overridden: true, reason: "instance_attribution_conflict" });
  });

  it("does not upgrade an unsupported verdict on 'conflict' — the downgrade branch is affirmative-only", () => {
    const result = applyInstanceAttributionGate({ claimText: "The first flight covered 852 feet.", verdict: "unsupported", attribution: "conflict" });
    expect(result).toEqual({ verdict: "unsupported", overridden: false, reason: null });
  });

  it("does nothing when the checker didn't run or failed (fail-open, D025 §2 convention)", () => {
    const result = applyInstanceAttributionGate({ claimText: "The first flight covered 852 feet.", verdict: "supported", attribution: null });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("never re-fires on a verdict already 'contradicted'", () => {
    const result = applyInstanceAttributionGate({ claimText: "The first flight covered 852 feet.", verdict: "contradicted", attribution: "different" });
    expect(result).toEqual({ verdict: "contradicted", overridden: false, reason: null });
  });

  it("abstains on a negated claim — the checker answers about the fact, not its polarity (D032 §9)", () => {
    // "did not cover 852 feet" is TRUE of the first flight; the passages still attribute 852 feet to
    // the fourth, so `different` here would force `contradicted` on a true claim (Cardinal Rule).
    const result = applyInstanceAttributionGate({ claimText: "The first flight did not cover 852 feet.", verdict: "supported", attribution: "different" });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("never fires on 'unverifiable' — that's a CONFIDENCE downgrade, same exclusion the sibling reason gates use (D026 §22)", () => {
    const result = applyInstanceAttributionGate({ claimText: "The first flight covered 852 feet.", verdict: "unverifiable", attribution: "different" });
    expect(result).toEqual({ verdict: "unverifiable", overridden: false, reason: null });
  });

  it("never overrides 'excluded' — exclusion is a scope decision, not a verdict to correct (D032 §3f)", () => {
    const result = applyInstanceAttributionGate({ claimText: "The first flight covered 852 feet.", verdict: "excluded", attribution: "different" });
    expect(result).toEqual({ verdict: "excluded", overridden: false, reason: null });
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

  describe("negation-scope guard (D032 §9/§3k) — claim's own negated year must not be read as a positive assertion", () => {
    // Real captured case, 4/10 repetitions (D032 §3k): "did not end in 1943" is TRUE; the reason
    // names 1945, which CONFIRMS the negation. Pre-fix, this gate read "different year in reason" as
    // a mismatch regardless of the claim's own polarity and forced `contradicted`.
    it("abstains on the real WWII case — a different year in reason confirms, not contradicts, the negation", () => {
      const result = applyReasonYearGate({
        verdict: "supported",
        claimText: "World War II did not end in 1943.",
        reason: "The passage states that World War II lasted from 1939 to 1945 and formally ended on September 2, 1945, which is not 1943.",
      });
      expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
    });

    it("abstains even when reason positively restates the claim's own (negated) year", () => {
      const result = applyReasonYearGate({
        verdict: "supported",
        claimText: "World War II did not end in 1943.",
        reason: "The passage confirms World War II did not end in 1943 — it ended in 1945.",
      });
      expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
    });

    // Review finding: a backward-only negation check misses this real, natural phrasing entirely —
    // the exact same bug in a different word order. isClaimTokenNegated checks both directions.
    it("abstains on POSTPOSED negation too — '1943 is not the year it ended', not just 'did not end in 1943'", () => {
      const result = applyReasonYearGate({
        verdict: "supported",
        claimText: "1943 is not the year World War II ended.",
        reason: "The passage states that World War II ended in 1945.",
      });
      expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
    });

    it("position-scoped, not presence-only: a negation in an earlier, unrelated sentence must not block this gate from firing on the claim's own unnegated year", () => {
      // "never" negates an unrelated fact in the first sentence, well outside both the sentence
      // boundary AND the 60-char window before "2005" — the year token itself carries no negation,
      // so the gate must fire exactly as it does without the prefix (the block's own proven case).
      const result = applyReasonYearGate({
        verdict: "supported",
        claimText: "The IAU never held international press conferences. " + claim,
        reason: altYearSentence,
      });
      expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "reason_year_mismatch" });
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

  // Real live-eval capture (2026-08-22, g17-wright-brothers-ordinal, post-D030-§3f retrieval fix):
  // VERIFY's own reason correctly identified the fourth/longest flight, but phrased it as an
  // appositive — "the longest flight, the fourth and final one" — naming the anchor noun BEFORE the
  // ordinal, with "one" standing in for it afterward. The forward-only anchor window found only
  // "final"/"one" (neither overlaps the claim's "flight" anchor), so this gate abstained and the
  // wrong `supported` verdict shipped. Fixed by also looking backward across the comma to "flight".
  it("real live capture: fires when the reason names the anchor noun BEFORE the ordinal, in a comma-joined appositive with an anaphoric 'one' after it", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "The first flight covered 852 feet.",
      reason: "Multiple sources state that the longest flight, the fourth and final one on December 17, 1903, covered 852 feet.",
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

  // Reviewer-flagged adversarial case, still a required abstain after the value-aware fix below:
  // the claim's own ordinal+anchor appears in reason, but its nearby value is a DIFFERENT UNIT
  // ("59 seconds" vs the claim's "852 ft") — not comparable, so this must not be asserted as a
  // mismatch. This is the landmine a naive value-check would break (D030 §3g follow-up).
  it("abstains when the claim's own ordinal+anchor also appears in reason, at a different-UNIT value", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "The first flight covered 852 ft.",
      reason: "The fourth flight covered 852 ft, while the first flight lasted 59 seconds.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  // D030 §3g follow-up (g17 continued) — value-aware confirmation. The old "ordinal word matches
  // claim's ordinal -> confirmed, return immediately" rule let a same-word/different-value mismatch
  // through uncaught: "first" matches, but the reason pairs it with 120 ft, not the claim's 852 ft.
  it("(g17 continued) fires when the claim's own ordinal+anchor appears in reason but paired with a DIFFERENT value of the SAME unit", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "The first flight covered 852 ft.",
      reason: "The fourth flight covered 852 ft, while the first flight covered only 120 ft.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "reason_ordinal_mismatch" });
  });

  // Real captured VERIFY output from the labeled-evidence-formatting experiment (2026-08-23) —
  // the exact case the value-aware fix was built for, not a synthetic approximation.
  it("(g17 continued, real captured output) fires on VERIFY's actual reason from the evidence-labeling experiment", () => {
    const result = applyReasonOrdinalGate({
      verdict: "partially_supported",
      claimText: "The first flight covered 852 feet.",
      reason:
        "Source A states the record flight covered 852 feet. Source B states the fourth and final flight covered 852 feet. Source C states the fourth and final flight covered 852 feet. However, Source C explicitly states the first flight covered 120 feet, and Source B states the 852 feet was covered on the fourth flight, not the first. Therefore, the passage partially supports the claim by stating the distance was covered, but not on the first flight.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "reason_ordinal_mismatch" });
  });

  // Unit-spelling variant, not unit MISMATCH — "feet" and "ft" name the same unit and must not be
  // treated as incomparable (the opposite failure direction from the landmine case above).
  it("(g17 continued) same value survives a unit-SPELLING variant (feet vs ft) without a false fire", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "The first flight covered 852 feet.",
      reason: "The passage states the first flight covered 852 ft.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("(g17 continued) a genuine value mismatch still fires across a unit-spelling variant (feet vs ft)", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "The first flight covered 852 feet.",
      reason: "The passage states the first flight covered 120 ft, and the fourth flight covered 852 ft.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "reason_ordinal_mismatch" });
  });

  // Real live-deploy regression (2026-08-23, g20-apple-earnings): the FIRST-in-clause version of
  // clauseValueNear picked up a rounded restatement ("$23.4 billion") earlier in the sentence,
  // instead of the precise value actually adjacent to "third" in the parenthetical that follows it —
  // forcing a real "supported" claim to `contradicted`. Fixed by picking the number nearest the
  // ordinal match, not just the first one in its clause. This is the exact captured failure.
  it("(review-caught regression) does not fire when an earlier ROUNDED restatement in the same clause outranks the precise value actually next to the ordinal", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "Apple reported $23.43 billion in net profit in the third fiscal quarter of 2025.",
      reason: "Multiple sources confirm that Apple reported $23.4 billion (or $23.43 billion) in net profit in the third fiscal quarter of 2025.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  // Real live-deploy regression (2026-08-24, g20-apple-earnings, false accusation) — the mirror image
  // of the case above: a HALLUCINATED near-duplicate value ("$23.42 billion", present in neither the
  // evidence nor the claim) landed nearest the ordinal, still forcing a false contradiction under a
  // nearest-value-must-match rule. Fixed by confirming when the claim's own value appears ANYWHERE in
  // the clause, not only when it happens to be the single nearest one. This is the exact captured failure.
  it("(review-caught regression) does not fire when a HALLUCINATED near-duplicate value outranks the claim's real value by proximity", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "Apple reported $23.43 billion in net profit in the third fiscal quarter of 2025.",
      reason: "Multiple sources state that Apple reported $23.43 billion (or $23.42 billion) in profit for the third fiscal quarter of 2025.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  // /code-review finding (2026-08-24, before deploy) — the any-match confirmation above must not
  // treat a NEGATED occurrence as confirming. "not 852 ft" mentions the claim's value while actually
  // rejecting it; presence alone (the naive version of the fix above) silently swallowed a real mismatch.
  it("(review-caught regression) still fires when the claim's value is only present as a NEGATED figure, not an asserted one", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "The first flight covered 852 ft.",
      reason: "The first flight covered 900 ft not 852 ft.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "reason_ordinal_mismatch" });
  });

  // /code-review finding (2026-08-24, before deploy) — the mirror bug on the CLAIM side: claimValue
  // was still single-nearest, so a claim with its own parenthetical aside could mispick the rounded
  // figure, then a reason correctly stating only the precise one would fail to match.
  it("(review-caught regression) does not fire when the CLAIM's own parenthetical aside, not the reason, is what a nearest-only pick would mispick", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "The third fiscal quarter profit was $23.4 billion (or precisely $23.43 billion) for Apple.",
      reason: "Sources confirm Apple's third fiscal quarter profit was $23.43 billion.",
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

  // Review finding (code-review high, full-branch pass): \b treats "-" as a boundary, so the bare
  // regex matched "second" inside "second-to-last" — a penultimate-position compound, not "2nd" —
  // and forced a genuinely supported claim to contradicted.
  it("(review finding) a hyphen-compound ordinal (e.g. second-to-last) does not false-fire", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "The first flight covered 852 feet.",
      reason: "The second-to-last flight covered 852 feet.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  // Round-2 review finding: the first fix (blanket hyphen-adjacency ban) was too broad and traded
  // the false positive for a new false negative — genuine ordinal-hyphen compounds ("first-place",
  // "second-place") stopped matching at all, so the gate silently abstained on a real contradiction.
  it("(review finding, round 2) still fires on a genuine ordinal-hyphen compound (e.g. first-place vs second-place)", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "The runner finished in first-place at the marathon.",
      reason: "Official results show the runner finished in second-place at the marathon.",
    });
    expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "reason_ordinal_mismatch" });
  });

  // D030 §3k — the live g20 false accusation this rule exists for: the confirming "$23.43 billion"
  // sits in a PRIOR sentence, so clause-scoped lookup only sees the rounded "$23.4 billion".
  it("(g20 live failure 2026-08-24) a rounded restatement across a clause boundary is not a competing value", () => {
    const result = applyReasonOrdinalGate({
      verdict: "supported",
      claimText: "Apple reported $23.43 billion in net profit in the third fiscal quarter of 2025.",
      reason:
        "Source A sentence 7 states net income was $23.43 billion. Source B sentence 5 and Source C sentence 4 state net quarterly profit was $23.4 billion for the third fiscal quarter of 2025. The slight difference in cents is negligible and the claim is supported.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  // D030 §3k value-agreement rule: round both to the LESSER decimal precision (decimal-exact,
  // half-up), compare digit strings. Table-driven so the policy is enumerated, not implied.
  describe("value agreement — decimal-precision boundary table (D030 §3k)", () => {
    const agree: Array<[string, string, string]> = [
      ["23.4", "23.43", "the live g20 case"],
      ["1.20", "1.2", "trailing zero carries no information"],
      ["0.1", "0.10", "trailing zero, other direction"],
      ["852", "852.0", "integer vs explicit .0"],
      ["2.675", "2.68", "exact-half: toFixed says 2.67, decimal says 2.68"],
      ["23.45", "23.5", "exact-half: toFixed says 23.4, decimal says 23.5"],
      ["1.005", "1.01", "exact-half: toFixed says 1.00, decimal says 1.01"],
    ];
    const conflict: Array<[string, string, string]> = [
      ["1.20", "1.21", "genuinely different at shared precision"],
      ["23.4", "24.4", "different integer part"],
      ["120", "852", "the g17 shape — unrelated magnitudes"],
      ["23.45", "23.4", "23.45 resolves to 23.5 at 1dp"],
      ["852", "850", "significant-figure rounding is out of scope by choice"],
    ];

    for (const [claimVal, reasonVal, why] of agree) {
      it(`agrees: ${claimVal} vs ${reasonVal} (${why})`, () => {
        const result = applyReasonOrdinalGate({
          verdict: "supported",
          claimText: `The first flight covered ${claimVal} feet.`,
          reason: `The passage states the first flight covered ${reasonVal} feet.`,
        });
        expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
      });
    }

    for (const [claimVal, reasonVal, why] of conflict) {
      it(`conflicts: ${claimVal} vs ${reasonVal} (${why})`, () => {
        const result = applyReasonOrdinalGate({
          verdict: "supported",
          claimText: `The first flight covered ${claimVal} feet.`,
          reason: `The passage states the first flight covered ${reasonVal} feet.`,
        });
        expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "reason_ordinal_mismatch" });
      });
    }

    // Policy call 1 (D030 §3k): conflict. Precisely — the two resolve to different values at their
    // shared 1dp precision (23.49 -> 23.5). NOT "23.49 isn't a rounding of 23.4": 23.4 is a valid
    // 1dp form of 23.43/23.44. Conservative: the gate must not silently repair a mis-rounded source.
    it("policy call: 23.4 vs 23.49 conflicts — they resolve differently at shared 1dp precision", () => {
      const result = applyReasonOrdinalGate({
        verdict: "supported",
        claimText: "The first flight covered 23.4 feet.",
        reason: "The passage states the first flight covered 23.49 feet.",
      });
      expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "reason_ordinal_mismatch" });
    });

    // Policy call 2 (D030 §3k): agrees, mechanically (shared precision 0). Recorded as NUMERIC
    // REPRESENTATIONAL agreement only — not a claim that 59s and 59.4s are interchangeable
    // measurements. Measurement compatibility would need a domain tolerance; not invented here.
    it("policy call: 59 vs 59.4 agrees — representational only, not measurement interchangeability", () => {
      const result = applyReasonOrdinalGate({
        verdict: "supported",
        claimText: "The first flight lasted 59 seconds.",
        reason: "The passage states the first flight lasted 59.4 seconds.",
      });
      expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
    });
  });

  describe("negation-scope guard (D032 §9/§3k) — claim's own negated ordinal must not be read as a positive assertion; the failure mode this gate was UNFROZEN for (D030 §3k amendment)", () => {
    // Real captured reason (D032 §3k), 3/10 repetitions: "not the first" is TRUE; the reason
    // correctly identifies Aldrin as second, which CONFIRMS the negation. Pre-fix, this gate read
    // "reason names a different ordinal" as a mismatch regardless of the claim's own polarity.
    it("abstains on the real Aldrin case — reason naming 'second' confirms, not contradicts, the negation", () => {
      const result = applyReasonOrdinalGate({
        verdict: "supported",
        claimText: "Buzz Aldrin was not the first man to walk on the Moon.",
        reason:
          "Source A states Buzz Aldrin was the second human to set foot on the Moon, and Source B states Buzz Aldrin followed Armstrong to the surface a short time later, implying Armstrong was first.",
      });
      expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
    });

    it("abstains even when reason positively restates the claim's own (negated) ordinal", () => {
      const result = applyReasonOrdinalGate({
        verdict: "supported",
        claimText: "Buzz Aldrin was not the first man to walk on the Moon.",
        reason: "The passage confirms Buzz Aldrin was not the first — Armstrong was first, Aldrin second.",
      });
      expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
    });

    // Review finding: a backward-only negation check misses this real, natural phrasing entirely.
    // isClaimTokenNegated checks both directions, same fix as the year gate's own postposed test.
    it("abstains on POSTPOSED negation too — 'first flight ... was not 852 feet', not just 'was not the first'", () => {
      const result = applyReasonOrdinalGate({
        verdict: "supported",
        claimText: "The first flight's distance was not 852 feet.",
        reason: "The passage states the first flight covered 900 feet.",
      });
      expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
    });

    it("position-scoped, not presence-only: a negation in an unrelated earlier sentence must not block this gate from firing on the claim's own unnegated ordinal", () => {
      const result = applyReasonOrdinalGate({
        verdict: "supported",
        claimText: "Ground control never lost radio contact. The first flight covered 852 ft.",
        reason: "The passage states the fourth flight covered 852 ft, not the first.",
      });
      expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "reason_ordinal_mismatch" });
    });
  });

  // T17, D032 §10 — real g23 live false accusation, captured verbatim from the run that produced it.
  // "second" inside "12-second" isn't a sequence selector; see D032 §10 for the full mechanism.
  describe("hyphenated numeric compound guard (T17, D032 §10)", () => {
    it("does not force contradicted on the real g23 case — 'second' inside '12-second' is not a competing ordinal", () => {
      const result = applyReasonOrdinalGate({
        verdict: "supported",
        claimText: "The Wright brothers' first successful powered flight lasted 12 seconds.",
        reason:
          "The passage states that the Wright brothers' 12-second flight changed the world and that the flight lasted 12 seconds. Multiple sources confirm the duration of the flight as 12 seconds.",
      });
      expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
    });

    it("still fires on a genuine competing ordinal even when a numeric duration compound is also present", () => {
      const result = applyReasonOrdinalGate({
        verdict: "supported",
        claimText: "The first flight covered 852 ft.",
        reason: "The passage states the 12-second fourth flight covered 852 ft, not the first.",
      });
      expect(result).toEqual({ verdict: "contradicted", overridden: true, reason: "reason_ordinal_mismatch" });
    });
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

describe("subject-entity gate — deterministic backstop for g17 (unrelated real sources coincidentally matching a claim's bare number)", () => {
  it("downgrades supported when evidence shares no proper noun with subjectEntity — the real g17 repro", () => {
    const result = applySubjectEntityGate({
      verdict: "supported",
      claimText: "The second layer contained 34 fragments.",
      subjectEntity: "Marwick",
      evidence: "Prof Foster believes Mr Gray's repair work resulted in as many as 34 numbered fragments of the original stone.",
    });
    expect(result).toEqual({ verdict: "unverifiable", overridden: true, reason: "subject_entity_mismatch" });
  });

  it("leaves supported alone when the evidence names the subject entity, including in possessive form", () => {
    const result = applySubjectEntityGate({
      verdict: "supported",
      claimText: "The second layer contained 34 fragments.",
      subjectEntity: "Marwick",
      evidence: "Marwick's second layer contained 34 fragments of pottery.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("regression: a possessive form in evidence ('Nauru's') must still set-match the claim's bare proper noun ('Nauru')", () => {
    // Real bug found wiring this gate into runGateChain (2026-08-21): properNounWords didn't strip
    // possessives, so "nauru's" != "nauru" as Set members even though they name the same entity —
    // every real-prose claim (evidence almost always refers back possessively) was false-downgraded.
    const result = applySubjectEntityGate({
      verdict: "supported",
      claimText: "Nauru has a resident population of approximately 12,000 people.",
      subjectEntity: "",
      evidence: "Nauru's resident population is approximately 12,000 people.",
    });
    expect(result.overridden).toBe(false);
  });

  it("falls back to claimText when subjectEntity is empty", () => {
    const result = applySubjectEntityGate({
      verdict: "supported",
      claimText: "Marwick led an excavation at Larkspur Hill.",
      subjectEntity: "",
      evidence: "An unrelated passage about the Stone of Destiny and its repair history.",
    });
    expect(result).toEqual({ verdict: "unverifiable", overridden: true, reason: "subject_entity_mismatch" });
  });

  it("falls back to claimText when subjectEntity is undefined (pre-g17 caller/fixture)", () => {
    const result = applySubjectEntityGate({
      verdict: "supported",
      claimText: "Marwick led an excavation at Larkspur Hill.",
      // @ts-expect-error — exercising the runtime guard for callers that predate this field.
      subjectEntity: undefined,
      evidence: "An unrelated passage about the Stone of Destiny and its repair history.",
    });
    expect(result.overridden).toBe(true);
  });

  it("also checks partially_supported, not just supported", () => {
    const result = applySubjectEntityGate({
      verdict: "partially_supported",
      claimText: "Marwick's second layer contained 34 fragments.",
      subjectEntity: "Marwick",
      evidence: "An unrelated page about the Stone of Destiny's 34 numbered fragments.",
    });
    expect(result).toEqual({ verdict: "unverifiable", overridden: true, reason: "subject_entity_mismatch" });
  });

  it("never touches contradicted, unsupported, or unverifiable — only supported/partially_supported are checked", () => {
    for (const verdict of ["contradicted", "unsupported", "unverifiable"] as const) {
      const result = applySubjectEntityGate({
        verdict,
        claimText: "Marwick's second layer contained 34 fragments.",
        subjectEntity: "Marwick",
        evidence: "An unrelated page about the Stone of Destiny's 34 numbered fragments.",
      });
      expect(result).toEqual({ verdict, overridden: false, reason: null });
    }
  });

  it("no-ops when evidence is null", () => {
    const result = applySubjectEntityGate({
      verdict: "supported",
      claimText: "Marwick's second layer contained 34 fragments.",
      subjectEntity: "Marwick",
      evidence: null,
    });
    expect(result).toEqual({ verdict: "supported", overridden: false, reason: null });
  });

  it("abstains (sameEntity's own convention) when the claim names no proper noun at all", () => {
    const result = applySubjectEntityGate({
      verdict: "supported",
      claimText: "The event happened there.",
      subjectEntity: "",
      evidence: "An unrelated page about the Stone of Destiny's 34 numbered fragments.",
    });
    expect(result.overridden).toBe(false);
  });
});

describe("labelSubjectEntityDowngrade — D032 §3f/T6b, distinguishes a subject_entity downgrade from a genuine no-evidence unverifiable", () => {
  const SUBJECT_ENTITY_EVENT = { gate: "subject_entity", overridden: true };
  const OTHER_EVENT = { gate: "reason_year", overridden: true };
  const NOOP_SUBJECT_ENTITY_EVENT = { gate: "subject_entity", overridden: false };

  it("appends a distinguishing note when subject_entity overrode this claim to unverifiable", () => {
    const result = labelSubjectEntityDowngrade("unverifiable", [SUBJECT_ENTITY_EVENT], "The passage discusses a different Wright brother.");
    expect(result).toBe(
      "The passage discusses a different Wright brother. Evidence was found but could not be confirmed as being about this claim's specific subject — this is not a finding that no evidence exists."
    );
  });

  it("leaves reason unchanged when subject_entity did not fire (a genuine no-evidence unverifiable)", () => {
    const result = labelSubjectEntityDowngrade("unverifiable", [OTHER_EVENT, NOOP_SUBJECT_ENTITY_EVENT], "No relevant source found for this claim.");
    expect(result).toBe("No relevant source found for this claim.");
  });

  it("leaves reason unchanged for any verdict other than unverifiable, even if subject_entity is in the event list", () => {
    // subject_entity only ever overrides TO unverifiable, but this guards the precondition directly
    // rather than relying on that invariant holding forever.
    const result = labelSubjectEntityDowngrade("supported", [SUBJECT_ENTITY_EVENT], "The passage confirms the claim.");
    expect(result).toBe("The passage confirms the claim.");
  });

  it("passes through null reason unchanged, even when subject_entity fired", () => {
    const result = labelSubjectEntityDowngrade("unverifiable", [SUBJECT_ENTITY_EVENT], null);
    expect(result).toBeNull();
  });

  it("does not fire on an empty gate-events list", () => {
    const result = labelSubjectEntityDowngrade("unverifiable", [], "No relevant source found for this claim.");
    expect(result).toBe("No relevant source found for this claim.");
  });
});

describe("composeUserFacingReason — D032 §3f/T6b (review finding), precedence between subject_entity labelling and the D031 ungrounded-affirmative rewrite", () => {
  const SUBJECT_ENTITY_EVENT = { gate: "subject_entity", overridden: true };

  // The actual bug: subject_entity ALSO nulls evidence (pipeline-gate-chain.ts), so citations.length
  // is 0 here too — rewriteUngroundedAffirmativeReason's own "citationsCount > 0" early-return does
  // NOT skip this case. Composing both unconditionally produced a self-contradictory reason
  // ("no evidence found" + "evidence was found") on any subject_entity downgrade whose original
  // VERIFY reason was affirmative — which it typically is, since it justified the pre-downgrade
  // supported/partially_supported verdict.
  it("subject_entity takes precedence: does NOT let the D031 rewrite replace an affirmative reason with 'no evidence found'", () => {
    const result = composeUserFacingReason(
      "unverifiable",
      [SUBJECT_ENTITY_EVENT],
      0, // citations.length after subject_entity nulled evidence — the exact condition that hid the bug
      "The passage confirms the second layer contained 34 fragments."
    );
    expect(result).not.toContain("did not provide a specific passage");
    expect(result).toBe(
      "The passage confirms the second layer contained 34 fragments. Evidence was found but could not be confirmed as being about this claim's specific subject — this is not a finding that no evidence exists."
    );
  });

  it("falls through to the D031 rewrite unchanged when subject_entity did not fire (no regression)", () => {
    const result = composeUserFacingReason(
      "unverifiable",
      [{ gate: "reason_year", overridden: true }],
      0,
      "Multiple sources state the first flight lasted 12 seconds."
    );
    expect(result).toBe(
      "The available sources did not provide a specific passage that could be cited to verify this claim. This is not a finding that the claim is false — only that supporting evidence could not be confirmed."
    );
  });

  it("falls through to the D031 rewrite unchanged when there are no gate events at all", () => {
    const result = composeUserFacingReason("unsupported", [], 0, "No relevant source found for this claim.");
    expect(result).toBe("No relevant source found for this claim.");
  });
});

describe("rewriteUngroundedAffirmativeReason — D031, real live-test finding: unverifiable/unsupported verdict shown beside a reason that affirmatively claims sources confirm the claim", () => {
  const REPLACEMENT =
    "The available sources did not provide a specific passage that could be cited to verify this claim. This is not a finding that the claim is false — only that supporting evidence could not be confirmed.";

  it("rewrites when unverifiable + 0 citations + affirmative reason (real captured example)", () => {
    const result = rewriteUngroundedAffirmativeReason("unverifiable", 0, "Multiple sources state the first flight lasted 12 seconds.");
    expect(result).toBe(REPLACEMENT);
  });

  it("rewrites when unsupported + 0 citations + affirmative reason", () => {
    const result = rewriteUngroundedAffirmativeReason("unsupported", 0, "The passage confirms this claim is accurate.");
    expect(result).toBe(REPLACEMENT);
  });

  it("leaves supported untouched even with 0 citations — only unsupported/unverifiable are in scope", () => {
    const reason = "Multiple sources state the first flight lasted 12 seconds.";
    expect(rewriteUngroundedAffirmativeReason("supported", 0, reason)).toBe(reason);
  });

  it("leaves contradicted untouched even with 0 citations", () => {
    const reason = "Sources confirm a different figure than the one claimed.";
    expect(rewriteUngroundedAffirmativeReason("contradicted", 0, reason)).toBe(reason);
  });

  it("leaves unsupported untouched when citations are present — this bug only exists with zero citations", () => {
    const reason = "Multiple sources state the first flight lasted 12 seconds.";
    expect(rewriteUngroundedAffirmativeReason("unsupported", 2, reason)).toBe(reason);
  });

  it("leaves unverifiable untouched when citations are present", () => {
    const reason = "Multiple sources state the first flight lasted 12 seconds.";
    expect(rewriteUngroundedAffirmativeReason("unverifiable", 3, reason)).toBe(reason);
  });

  it("leaves a negated affirmative-shaped reason untouched — 'sources do not confirm' is not a confirmation", () => {
    const reason = "Sources do not confirm this claim.";
    expect(rewriteUngroundedAffirmativeReason("unverifiable", 0, reason)).toBe(reason);
  });

  it("leaves an ordinary 'could not verify' reason untouched — no affirmative source-confirmation language at all", () => {
    const reason = "Could not verify this claim against the retrieved passages.";
    expect(rewriteUngroundedAffirmativeReason("unverifiable", 0, reason)).toBe(reason);
  });

  it("leaves a null reason untouched", () => {
    expect(rewriteUngroundedAffirmativeReason("unverifiable", 0, null)).toBeNull();
  });

  it("real captured example: the second Wright-brothers claim from the same live run", () => {
    const result = rewriteUngroundedAffirmativeReason("unverifiable", 0, "Multiple sources state the first flight covered 120 feet.");
    expect(result).toBe(REPLACEMENT);
  });
});

describe("applyAffirmationEvidenceGate (spec 015 G2)", () => {
  const PASSAGE = "The SCA is an international non-profit volunteer educational organization.";

  it("downgrades supported with null evidence to unsupported", () => {
    const r = applyAffirmationEvidenceGate({ verdict: "supported", evidence: null, passageText: PASSAGE });
    expect(r).toEqual({ verdict: "unsupported", evidence: null, overridden: true, reason: "evidence_null" });
  });

  it("downgrades supported with whitespace-only evidence", () => {
    const r = applyAffirmationEvidenceGate({ verdict: "supported", evidence: "   \n ", passageText: PASSAGE });
    expect(r.verdict).toBe("unsupported");
    expect(r.reason).toBe("evidence_null");
  });

  it("downgrades partially_supported with null evidence", () => {
    const r = applyAffirmationEvidenceGate({ verdict: "partially_supported", evidence: null, passageText: PASSAGE });
    expect(r.verdict).toBe("unsupported");
    expect(r.overridden).toBe(true);
  });

  it("downgrades evidence that is not grounded in the passage", () => {
    const r = applyAffirmationEvidenceGate({ verdict: "supported", evidence: "Something never stated anywhere.", passageText: PASSAGE });
    expect(r).toEqual({ verdict: "unsupported", evidence: null, overridden: true, reason: "evidence_not_grounded" });
  });

  it("leaves supported alone when the evidence is grounded", () => {
    const r = applyAffirmationEvidenceGate({ verdict: "supported", evidence: PASSAGE, passageText: PASSAGE });
    expect(r).toEqual({ verdict: "supported", evidence: PASSAGE, overridden: false, reason: null });
  });

  // Downgrade-only, and never touches the contradiction side — that is gate #1's job.
  it.each(["contradicted", "unsupported", "unverifiable", "excluded"] as const)("does not fire on %s", (verdict) => {
    const r = applyAffirmationEvidenceGate({ verdict, evidence: null, passageText: PASSAGE });
    expect(r).toEqual({ verdict, evidence: null, overridden: false, reason: null });
  });
});
