import { describe, it, expect } from "vitest";
import { PromptRegistry } from "../../../src/prompts/registry.js";

// Review finding — render()'s .replace() used to take VALUE as a string, letting $$/$&/$`/$' in
// external text (claim substrings, whole articles) get interpreted as special replacement patterns
// even though the search side is a plain string, not a regex. Fixed via a replacer function.
describe("PromptRegistry.render() — $-pattern safety", () => {
  const prompts = new PromptRegistry();

  it("does not interpret $& in a variable's value as 'insert the matched placeholder'", () => {
    const rendered = prompts.render("grounnel-eligibility", { claim_text: "he said, $& more", source_excerpt: "n/a" });
    expect(rendered).toContain("he said, $& more");
    expect(rendered).not.toContain("{{claim_text}}");
  });

  it("does not collapse $$ to a single $ in a variable's value", () => {
    const rendered = prompts.render("grounnel-eligibility", { claim_text: "price rose from $$50 to $$100", source_excerpt: "n/a" });
    expect(rendered).toContain("price rose from $$50 to $$100");
  });

  it("does not interpret $' or $` in a variable's value", () => {
    const rendered = prompts.render("grounnel-eligibility", { claim_text: "quote: $'end$` marker", source_excerpt: "n/a" });
    expect(rendered).toContain("quote: $'end$` marker");
  });
});
