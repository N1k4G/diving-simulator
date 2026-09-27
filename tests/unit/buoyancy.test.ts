import { describe, expect, it } from "vitest";

import {
  BUOYANCY_PARAMS,
  applyBcdControls,
  integrateBuoyancy,
  neutralBcdSurfaceLitres,
} from "../../src/core/buoyancy";
import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
  type DiveState,
} from "../../src/core/dive-state";
import { metres, seconds } from "../../src/core/units";

// Buoyancy physics (#192). tests/parity/buoyancy.test.ts replays a recorded
// legacy dive; these pin what that recording does not reach.

const at = (state: DiveState, depthM: number): DiveState =>
  freezeDiveState({ ...state, depthM: metres(depthM), maxDepthM: metres(Math.max(depthM, state.maxDepthM)) });

describe("the neutral BCD", () => {
  it("matches legacy's neutralizeAt() at 12 m, as the recording set it", () => {
    // buoyancy-vent-inflate-12m/neutral-12m records 6.865735...
    expect(neutralBcdSurfaceLitres(12)).toBeCloseTo(6.8657, 4);
  });

  it("holds a diver at rest where it is neutral", () => {
    const state = freezeDiveState({
      ...at(createInitialDiveState(1), 18),
      bcdGasSurfaceLiters: neutralBcdSurfaceLitres(18),
    });
    const moved = integrateBuoyancy(state, { ceilingM: 0, floorM: 300 }, 10);
    expect(moved.depthM).toBeCloseTo(18, 12);
    expect(moved.verticalVelocityMpm).toBe(0);
  });
});

describe("inflating and venting", () => {
  it("draws inflation gas from the active tank on open circuit, as legacy", () => {
    const state = at(createInitialDiveState(2, { tanks: [createTankState(createGasMix(0.21, 0))] }), 20);
    const next = applyBcdControls(state, { inflate: true, vent: false }, seconds(1));
    // 0.4 L/s at 3 bar is 1.2 surface-equivalent litres.
    expect(next.bcdGasSurfaceLiters - state.bcdGasSurfaceLiters).toBeCloseTo(1.2, 12);
    expect((state.tanks[0]?.gasRemainingL ?? 0) - (next.tanks[0]?.gasRemainingL ?? 0)).toBeCloseTo(1.2, 12);
  });

  it("draws from the diluent on a rebreather, not the placeholder tank (owner decision on #192)", () => {
    const base = createInitialDiveState(3, { ccr: createCcrState(createGasMix(0.21, 0)) });
    const state = at(base, 20);
    const next = applyBcdControls(state, { inflate: true, vent: false }, seconds(1));
    expect(next.tanks[0]?.gasRemainingL).toBe(state.tanks[0]?.gasRemainingL);
    // 1.2 L from a 3 L diluent cylinder is 0.4 bar.
    expect((state.ccr?.diluentCylinderPressureBar ?? 0) - (next.ccr?.diluentCylinderPressureBar ?? 0)).toBeCloseTo(0.4, 12);
    expect(next.bcdGasSurfaceLiters - state.bcdGasSurfaceLiters).toBeCloseTo(1.2, 12);
  });

  it("cannot inflate from an empty cylinder", () => {
    const empty = createTankState(createGasMix(0.21, 0), 12, 0);
    const state = at(createInitialDiveState(4, { tanks: [empty] }), 10);
    expect(applyBcdControls(state, { inflate: true, vent: false }, seconds(1)).bcdGasSurfaceLiters)
      .toBe(state.bcdGasSurfaceLiters);
  });

  it("stops at the BCD's capacity", () => {
    const state = freezeDiveState({
      ...at(createInitialDiveState(5), 10),
      bcdGasSurfaceLiters: BUOYANCY_PARAMS.bcdMaxCapacity * 2 - 0.1,
    });
    const next = applyBcdControls(state, { inflate: true, vent: false }, seconds(1));
    expect(next.bcdGasSurfaceLiters).toBeCloseTo(BUOYANCY_PARAMS.bcdMaxCapacity * 2, 12);
  });

  it("vents no more than the BCD holds", () => {
    const state = freezeDiveState({ ...at(createInitialDiveState(6), 10), bcdGasSurfaceLiters: 0.5 });
    expect(applyBcdControls(state, { inflate: false, vent: true }, seconds(1)).bcdGasSurfaceLiters).toBe(0);
  });
});

describe("the bounds", () => {
  it("stops at the ceiling and the floor it is given", () => {
    const sinking = freezeDiveState({ ...at(createInitialDiveState(7), 33), bcdGasSurfaceLiters: 0, verticalVelocityMpm: 20 });
    const floored = integrateBuoyancy(sinking, { ceilingM: 18, floorM: 34 }, 10);
    expect(floored.depthM).toBe(34);
    expect(floored.verticalVelocityMpm).toBe(0);

    const rising = freezeDiveState({ ...at(createInitialDiveState(8), 19), bcdGasSurfaceLiters: 30, verticalVelocityMpm: -25 });
    const ceilinged = integrateBuoyancy(rising, { ceilingM: 18, floorM: 34 }, 10);
    expect(ceilinged.depthM).toBe(18);
    expect(ceilinged.verticalVelocityMpm).toBe(0);
  });
});
