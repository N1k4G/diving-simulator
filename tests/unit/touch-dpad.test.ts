import { describe, expect, it } from "vitest";

import type { ContinuousControl } from "../../src/app/game-controller";
import { DpadHolds } from "../../src/app/touch-dpad";

// The D-pad's bookkeeping (#168): which pointer holds which direction, and
// the intents that reach the controller. The DOM half, pointer capture and
// the release events, is driven with real touch in tests/touch-dpad.spec.js.

type Call = readonly [ContinuousControl, boolean];

function recorder(): { calls: Call[]; holds: DpadHolds } {
  const calls: Call[] = [];
  const holds = new DpadHolds({
    setControl: (control, active) => calls.push([control, active]),
  });
  return { calls, holds };
}

describe("DpadHolds", () => {
  it("holds a direction from press to release, with one intent each way", () => {
    const { calls, holds } = recorder();
    holds.press(1, "ascend");
    expect(holds.holds("ascend")).toBe(true);
    holds.release(1);
    expect(holds.holds("ascend")).toBe(false);
    expect(calls).toEqual([
      ["ascend", true],
      ["ascend", false],
    ]);
  });

  it("does nothing for a second release of the same pointer", () => {
    // pointerup is followed by lostpointercapture for the same pointer.
    const { calls, holds } = recorder();
    holds.press(1, "descend");
    holds.release(1);
    holds.release(1);
    holds.release(7);
    expect(calls).toEqual([
      ["descend", true],
      ["descend", false],
    ]);
  });

  it("keeps a direction held until the last of two pointers lets go", () => {
    const { calls, holds } = recorder();
    holds.press(1, "left");
    holds.press(2, "left");
    holds.release(1);
    expect(holds.holds("left")).toBe(true);
    expect(calls).toEqual([["left", true]]);
    holds.release(2);
    expect(calls).toEqual([
      ["left", true],
      ["left", false],
    ]);
  });

  it("holds two directions from two pointers independently", () => {
    const { calls, holds } = recorder();
    holds.press(1, "ascend");
    holds.press(2, "right");
    holds.release(1);
    expect(holds.holds("right")).toBe(true);
    expect(calls).toEqual([
      ["ascend", true],
      ["right", true],
      ["ascend", false],
    ]);
  });

  it("moves a pointer that presses again to its new direction", () => {
    const { calls, holds } = recorder();
    holds.press(1, "left");
    holds.press(1, "left");
    holds.press(1, "right");
    expect(holds.holds("left")).toBe(false);
    expect(calls).toEqual([
      ["left", true],
      ["left", false],
      ["right", true],
    ]);
  });

  it("lets go of everything at once, for a lost focus or a hidden page", () => {
    const { calls, holds } = recorder();
    holds.press(1, "ascend");
    holds.press(2, "ascend");
    holds.press(3, "left");
    calls.length = 0;
    holds.releaseAll();
    for (const control of ["ascend", "descend", "left", "right"] as const) {
      expect(holds.holds(control)).toBe(false);
    }
    expect(calls).toEqual([
      ["ascend", false],
      ["left", false],
    ]);
    // A pointerup that arrives afterwards finds nothing to release.
    holds.release(1);
    expect(calls).toHaveLength(2);
  });
});
