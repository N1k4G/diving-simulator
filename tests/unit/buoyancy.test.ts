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
import { bars, metres, seconds } from "../../src/core/units";
import { DiveModel } from "../../src/core/dive-model";

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

  it("empties a nearly empty diluent without going below zero (pre-review of #193)", () => {
    // 0.013... bar in 3 L is less than one second's draw at 20 m, and
    // p - (p * v) / v lands one ulp below zero for this value.
    const base = createInitialDiveState(9, { ccr: createCcrState(createGasMix(0.21, 0)) });
    const state = freezeDiveState({
      ...at(base, 20),
      ccr: { ...base.ccr!, diluentCylinderPressureBar: bars(0.013039117352056168) },
    });
    const next = applyBcdControls(state, { inflate: true, vent: false }, seconds(1));
    expect(next.ccr?.diluentCylinderPressureBar).toBe(0);
    expect(next.bcdGasSurfaceLiters - state.bcdGasSurfaceLiters).toBeCloseTo(0.013039117352056168 * 3, 12);
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

describe("the frame cadence", () => {
  // Legacy applies the controls once per frame, before that frame's physics,
  // then sub-steps the physics and updates everything else once (#193
  // review). One advanceWithBuoyancy() call is one such frame.
  const neutralAt12 = () =>
    freezeDiveState({ ...at(createInitialDiveState(10), 12), bcdGasSurfaceLiters: neutralBcdSurfaceLitres(12) });
  const OPEN = { ceilingM: 0, floorM: 300 };
  const VENT = { inflate: false, vent: true };

  it("applies the controls once for the frame, then moves the diver", () => {
    // 0.3 s: the slowest frame legacy runs with a control held.
    const frame = new DiveModel(neutralAt12()).advanceWithBuoyancy(OPEN, seconds(0.3), VENT);
    const expected = integrateBuoyancy(applyBcdControls(neutralAt12(), VENT, seconds(0.3)), OPEN, 0.3);
    expect(frame.depthM).toBe(expected.depthM);
    expect(frame.verticalVelocityMpm).toBe(expected.verticalVelocityMpm);
    expect(frame.bcdGasSurfaceLiters).toBe(expected.bcdGasSurfaceLiters);
    expect(frame.elapsedTimeS).toBeCloseTo(0.3, 12);
  });

  it("keeps the caller's frame boundaries", () => {
    const one = new DiveModel(neutralAt12()).advanceWithBuoyancy(OPEN, seconds(0.3), VENT);
    const three = new DiveModel(neutralAt12());
    for (let i = 0; i < 3; i += 1) three.advanceWithBuoyancy(OPEN, seconds(0.1), VENT);
    // One frame vents 0.3 s before the diver moves; three vent 0.1 s each.
    expect(one.depthM - three.snapshot.depthM).toBeGreaterThan(5e-4);
    expect(one.verticalVelocityMpm - three.snapshot.verticalVelocityMpm).toBeGreaterThan(0.1);
  });

  it("integrates a longer span in legacy's 0.1 s physics sub-steps", () => {
    // src/game-loop.js PHYSICS_MAX_SUBSTEP_SEC: a span handed to the physics
    // at once moves as its 0.1 s sub-steps would, not as one step.
    const sinking = freezeDiveState({ ...neutralAt12(), bcdGasSurfaceLiters: 2 });
    const once = integrateBuoyancy(sinking, OPEN, 1);
    let stepped = sinking;
    for (let i = 0; i < 10; i += 1) {
      const moved = integrateBuoyancy(stepped, OPEN, 0.1);
      stepped = freezeDiveState({ ...stepped, depthM: metres(moved.depthM), verticalVelocityMpm: moved.verticalVelocityMpm });
    }
    expect(once.depthM).toBeCloseTo(stepped.depthM, 12);
    expect(once.verticalVelocityMpm).toBeCloseTo(stepped.verticalVelocityMpm, 12);
  });
});
