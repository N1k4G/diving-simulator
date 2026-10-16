import { describe, expect, it } from "vitest";

import { ascentChevrons } from "../../src/app/ascent-chevrons";
import { fastAscentFlashAlpha } from "../../src/render/fast-ascent-flash";

// The fast-ascent cues (#222): legacy's red edge flash (src/renderer.js
// drawScene) and its ascent chevrons (drawDiveComputer), their formulas
// written out here.

describe("the red edge flash of a fast ascent", () => {
  it("shows only while diving and past 9 m/min up", () => {
    expect(fastAscentFlashAlpha(true, 9, 0.2, false)).toBe(0);
    expect(fastAscentFlashAlpha(true, -20, 0.2, false)).toBe(0);
    expect(fastAscentFlashAlpha(false, 20, 0.2, false)).toBe(0);
  });

  it("pulses as (0.2 + 0.15 sin(t ms * 0.01)) * min(1, (rate - 9) / 9)", () => {
    // At 13.5 m/min, half strength; at 1.2 s, sin(12).
    expect(fastAscentFlashAlpha(true, 13.5, 1.2, false)).toBeCloseTo(
      (0.2 + 0.15 * Math.sin(12)) * 0.5,
      12,
    );
    // Full strength from 18 m/min.
    expect(fastAscentFlashAlpha(true, 25, 1.2, false)).toBeCloseTo(0.2 + 0.15 * Math.sin(12), 12);
  });

  it("holds at its middle with reduced motion, and does not pulse", () => {
    expect(fastAscentFlashAlpha(true, 13.5, 1.2, true)).toBeCloseTo(0.1, 12);
    expect(fastAscentFlashAlpha(true, 25, 0.3, true)).toBeCloseTo(0.2, 12);
  });
});

describe("the ascent chevrons", () => {
  it("light one for every 3 m/min either way, at most six", () => {
    expect(ascentChevrons(0, 0, false)).toEqual({
      count: 0,
      tier: "idle",
      direction: "up",
      blinkedOff: false,
    });
    expect(ascentChevrons(7.4, 0, false)).toMatchObject({ count: 2, tier: "moving", direction: "up" });
    expect(ascentChevrons(-10, 0, false)).toMatchObject({
      count: 3,
      tier: "caution",
      direction: "down",
    });
    expect(ascentChevrons(25, 0.3, false)).toMatchObject({ count: 6, tier: "danger" });
  });

  it("point down only past 0.5 m/min down", () => {
    expect(ascentChevrons(-0.5, 0, false).direction).toBe("up");
    expect(ascentChevrons(-0.6, 0, false).direction).toBe("down");
  });

  it("blink past 18 m/min, off in every other 300 ms", () => {
    expect(ascentChevrons(18, 0.1, false).blinkedOff).toBe(false);
    expect(ascentChevrons(19, 0.1, false).blinkedOff).toBe(true);
    expect(ascentChevrons(19, 0.4, false).blinkedOff).toBe(false);
    expect(ascentChevrons(-19, 0.65, false).blinkedOff).toBe(true);
  });

  it("do not blink with reduced motion, and keep the count and the tone", () => {
    expect(ascentChevrons(19, 0.1, true)).toMatchObject({
      count: 6,
      tier: "danger",
      blinkedOff: false,
    });
  });
});
