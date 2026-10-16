import { describe, expect, it } from "vitest";

import { HINT_CLEARANCE_PX, hintClearOf, type Box } from "../../src/app/controls-hint";

// The keyboard hint yields to the HUD and an open page (#168 pre-review
// pass 3). The measuring against the real layout is driven in
// tests/in-dive-controls.spec.js; this is the rule it measures by.

const box = (top: number, left: number, height: number, width: number): Box => ({
  top,
  left,
  bottom: top + height,
  right: left + width,
});

const hint = box(400, 20, 48, 416);

describe("hintClearOf", () => {
  it("is the #121 spacing", () => {
    expect(HINT_CLEARANCE_PX).toBe(8);
  });

  it("is clear of nothing", () => {
    expect(hintClearOf(hint, [])).toBe(true);
  });

  it("is clear of a panel that ends 8px or more above it, and not of one that ends nearer", () => {
    expect(hintClearOf(hint, [box(100, 20, 292, 320)])).toBe(true);
    expect(hintClearOf(hint, [box(100, 20, 293, 320)])).toBe(false);
    // Overlapping.
    expect(hintClearOf(hint, [box(100, 20, 320, 320)])).toBe(false);
  });

  it("is clear of a box far enough to its side, however tall", () => {
    expect(hintClearOf(hint, [box(0, 444, 800, 100)])).toBe(true);
    expect(hintClearOf(hint, [box(0, 443, 800, 100)])).toBe(false);
  });

  it("ignores a hidden panel, which has no box", () => {
    expect(hintClearOf(hint, [box(0, 0, 0, 0)])).toBe(true);
  });

  it("must be clear of every obstacle", () => {
    const hud = box(90, 20, 200, 320);
    const page = box(300, 20, 96, 320);
    expect(hintClearOf(hint, [hud])).toBe(true);
    expect(hintClearOf(hint, [hud, page])).toBe(false);
  });
});
