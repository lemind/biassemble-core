import { describe, it, expect } from "vitest";
import { extractInstanceSelector, passageMatchesSelector } from "../../../src/lib/instance-selector.js";

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

  it("abstains when there's no real content word after the selector", () => {
    expect(extractInstanceSelector("This came first.")).toBeNull();
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
