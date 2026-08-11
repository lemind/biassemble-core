import { describe, it, expect } from "vitest";
import {
  applyClaimReasonOverlapGate,
  applyContradictionEvidenceGate,
  applyCounterfactIgnoredGate,
  applyImplicitNegationGate,
  applyNumericGate,
  applyReasonConsistencyGate,
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

  it("overrides to supported when an 'under X' threshold claim's evidence is below X", () => {
    const result = applyNumericGate({
      claimText: "Unemployment stayed under 5% in 2024.",
      verdict: "contradicted",
      evidence: "Unemployment was 3.9% in 2024.",
    });
    expect(result).toEqual({ verdict: "supported", overridden: true, reason: "threshold_comparison" });
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
