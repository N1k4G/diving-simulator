import { describe, expect, it } from "vitest";

import { DiveModel, leaveSurfaceState } from "../../src/core/dive-model";
import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  freezeDiveState,
} from "../../src/core/dive-state";
import { bars } from "../../src/core/units";

// legacy src/game-loop.js updateSurface() on S: bcdGasSurfaceLiters = 2.0,
// verticalVelocity = 0, and on a rebreather actualPO2 = targetSP <
// ambientPressure(0) ? targetSP : 0.21 (#223 pre-review).
describe("leaving the surface", () => {
  it("sets 2 L in the BCD and stops any motion", () => {
    const base = createInitialDiveState(1);
    const left = leaveSurfaceState(
      freezeDiveState({ ...base, bcdGasSurfaceLiters: 0, verticalVelocityMpm: 3 }),
    );
    expect(left.bcdGasSurfaceLiters).toBe(2);
    expect(left.verticalVelocityMpm).toBe(0);
    expect(left.ccr).toBeNull();
  });

  it("starts the loop at its setpoint below one bar, and at 0.21 from one bar up", () => {
    const low = createInitialDiveState(2, {
      ccr: createCcrState(createGasMix(0.21, 0), { targetPo2Bar: bars(0.7), actualPo2Bar: bars(0.5) }),
    });
    expect(leaveSurfaceState(low).ccr?.actualPo2Bar).toBe(0.7);
    const high = createInitialDiveState(2, {
      ccr: createCcrState(createGasMix(0.21, 0), { targetPo2Bar: bars(1.0), actualPo2Bar: bars(0.5) }),
    });
    expect(leaveSurfaceState(high).ccr?.actualPo2Bar).toBe(0.21);
  });

  it("leaves a dive that has ended as it is", () => {
    const base = createInitialDiveState(3);
    const ended = freezeDiveState({ ...base, bcdGasSurfaceLiters: 0, completed: true });
    const model = new DiveModel(ended);
    expect(model.leaveSurface().bcdGasSurfaceLiters).toBe(0);
  });
});
