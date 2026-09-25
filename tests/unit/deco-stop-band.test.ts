import { describe, expect, it } from "vitest";

import {
  DECO_STOP_BAND_M,
  decoStopDepth,
  isAtDecoStop,
} from "../../src/planner/dive-planner";

// The fast-forward eligibility rule (#163), ported from src/game-loop.js
// updateDiving():
//
//   var decoStopD = decoStop(frameCalc.ceiling);
//   var atDecoStop = decoStopD > 0 && Math.abs(depth - decoStopD) <= 1.5;
//
// The controller adds the "no vertical key held" half, which needs a running
// controller and is covered end to end in tests/in-dive-controls.spec.js.
describe("isAtDecoStop", () => {
  it("uses legacy's 1.5 m band", () => {
    expect(DECO_STOP_BAND_M).toBe(1.5);
  });

  it("is false without a ceiling, whatever the depth", () => {
    // No obligation means no stop to wait out. decoStop() returns 0 for a
    // ceiling at or above the surface, and 0 > 0 is false.
    expect(decoStopDepth(0)).toBe(0);
    expect(isAtDecoStop(0, 0)).toBe(false);
    expect(isAtDecoStop(3, 0)).toBe(false);
    expect(isAtDecoStop(18, -1)).toBe(false);
  });

  it("is true within 1.5 m of the rounded stop, inclusive", () => {
    // A 17.5 m ceiling rounds up to an 18 m stop.
    expect(decoStopDepth(17.5)).toBe(18);
    expect(isAtDecoStop(18, 17.5)).toBe(true);
    expect(isAtDecoStop(16.5, 17.5)).toBe(true);
    expect(isAtDecoStop(19.5, 17.5)).toBe(true);
  });

  it("is false once the diver drifts past the band", () => {
    expect(isAtDecoStop(16.4, 17.5)).toBe(false);
    expect(isAtDecoStop(19.6, 17.5)).toBe(false);
    // Below the stop by a whole stop interval: the next-deeper multiple of
    // three is not "the" stop, so being there is not holding it.
    expect(isAtDecoStop(21, 17.5)).toBe(false);
  });

  it("follows the stop as the ceiling clears", () => {
    // The ceiling has come up to 14.9 m, so the stop is now 15 m and a diver
    // still at 18 m is no longer holding it — legacy drops out of
    // fast-forward on that tick, and the controller mirrors it.
    expect(decoStopDepth(14.9)).toBe(15);
    expect(isAtDecoStop(18, 14.9)).toBe(false);
    expect(isAtDecoStop(15, 14.9)).toBe(true);
  });
});
