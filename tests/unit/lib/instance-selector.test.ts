import { describe, it, expect } from "vitest";
import { extractInstanceSelector, passageMatchesSelector, stripInstanceSelector } from "../../../src/lib/instance-selector.js";

describe("extractInstanceSelector (D030 §3f) — which occurrence of a repeated entity a claim names", () => {
  it("extracts a sequence selector and its anchor (up to 2 content words)", () => {
    const sel = extractInstanceSelector("The first flight covered 852 feet.");
    expect(sel).toEqual({ selector: "first", anchor: new Set(["flight", "covered"]) });
  });

  it("extracts a multi-word anchor (up to 2 content words)", () => {
    const sel = extractInstanceSelector("The third unsuccessful attempt failed badly.");
    expect(sel?.selector).toBe("third");
    expect(sel?.anchor).toEqual(new Set(["unsuccessful", "attempt"]));
  });

  it("abstains on a compound claim naming two selectors", () => {
    expect(extractInstanceSelector("The first flight was shorter than the fourth flight.")).toBeNull();
  });

  it("abstains when there's no real content word on either side of the selector", () => {
    expect(extractInstanceSelector("The first of it.")).toBeNull();
  });

  it("finds a backward anchor when the noun precedes the selector and nothing follows it", () => {
    // D030 §3f review fix: "This came first" now finds "came" behind the selector — no longer a
    // true no-anchor case since backward lookup was added (see the g17 appositive fix below).
    const sel = extractInstanceSelector("This came first.");
    expect(sel?.selector).toBe("first");
    expect(sel?.anchor.size).toBeGreaterThan(0);
  });

  it("abstains on a ranking descriptor (\"longest\") — not a sequence selector", () => {
    expect(extractInstanceSelector("The longest flight covered 852 feet.")).toBeNull();
  });

  it("does not treat 'first' inside a compound like 'first-place' or 'first quarter' specially — anchors on the following content word regardless", () => {
    // Deliberately not excluded: distinguishing "first quarter" (a period name) from "first flight"
    // (a repeated-entity instance) is a retrieval-admission concern (P2's own adversarial matrix),
    // not something the pure extractor itself needs to resolve.
    const sel = extractInstanceSelector("The first quarter of 2024 saw growth.");
    expect(sel?.selector).toBe("first");
    expect(sel?.anchor).toEqual(new Set(["quarter", "saw"]));
  });

  it("does not fire on 'second-to-last' style compounds", () => {
    expect(extractInstanceSelector("She finished second-to-last in the race.")).toBeNull();
  });

  // T17, D032 §10 — g23 live false accusation: "second" inside "12-second" isn't a sequence
  // selector, but \b alone treated the hyphen as a word boundary and matched it anyway.
  it("does not fire on 'second' inside a numeric duration compound like '12-second'", () => {
    expect(extractInstanceSelector("The Wright brothers' 12-second flight changed the world.")).toBeNull();
    // A real ordinal elsewhere in the same claim still resolves to just that one selector — the
    // duration compound never counts as a second, competing selector that would force an abstain.
    const sel = extractInstanceSelector("The 12-second flight was the first successful flight.");
    expect(sel?.selector).toBe("first");
  });

  it("does not fire on a spelled-out numeral compound like 'one-third'", () => {
    expect(extractInstanceSelector("The engine lost one-third of its power.")).toBeNull();
  });

  it("still fires on a genuine ordinal immediately after an unrelated numeric compound", () => {
    const sel = extractInstanceSelector("After a 12-second delay, the first signal arrived.");
    expect(sel?.selector).toBe("first");
  });
});

describe("passageMatchesSelector — confirms a passage names the SAME instance as the claim", () => {
  it("matches when passage shares selector + anchor", () => {
    const sel = extractInstanceSelector("The first flight covered 852 feet.")!;
    expect(passageMatchesSelector(sel, "Orville Wright piloted the first flight, which covered 120 feet.")).toBe(true);
  });

  it("does not match a different selector on the same anchor", () => {
    const sel = extractInstanceSelector("The first flight covered 852 feet.")!;
    expect(passageMatchesSelector(sel, "The fourth flight covered 852 feet.")).toBe(false);
  });

  it("does not match when the anchor is unrelated even if the selector word appears", () => {
    const sel = extractInstanceSelector("The first flight covered 852 feet.")!;
    expect(passageMatchesSelector(sel, "This was the first attempt at the record.")).toBe(false);
  });

  it("returns false, not true, on a passage with no selector at all — this is an additive signal, never a rejection", () => {
    const sel = extractInstanceSelector("The first flight covered 852 feet.")!;
    expect(passageMatchesSelector(sel, "The flight covered 852 feet.")).toBe(false);
  });
});

describe("stripInstanceSelector", () => {
  // The Cardinal Rule guard: no selector means the gate abstains, so FACT must be untouched.
  it.each([
    "The Eiffel Tower is 1083 feet tall.",
    "The first and second flights both failed.",
    "First.",
    "",
  ])("is a byte-identical no-op when no selector is extracted: %s", (claim) => {
    expect(extractInstanceSelector(claim)).toBeNull();
    expect(stripInstanceSelector(claim)).toBe(claim);
  });

  it("removes the selector so FACT no longer names the member", () => {
    expect(stripInstanceSelector("The first flight covered 852 feet.")).toBe("The flight covered 852 feet.");
  });

  // A wrong strip corrupts FACT and can force an unrecoverable `contradicted` (D030 §3d), so every
  // ambiguous shape must no-op instead. Each row below produced a mangled FACT before the guards.
  it.each([
    ["hyphen compound", "Amazon's third-quarter revenue rose 15% year over year."],
    ["hyphen superlative", "Tesla became the second-largest automaker in Europe last year."],
    ["proper noun", "The Second Amendment was ratified in 1791."],
    ["copula predicate", "Apollo 11 was the first crewed lunar landing."],
    ["copula predicate, named subject", "Aldrin was the second man to walk on the moon."],
  ])("refuses to strip when the ordinal is not a standalone selector (%s)", (_why, claim) => {
    expect(stripInstanceSelector(claim)).toBe(claim);
  });

  // The true and false variants must yield the SAME fact — the CLAIM still carries the selector,
  // and it is the gate's job to compare that against the attributed member.
  it("yields the same FACT for the true and false variants of one claim", () => {
    expect(stripInstanceSelector("The fourth flight covered 852 feet."))
      .toBe(stripInstanceSelector("The first flight covered 852 feet."));
  });

  it("falls back to the claim when stripping would leave no words", () => {
    expect(stripInstanceSelector("first first")).toBe("first first");
  });
});
