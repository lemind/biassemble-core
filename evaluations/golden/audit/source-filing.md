# Source filing for audit-mode golden sets

**Filing**: Apple Inc., Form 10-Q, quarterly period ended March 28, 2026 (fiscal Q2 2026). Filed 2026-05-01.
**URL**: https://www.sec.gov/Archives/edgar/data/320193/000032019326000013/aapl-20260328.htm
**Fetched**: 2026-07-20, via `curl` with SEC-required User-Agent header (public filing, no ToS issue).

This is a **real, unmodified SEC filing**. All figures below are verbatim excerpts (whitespace normalized, `&#160;`/`&amp;` entities resolved to plain characters, otherwise character-for-character). Every claim in `extract-golden-set.json`, `verify-golden-set.json`, and `numbers-golden-set.json` traces back to one of the passages here by `location` tag — this file is the single source of truth for what those golden sets test against. Do not edit these excerpts to make a golden-set case "work"; if a case doesn't hold up against the real text, fix the case.

Two of the ten EXTRACT texts also lean on facts *absent* from this filing (silence traps) and facts that *contradict* it (contradiction traps, clearly marked as fabricated-for-testing below) — those are noted inline, never presented as real filing content.

---

### `cover-page`
> For the quarterly period ended March 28, 2026

### `products-table`
> The following table shows net sales by category for the three- and six-month periods ended March 28, 2026 and March 29, 2025 (dollars in millions): Three Months Ended Six Months Ended March 28, 2026 March 29, 2025 Change March 28, 2026 March 29, 2025 Change iPhone $56,994 $46,841 22% $142,263 $115,979 23% Mac 8,399 7,949 6% 16,785 16,936 (1)% iPad 6,914 6,402 8% 15,509 14,490 7% Wearables, Home and Accessories 7,901 7,522 5% 19,394 19,269 1% Services 30,976 26,645 16% 60,989 52,985 15% Total net sales $111,184 $95,359 17% $254,940 $219,659 16%

### `segment-table`
> The following table shows net sales by reportable segment for the three- and six-month periods ended March 28, 2026 and March 29, 2025 (dollars in millions): Three Months Ended Six Months Ended March 28, 2026 March 29, 2025 Change March 28, 2026 March 29, 2025 Change Americas $45,093 $40,315 12% $103,622 $92,963 11% Europe 28,055 24,454 15% 66,201 58,315 14% Greater China 20,497 16,002 28% 46,023 34,515 33% Japan 8,401 7,298 15% 17,814 16,285 9% Rest of Asia Pacific 9,138 7,290 25% 21,280 17,581 21% Total net sales $111,184 $95,359 17% $254,940 $219,659 16%

### `iphone-narrative`
> iPhone net sales increased during the second quarter and first six months of 2026 compared to the same periods in 2025 due to higher net sales of Pro models.

### `mac-narrative`
> Mac net sales increased during the second quarter of 2026 compared to the second quarter of 2025 due to higher net sales of laptops. Year-over-year Mac net sales during the first six months of 2026 were relatively flat.

### `ipad-narrative`
> iPad net sales increased during the second quarter and first six months of 2026 compared to the same periods in 2025 primarily due to higher net sales of iPad, partially offset by lower net sales of iPad mini.

### `wearables-narrative`
> Wearables, Home and Accessories net sales increased during the second quarter of 2026 compared to the second quarter of 2025 primarily due to higher net sales of Accessories and Wearables. Year-over-year Wearables, Home and Accessories net sales during the first six months of 2026 were relatively flat.

### `japan-narrative`
> Japan net sales increased during the second quarter and first six months of 2026 compared to the same periods in 2025 primarily due to higher net sales of iPhone. The weakness in the yen relative to the U.S. dollar had an unfavorable year-over-year impact on Japan net sales during the first six months of 2026.

### `rest-of-asia-narrative`
> Rest of Asia Pacific net sales increased during the second quarter and first six months of 2026 compared to the same periods in 2025 primarily due to higher net sales of iPhone and Services. The strength in foreign currencies relative to the U.S. dollar had a net favorable year-over-year impact on Rest of Asia Pacific net sales during the second quarter of 2026.

### `income-statement`
> Gross margin 54,781 44,867 124,012 103,142. Research and development 11,419 8,550 22,306 16,818. Selling, general and administrative 7,477 6,728 14,969 13,903. Total operating expenses 18,896 15,278 37,275 30,721. Operating income 35,885 29,589 86,737 72,421. Other income/(expense), net (52) (279) 98 (527). Income before provision for income taxes 35,833 29,310 86,835 71,894. Provision for income taxes 6,255 4,530 15,160 10,784. Net income $29,578 $24,780 $71,675 $61,110.
>
> (Column order throughout this section: Three Months Ended March 28 2026, Three Months Ended March 29 2025, Six Months Ended March 28 2026, Six Months Ended March 29 2025 — dollars in millions.)

### `eps-table`
> Earnings per share: Basic $2.02 $1.65 $4.87 $4.06. Diluted $2.01 $1.65 $4.85 $4.05.
> (Same column order as `income-statement`.)

---

## NOT in this filing (for silence-trap cases — do not treat as real)

- Apple's 10-Q does not state a specific unit-sales or "activation" count for iPhone (only dollar net sales). Any claim citing an iPhone *unit* count is a silence trap against this filing.
- The filing does not break out Services net sales by sub-category (App Store vs. AppleCare vs. advertising, etc.) — any such breakdown is a silence trap.

## Fabricated-for-testing numbers (for contradiction-trap cases — clearly NOT real filing content)

- **Fabricated**: "Greater China net sales fell 8% year-over-year." (Real: Greater China rose 28% — see `segment-table`.) Used only in `verify-golden-set.json` / `extract-golden-set.json` contradiction cases, never presented elsewhere as fact.
