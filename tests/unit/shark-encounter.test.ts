import { describe, expect, it } from "vitest";

import {
  SHARK_PASSED_SPEED_MPS,
  SHARK_SPEED_MPS,
  advanceDiveStep,
  advanceShark,
  closedCircuit,
  type SharkFrame,
} from "../../src/core/dive-model";
import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
  type DiveState,
  type SharkEncounter,
  type SharkState,
} from "../../src/core/dive-state";
import { nextRandom } from "../../src/core/rng";
import { bars, litres, metres, seconds } from "../../src/core/units";

// The shark encounter (#219), legacy's TASK-043 (src/game-loop.js): a roll
// every 60 dive seconds spawns a shark at 0.005, which swims past the diver
// in real time, tracks the diver's depth in dive time, and at contact (2 m
// across, 3 m in depth) attacks on a roll under 0.33. The model draws its
// rolls from the dive's seeded random state.

const AIR = createGasMix(0.21, 0);
const FRAME: SharkFrame = {
  timeMultiplier: 3,
  diverVelocityMps: 0,
  viewLeftM: 25,
  viewRightM: 25,
  waterAt: () => openWater(300),
  openTo: () => true,
  wayThroughAt: () => null,
  noShark: false,
};

/** Legacy's floor guard over a floor at floorM: 0 down to 0.5 m above it. */
function openWater(floorM: number) {
  return { shallowestM: 0, deepestM: floorM - 0.5 };
}

function shark(encounter: Partial<SharkEncounter> | null, timerS = 30): SharkState {
  return {
    timerS: seconds(timerS),
    encounter: encounter && {
      offsetM: 0,
      depthM: metres(10),
      direction: 1,
      speedMps: SHARK_SPEED_MPS,
      passed: false,
      ...encounter,
    },
  };
}

/** advanceShark with these rolls, which must all be drawn. */
function stepWith(state: SharkState, rolls: number[], diverDepthM = 10, elapsedS = 1, frame = FRAME) {
  const queue = [...rolls];
  const step = advanceShark(state, diverDepthM, frame, seconds(elapsedS), () => {
    const roll = queue.shift();
    if (roll === undefined) throw new Error("an unexpected roll");
    return roll;
  });
  expect(queue, "rolls left undrawn").toEqual([]);
  return step;
}

/** The first seed whose first roll passes `test`. */
function seedWhoseFirstRoll(test: (value: number) => boolean): number {
  for (let seed = 0; ; seed += 1) {
    if (test(nextRandom(seed).value)) return seed;
  }
}

/** A diver at 10 m with a shark 1 m short of them, contact on the next step. */
function closing(seed: number, overrides: Partial<DiveState> = {}): DiveState {
  return freezeDiveState({
    ...createInitialDiveState(seed),
    depthM: metres(10),
    maxDepthM: metres(10),
    shark: shark({ offsetM: -1 }),
    ...overrides,
  });
}

describe("the shark encounter", () => {
  it("starts every dive a minute from the first roll with no shark", () => {
    expect(createInitialDiveState(1).shark).toEqual({ timerS: 60, encounter: null });
  });

  it("is not simulated without the world: no timer, no roll", () => {
    const state = closing(5);
    const next = advanceDiveStep(state, { depthM: metres(10) }, seconds(90));
    expect(next.shark).toEqual(state.shark);
    expect(next.randomState).toBe(state.randomState);
  });

  it("rolls once a minute of dive time, restarting the timer at 60 and dropping the remainder", () => {
    expect(stepWith(shark(null, 30), [], 10, 29).shark.timerS).toBe(1);
    expect(stepWith(shark(null, 30), [0.5], 10, 31).shark).toEqual({ timerS: 60, encounter: null });
  });

  it("draws its rolls from the dive's random state, the same every replay", () => {
    const state = freezeDiveState({ ...createInitialDiveState(11), shark: shark(null, 1) });
    const next = advanceDiveStep(state, { depthM: metres(10), shark: FRAME }, seconds(1));
    expect(nextRandom(11).value).toBeGreaterThanOrEqual(0.005);
    expect(next.randomState).toBe(nextRandom(11).state);
    expect(advanceDiveStep(state, { depthM: metres(10), shark: FRAME }, seconds(1))).toEqual(next);
  });

  it("spawns at 0.005 beyond the view's edge, within 10 m of the diver's depth, behind its heading", () => {
    const right = stepWith(shark(null, 1), [0.004, 0.2, 0.75], 10, 1).shark.encounter!;
    expect(right).toMatchObject({ direction: 1, speedMps: SHARK_SPEED_MPS, passed: false });
    // 30 m back, then one dive second, a third of a real one, at 7.5 m/s.
    expect(right.offsetM).toBeCloseTo(-30 + 2.5, 12);
    // 5 m below the diver, tracked 0.3 m back up.
    expect(right.depthM).toBeCloseTo(15 - 0.3, 12);
    const left = stepWith(shark(null, 1), [0.001, 0.5, 0], 2, 1).shark.encounter!;
    expect(left.direction).toBe(-1);
    expect(left.offsetM).toBeCloseTo(30 - 2.5, 12);
    // Clamped to the surface, then tracked down.
    expect(left.depthM).toBeCloseTo(0.3, 12);
    expect(stepWith(shark(null, 1), [0.005], 10, 1).shark.encounter).toBeNull();
    // Clamped to MAX_DEPTH over a deeper floor, then tracked up for 1 ms.
    const deep = stepWith(shark(null, 0.0005), [0.001, 0.5, 1], 299, 0.001, { ...FRAME, waterAt: () => openWater(400) });
    expect(deep.shark.encounter!.depthM).toBeCloseTo(300 - 0.0003, 9);
  });

  it("rolls on a noShark site but spawns nothing, and rolls nothing while a shark swims", () => {
    expect(stepWith(shark(null, 1), [0], 10, 1, { ...FRAME, noShark: true }).shark.encounter).toBeNull();
    expect(stepWith(shark({ offsetM: -20, depthM: metres(30) }, 1), []).shark.encounter).not.toBeNull();
  });

  it("swims in real time relative to a moving diver, and tracks the depth in dive time over the floor", () => {
    const fast = { ...FRAME, timeMultiplier: 30, diverVelocityMps: 0.5 };
    const moved = stepWith(shark({ offsetM: -20, depthM: metres(20) }), [], 10, 3, fast).shark.encounter!;
    expect(moved.offsetM).toBeCloseTo(-20 - 1.5 + 7.5 * 0.1, 12);
    expect(moved.depthM).toBeCloseTo(20 - 0.9, 12);
    expect(stepWith(shark({ offsetM: -20, depthM: metres(10.05) }), []).shark.encounter!.depthM).toBe(10.05);
    const floored = stepWith(shark({ offsetM: -20, depthM: metres(12) }), [], 14, 1, { ...FRAME, waterAt: () => openWater(12) });
    expect(floored.shark.encounter!.depthM).toBe(11.5);
  });

  it("rolls once at contact, inside 2 m across and 3 m in depth: under 0.33 attacks", () => {
    const struck = stepWith(shark({ offsetM: -1 }), [0.3299]);
    expect(struck.attacked).toBe(true);
    expect(struck.shark.encounter).toMatchObject({ passed: true, speedMps: SHARK_SPEED_MPS });
    const survived = stepWith(shark({ offsetM: -1 }), [0.33]);
    expect(survived.attacked).toBe(false);
    expect(survived.shark.encounter).toMatchObject({ passed: true, speedMps: SHARK_PASSED_SPEED_MPS });
    // Still beside the diver a millisecond later: no second roll.
    expect(stepWith(survived.shark, [], 10, 0.001).shark.encounter).toMatchObject({ passed: true });
    // The window is open at its edges.
    expect(stepWith(shark({ offsetM: -4.5 }), []).shark.encounter!.passed).toBe(false);
    expect(stepWith(shark({ offsetM: -1, depthM: metres(13.3) }), []).shark.encounter!.passed).toBe(false);
  });

  it("leaves 7.5 m beyond the view's edge in its heading", () => {
    expect(stepWith(shark({ offsetM: 30.1, passed: true }), []).shark.encounter).toBeNull();
    expect(stepWith(shark({ offsetM: 29.9, passed: true }), []).shark.encounter!.offsetM).toBeCloseTo(32.4, 12);
    expect(stepWith(shark({ offsetM: 29.9, passed: true, direction: -1 }), []).shark.encounter).not.toBeNull();
    expect(stepWith(shark({ offsetM: -30.1, passed: true, direction: -1 }), []).shark.encounter).toBeNull();
  });

  it("spawns and leaves beyond each edge of a view that is not centred on the diver (#219 part 2)", () => {
    // A camera leading the diver to the right: 21 m of view behind, 37 ahead.
    const led = { ...FRAME, viewLeftM: 21, viewRightM: 37 };
    const right = stepWith(shark(null, 1), [0.004, 0.2, 0.5], 10, 1, led).shark.encounter!;
    expect(right.offsetM).toBeCloseTo(-26 + 2.5, 12);
    const left = stepWith(shark(null, 1), [0.004, 0.5, 0.5], 10, 1, led).shark.encounter!;
    expect(left.offsetM).toBeCloseTo(42 - 2.5, 12);
    expect(stepWith(shark({ offsetM: 42.1, passed: true }), [], 10, 1, led).shark.encounter).toBeNull();
    expect(stepWith(shark({ offsetM: 41.9, passed: true }), [], 10, 1, led).shark.encounter).not.toBeNull();
    expect(stepWith(shark({ offsetM: -26.1, passed: true, direction: -1 }), [], 10, 1, led).shark.encounter).toBeNull();
    expect(stepWith(shark({ offsetM: -25.9, passed: true, direction: -1 }), [], 10, 1, led).shark.encounter).not.toBeNull();
  });

  it("asks for the water from where the shark was to where it has swum, and holds it there (#240 PR 3b)", () => {
    const asked: [number, number, number][] = [];
    const waterAt = (fromOffsetM: number, fromDepthM: number, toOffsetM: number) => {
      asked.push([fromOffsetM, fromDepthM, toOffsetM]);
      return toOffsetM > -18 ? { shallowestM: 0, deepestM: 14.5 } : openWater(300);
    };
    // From 20 m back to 17.5 m back, from 20 m: over the shallower water
    // only once it has swum, tracked up to 19.7 m and held at 14.5 m.
    const floored = stepWith(shark({ offsetM: -20, depthM: metres(20) }), [], 10, 1, { ...FRAME, waterAt });
    expect(asked).toHaveLength(1);
    expect(asked[0]![0]).toBe(-20);
    expect(asked[0]![1]).toBe(20);
    expect(asked[0]![2]).toBeCloseTo(-17.5, 12);
    expect(floored.shark.encounter!.depthM).toBe(14.5);
    // Under a deck it is held below it, tracking a diver above the deck.
    const roofed = { ...FRAME, waterAt: () => ({ shallowestM: 28.5, deepestM: 38.5 }) };
    expect(stepWith(shark({ offsetM: -20, depthM: metres(28.6) }), [], 10, 1, roofed).shark.encounter!.depthM).toBe(28.5);
  });

  it("turns away where a structure stands in its way, with no contact roll, and is gone there where none of it can be seen (#240 PR 3b)", () => {
    // Water where it is, 0.5 m over a floor at 10.5 m; none where it swims to.
    const closed = {
      ...FRAME,
      waterAt: (fromOffsetM: number, _fromDepthM: number, toOffsetM: number) =>
        toOffsetM === fromOffsetM ? openWater(10.5) : null,
    };
    // Beside the diver and not yet passed, where it would roll for contact:
    // it turns where it is, passed, held clear of the floor, and draws nothing.
    const turned = stepWith(shark({ offsetM: -1, depthM: metres(10.2) }), [], 10, 1, closed);
    expect(turned).toEqual({
      shark: { timerS: 29, encounter: { offsetM: -1, depthM: 10, direction: -1, speedMps: SHARK_SPEED_MPS, passed: true } },
      attacked: false,
    });
    // Beyond the view's 25 m by more than the drawn shark reaches, 3.375 m,
    // none of it is seen and it is gone; nearer it turns.
    expect(stepWith(shark({ offsetM: -28.4 }), [], 10, 1, closed)).toEqual({ shark: { timerS: 29, encounter: null }, attacked: false });
    expect(stepWith(shark({ offsetM: -28.3 }), [], 10, 1, closed).shark.encounter).toMatchObject({ direction: -1 });
    // A spawn into closed water, 5 m beyond the view, unseen: gone.
    expect(stepWith(shark(null, 1), [0.004, 0.2, 0.75], 10, 1, closed).shark.encounter).toBeNull();
  });

  it("holds a passed shark where it is and takes it to the depth its way on opens at, turning only where none does (#240 PR 3b)", () => {
    // Its way opens at 12 m, a door: from 10 m it sinks 0.3 m a dive second where it is, never past.
    const door = {
      ...FRAME,
      waterAt: (fromOffsetM: number, fromDepthM: number, toOffsetM: number) =>
        toOffsetM === fromOffsetM || fromDepthM === 12 ? openWater(20) : null,
      wayThroughAt: () => 12,
    };
    const seeking = stepWith(shark({ offsetM: 3, passed: true }), [], 10, 1, door).shark.encounter!;
    expect(seeking).toMatchObject({ offsetM: 3, direction: 1, passed: true });
    expect(seeking.depthM).toBeCloseTo(10.3, 12);
    const there = stepWith(shark({ offsetM: 3, depthM: metres(11.9), passed: true }), [], 10, 1, door).shark.encounter!;
    expect(there.depthM).toBe(12);
    // At 12 m it swims on.
    expect(stepWith(shark({ offsetM: 3, depthM: metres(12), passed: true }), [], 12, 1, door).shark.encounter!.offsetM).toBeCloseTo(5.5, 12);
    // Its way closed, it turns again, still passed.
    const closed = { ...door, wayThroughAt: () => null };
    expect(stepWith(shark({ offsetM: 3, passed: true }), [], 10, 1, closed).shark.encounter).toMatchObject({ offsetM: 3, direction: -1 });
    // One yet to pass the diver turns, and never seeks.
    expect(stepWith(shark({ offsetM: -3 }), [], 10, 1, door).shark.encounter).toMatchObject({ offsetM: -3, direction: -1, passed: true, depthM: 10 });
  });

  it("rolls contact only with open water between it and the diver (#240 PR 3b)", () => {
    const walled = { ...FRAME, openTo: () => false };
    const step = stepWith(shark({ offsetM: -1 }), [], 10, 1, walled);
    expect(step.attacked).toBe(false);
    expect(step.shark.encounter).toMatchObject({ passed: false, speedMps: SHARK_SPEED_MPS });
  });

  it("ends the dive in a shark attack on a seed whose contact roll is under 0.33", () => {
    const seed = seedWhoseFirstRoll((value) => value < 0.33);
    const failed = advanceDiveStep(closing(seed), { depthM: metres(10), shark: FRAME }, seconds(1));
    expect(failed.failure.reason).toBe("shark-attack");
    expect(failed.events.at(-1)).toMatchObject({ type: "failure", failureReason: "shark-attack" });
    const spared = seedWhoseFirstRoll((value) => value >= 0.33);
    expect(advanceDiveStep(closing(spared), { depthM: metres(10), shark: FRAME }, seconds(1)).failure.reason).toBeNull();
  });

  it("comes before out of gas, as legacy checks it first", () => {
    const seed = seedWhoseFirstRoll((value) => value < 0.33);
    const empty = closing(seed, { tanks: [{ ...createTankState(AIR), gasRemainingL: litres(0) }] });
    expect(advanceDiveStep(empty, { depthM: metres(10) }, seconds(1)).failure.reason).toBe("out-of-gas");
    const failed = advanceDiveStep(empty, { depthM: metres(10), shark: FRAME }, seconds(1));
    expect(failed.failure.reason).toBe("shark-attack");
  });

  it("stays put on a step a rebreather failure ends, which returns before legacy moves it", () => {
    const seed = seedWhoseFirstRoll((value) => value < 0.33);
    const loop = createCcrState(AIR, { targetPo2Bar: bars(1.3), actualPo2Bar: bars(1.3) });
    const base = closing(seed, { ccr: { ...loop, scrubberFailed: true, co2BuildupS: seconds(179.5) } });
    const failed = advanceDiveStep(base, { depthM: metres(10), breathing: closedCircuit(1.3, AIR), shark: FRAME }, seconds(1));
    expect(failed.failure.reason).toBe("ccr-co2");
    expect(failed.shark).toEqual(base.shark);
    expect(failed.randomState).toBe(base.randomState);
  });
});
