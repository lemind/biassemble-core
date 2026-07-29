import { describe, it, expect } from "vitest";
import { findReferenceDrift } from "../../../../src/orchestrators/audit/extract.service.js";

describe("findReferenceDrift", () => {
  it("flags the real production incident: excerpt cites a sub-article, claim drops the suffix", () => {
    const claim = "Article 19 provides a special indemnity for labor and wage-related liabilities.";
    const excerpt = "Article 19-2 provides a special indemnity for labor and wage-related liabilities.";
    expect(findReferenceDrift(claim, excerpt)).toMatch(/Article 19-2.*Article 19/);
  });

  it("does not flag when the claim retains the same sub-reference as the excerpt", () => {
    const claim = "Article 19-2 provides a special indemnity for labor and wage-related liabilities.";
    const excerpt = "Article 19-2 provides a special indemnity for labor and wage-related liabilities.";
    expect(findReferenceDrift(claim, excerpt)).toBeNull();
  });

  it("does not flag when the claim omits the reference entirely (fair paraphrase)", () => {
    const claim = "There is a special indemnity for labor and wage-related liabilities.";
    const excerpt = "Article 19-2 provides a special indemnity for labor and wage-related liabilities.";
    expect(findReferenceDrift(claim, excerpt)).toBeNull();
  });

  it("does not flag an unrelated reference elsewhere in the claim", () => {
    const claim = "Article 15 governs employee retention; Article 19-2 provides a special indemnity.";
    const excerpt = "Article 19-2 provides a special indemnity for labor and wage-related liabilities.";
    expect(findReferenceDrift(claim, excerpt)).toBeNull();
  });

  it("flags drift across Section/Paragraph/Item reference types, not just Article", () => {
    const claim = "Paragraph 3 sets the retirement allowance.";
    const excerpt = "Paragraph 3.1 sets the retirement allowance.";
    expect(findReferenceDrift(claim, excerpt)).toMatch(/Paragraph 3\.1.*Paragraph 3/);
  });
  // "does not flag a claim with no reference tokens at all" removed on review (2026-07-29):
  // duplicate of "does not flag when the claim omits the reference entirely" above — both hit
  // the identical baseRe.test(claim)===false branch in findReferenceDrift's per-reference loop,
  // which has no state shared across reference tokens, so a second reference type in the
  // excerpt didn't exercise anything new.
});
