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

// Among a site's structures (#240): legacy's frame on a site with structures,
// resolveDiverOverlap() and then, in each sub-step, the depth and then the
// fins (src/game-loop.js 427-434). tests/parity/site-collision.test.ts runs
// whole frames through the wreck against legacy's.
describe("integrating among a site's structures (#240)", () => {
  /** A wall from x 1 to 2, 10 to 20 m down, over a seabed at 30 m. */
  const walled = {
    hasOverhead: false,
    floor: [{ x: -10, d: 30 }],
    ceiling: null,
    structures: [{ x1: 1, x2: 2, dTop: 10, dBottom: 20 }],
  };
  const sinking = (depthM: number, xMps = 0) => ({
    state: freezeDiveState({ ...at(createInitialDiveState(5), depthM), verticalVelocityMpm: 20, bcdGasSurfaceLiters: 0 }),
    place: (xM: number, displacementM = xMps) => ({ site: walled, xM, displacementM }),
  });

  it("steps the depth before the fins, so the fins meet the wall the diver has sunk level with", () => {
    // At 9.68 m the diver's body ends 0.02 m above the wall's top; the sub-step
    // sinks it 1/30 m at 20 m/min, level with the wall, and then the fins'
    // 0.2 m to the right would bury it in the wall.
    const { state, place } = sinking(9.68);
    const moved = integrateBuoyancy(state, place(0.5, 0.2), 0.1);
    expect(moved.depthM).toBeCloseTo(9.68 + 20 / 600, 12);
    expect(moved.xM).toBe(0.5);
    // Higher up, the same stroke clears the wall's top.
    expect(integrateBuoyancy(sinking(9.5).state, place(0.5, 0.2), 0.1).xM).toBeCloseTo(0.7, 12);
  });

  it("spreads the fins' stroke over the frame's sub-steps, and stops it at the wall", () => {
    const { state, place } = sinking(15);
    // Three sub-steps of 0.1 s, a third of the 0.3 m each; the wall's face at
    // x 1 stops the body's right edge, 0.45 m right of the diver.
    expect(integrateBuoyancy(state, place(0, 0.3), 0.3).xM).toBeCloseTo(0.3, 12);
    const stopped = integrateBuoyancy(state, place(0.3, 0.6), 0.3).xM ?? Number.NaN;
    expect(stopped).toBeCloseTo(0.5, 12);
    expect(stopped + 0.45).toBeLessThanOrEqual(1);
  });

  it("frees a diver caught in a structure once, before the physics", () => {
    // Inside the wall at x 1.2: the nearest way out is past its left face.
    const caught = freezeDiveState({ ...at(createInitialDiveState(5), 15), bcdGasSurfaceLiters: neutralBcdSurfaceLitres(15) });
    const freed = integrateBuoyancy(caught, { site: walled, xM: 1.2, displacementM: 0 }, 0.1);
    expect(freed.xM).toBeCloseTo(1 - 0.45 - 1e-6, 12);
    expect(freed.depthM).toBeCloseTo(15, 9);
  });

  it("moves as between the site's ceiling and floor where nothing is in the way, and has no x without a place", () => {
    const { state } = sinking(5);
    const open = integrateBuoyancy(state, { ceilingM: 0, floorM: 30 }, 0.3);
    const placed = integrateBuoyancy(state, { site: walled, xM: -5, displacementM: 0 }, 0.3);
    expect(placed).toEqual({ ...open, xM: -5 });
    expect(open).not.toHaveProperty("xM");
  });
});
