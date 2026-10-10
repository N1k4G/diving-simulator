import { describe, expect, it } from "vitest";

import { neutralBcdSurfaceLitres } from "../../src/core/buoyancy";
import { DiveModel, type SharkFrame } from "../../src/core/dive-model";
import { createInitialDiveState, freezeDiveState, type DiveState } from "../../src/core/dive-state";
import {
  narcosisDriftStep,
  perSecondToPerFrameProbability,
  swallowInputs,
  type MovementControls,
} from "../../src/core/narcosis-effects";
import { nextRandom } from "../../src/core/rng";
import { metres, seconds } from "../../src/core/units";
import { decodeSaveGame, encodeSaveGame, createSaveGame } from "../../src/save/save-game";

// Narcosis below the KO (#220): legacy's swallowed inputs and drift
// (src/game-loop.js WP-020) on the dive's seeded random state. Legacy's
// formulas are written out here as numbers.

const ALL: MovementControls = { inflate: true, vent: true, left: true, right: true };
const NONE: MovementControls = { inflate: false, vent: false, left: false, right: false };
const BOUNDS = { ceilingM: 0, floorM: 300 };

/** A draw that answers `values` in order and records how many it gave. */
function script(...values: number[]) {
  const given: number[] = [];
  const draw = () => {
    const value = values[given.length];
    if (value === undefined) throw new Error("drew more than scripted");
    given.push(value);
    return value;
  };
  return { draw, given };
}

function deep(narcosisIndex: number, seed = 71, depthM = 30): DiveState {
  return freezeDiveState({
    ...createInitialDiveState(seed),
    elapsedTimeS: seconds(300),
    depthM: metres(depthM),
    maxDepthM: metres(depthM),
    bcdGasSurfaceLiters: neutralBcdSurfaceLitres(depthM),
    narcosisIndex,
  });
}

/** The random state after `count` draws from `state`. */
function after(state: number, count: number): number {
  for (let i = 0; i < count; i += 1) state = nextRandom(state).state;
  return state;
}

describe("legacy's per-frame probability", () => {
  it("is the 60 Hz chance at a 60 Hz frame, and the same per second at any other", () => {
    expect(perSecondToPerFrameProbability(0.3, 1 / 60)).toBeCloseTo(0.3, 12);
    const at144 = perSecondToPerFrameProbability(0.3, 1 / 144);
    expect(1 - Math.pow(1 - at144, 144)).toBeCloseTo(1 - Math.pow(0.7, 60), 12);
    expect(perSecondToPerFrameProbability(0, 0.1)).toBe(0);
    expect(perSecondToPerFrameProbability(0.3, 0)).toBe(0);
    expect(perSecondToPerFrameProbability(1, 0.01)).toBe(1);
  });
});

describe("swallowed inputs", () => {
  it("keeps every held key at index 0.3 or below and draws nothing", () => {
    for (const index of [0, 0.15, 0.3]) {
      const { draw, given } = script();
      expect(swallowInputs(ALL, index, 1 / 60, draw)).toEqual(ALL);
      expect(given).toEqual([]);
    }
  });

  it("draws for each held key in legacy's order, W, S, A, D, and keeps it when the draw beats the chance", () => {
    // Index 1: narcDelay 1, a chance of 0.6 per 60 Hz frame.
    const { draw, given } = script(0.61, 0.59, 0.9, 0.1);
    expect(swallowInputs(ALL, 1, 1 / 60, draw)).toEqual({ inflate: true, vent: false, left: true, right: false });
    expect(given).toHaveLength(4);
    // A key not held draws nothing: S and A here.
    const held = script(0.1, 0.9);
    expect(swallowInputs({ ...NONE, inflate: true, right: true }, 1, 1 / 60, held.draw)).toEqual({ ...NONE, right: true });
    expect(held.given).toHaveLength(2);
    // Index 0.65: (0.65 - 0.3) / 0.7 * 0.6 = 0.3.
    expect(swallowInputs({ ...NONE, vent: true }, 0.65, 1 / 60, script(0.3).draw).vent).toBe(false);
    expect(swallowInputs({ ...NONE, vent: true }, 0.65, 1 / 60, script(0.31).draw).vent).toBe(true);
  });

  it("scales the chance to the frame's real length, as legacy's issue #69 does", () => {
    // Index 1 over a 0.1 s frame: 1 - 0.4^6, about 0.996, not 0.6.
    expect(swallowInputs({ ...NONE, inflate: true }, 1, 0.1, script(0.9).draw).inflate).toBe(false);
    expect(swallowInputs({ ...NONE, inflate: true }, 1, 0.1, script(0.997).draw).inflate).toBe(true);
  });
});

describe("the drift", () => {
  it("is 0 at index 0.45 or below, draws nothing, and leaves the velocity", () => {
    const { draw, given } = script();
    expect(narcosisDriftStep(0.02, 3, 0.45, 30, 1 / 60, draw)).toEqual({ drift: 0, verticalVelocityMpm: 3 });
    expect(given).toEqual([]);
  });

  it("stands at the surface, where legacy neither draws nor adds it", () => {
    const { draw, given } = script();
    expect(narcosisDriftStep(0.02, 0, 0.8, 0, 1 / 60, draw)).toEqual({ drift: 0.02, verticalVelocityMpm: 0 });
    expect(given).toEqual([]);
  });

  it("walks by (rand - 0.5) * 0.3 * strength * dtReal, decays by 0.98, and adds 60 times it to the velocity", () => {
    // Index 1: strength 1. 0.9: (0.9 - 0.45) / 0.55.
    const full = narcosisDriftStep(0.01, -2, 1, 30, 0.02, script(0.75).draw);
    expect(full.drift).toBeCloseTo((0.01 + 0.25 * 0.3 * 0.02) * 0.98, 15);
    expect(full.verticalVelocityMpm).toBeCloseTo(-2 + full.drift * 60, 12);
    const partial = narcosisDriftStep(0, 0, 0.9, 30, 0.1, script(0).draw);
    expect(partial.drift).toBeCloseTo(-0.5 * 0.3 * (0.45 / 0.55) * 0.1 * 0.98, 15);
    // A draw of 0.5 only decays it: a drift at rest stays exactly at rest.
    expect(narcosisDriftStep(0, 4, 1, 30, 0.1, script(0.5).draw)).toEqual({ drift: 0, verticalVelocityMpm: 4 });
  });
});

describe("the model's narcosis draws", () => {
  it("swallows from the dive's random state, and advances it only by the draws made", () => {
    const state = deep(0.9);
    const model = new DiveModel(state);
    const kept = model.swallowInputs({ ...ALL, left: false }, 1 / 60);
    expect(model.snapshot.randomState).toBe(after(state.randomState, 3));
    const draws = [1, 2, 3].map((n) => nextRandom(after(state.randomState, n - 1)).value);
    // 0.9: a chance of 0.9 - 0.3 / 0.7 * 0.6 per 60 Hz frame.
    const p = ((0.9 - 0.3) / 0.7) * 0.6;
    expect(kept).toEqual({ inflate: draws[0]! > p, vent: draws[1]! > p, left: false, right: draws[2]! > p });

    const sober = new DiveModel(deep(0.3));
    const before = sober.snapshot;
    expect(sober.swallowInputs(ALL, 1 / 60)).toEqual(ALL);
    expect(sober.snapshot).toBe(before);
  });

  it("drifts after the physics with the frame's real time, before the shark rolls", () => {
    const state = freezeDiveState({ ...deep(0.9), shark: { timerS: seconds(0.05), encounter: null } });
    const shark: SharkFrame = {
      timeMultiplier: 3, diverVelocityMps: 0, viewLeftM: 25, viewRightM: 25, floorAt: () => 300, noShark: false,
    };
    const model = new DiveModel(state);
    model.advanceWithBuoyancy(BOUNDS, seconds(0.06), { inflate: false, vent: false }, false, shark, 0.02);
    const first = nextRandom(state.randomState).value;
    // The drift took the first draw, the shark's spawn roll the second.
    expect(model.snapshot.narcosisDrift).toBeCloseTo((first - 0.5) * 0.3 * (0.45 / 0.55) * 0.02 * 0.98, 15);
    expect(model.snapshot.randomState).toBe(after(state.randomState, 2));
    expect(model.snapshot.shark.timerS).toBe(60);

    // Without the real time nothing drifts, and only the shark draws.
    const without = new DiveModel(state);
    without.advanceWithBuoyancy(BOUNDS, seconds(0.06), { inflate: false, vent: false }, false, shark);
    expect(without.snapshot.narcosisDrift).toBe(0);
    expect(without.snapshot.randomState).toBe(after(state.randomState, 1));
  });

  it("plays out the same from the same seed, and from a save written on the way", () => {
    const frames = (model: DiveModel, count: number) => {
      for (let i = 0; i < count; i += 1) {
        const kept = model.swallowInputs({ ...NONE, vent: i % 3 === 0, right: true }, 1 / 60);
        model.advanceWithBuoyancy(BOUNDS, seconds(3 / 60), kept, false, undefined, 1 / 60);
      }
    };
    const whole = new DiveModel(deep(0.9));
    frames(whole, 240);
    const first = new DiveModel(deep(0.9));
    frames(first, 120);
    const save = decodeSaveGame(encodeSaveGame(createSaveGame(first.snapshot, { lowPercent: 30, highPercent: 70 }, 1)));
    expect(save.ok).toBe(true);
    if (!save.ok) return;
    expect(save.saveGame.state.narcosisDrift).not.toBe(0);
    const resumed = new DiveModel(save.saveGame.state);
    frames(resumed, 120);
    expect(resumed.snapshot).toEqual(whole.snapshot);
    expect(whole.snapshot.narcosisDrift).not.toBe(0);
  });
});
