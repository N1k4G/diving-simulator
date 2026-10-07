import { describe, expect, it } from "vitest";

import { isTurnBeepDue } from "../../src/app/thirds-turn-beep";
import { neutralBcdSurfaceLitres } from "../../src/core/buoyancy";

// legacy src/game-loop.js, Issue #27: `if (!thirdsTurnWarned) {
// thirdsTurnWarned = true; playAlertBeep(); }` — one beep, as it latches.
describe("the rule of thirds' turn beep", () => {
  it("is due on the frame the turn latches", () => {
    expect(isTurnBeepDue(false, true)).toBe(true);
  });

  it("is not due again while it stays latched, nor when it clears", () => {
    expect(isTurnBeepDue(true, true)).toBe(false);
    expect(isTurnBeepDue(true, false)).toBe(false);
    expect(isTurnBeepDue(false, false)).toBe(false);
  });

  it("is not due for a dive resumed past its turn", () => {
    expect(isTurnBeepDue(null, true)).toBe(false);
  });
});

describe("the e2e fixtures of tests/hud-readouts.spec.js", () => {
  it("park the diver neutral at 28 m, where it can swim into the hold", () => {
    expect(neutralBcdSurfaceLitres(28)).toBe(15.337143629243002);
  });
});
