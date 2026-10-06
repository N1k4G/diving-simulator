import { describe, expect, it } from "vitest";

import { neutralBcdSurfaceLitres } from "../../src/core/buoyancy";
import {
  BAROTRAUMA_FAILURE_SECONDS,
  DiveModel,
  advanceDiveStep,
  closedCircuit,
  openCircuit,
} from "../../src/core/dive-model";
import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
  type DiveState,
} from "../../src/core/dive-state";
import { bars, metres, seconds } from "../../src/core/units";

// Pulmonary barotrauma (#189), legacy's check in updateDiving(): each dive
// second of an ascent at BAROTRAUMA_RATE (18 m/min) or faster counts, any
// other second counts down twice as fast, to zero, and the dive ends when the
// timer reaches BAROTRAUMA_TIME (10 s).

const AIR = createGasMix(0.21, 0);
const TRIMIX = createGasMix(0.21, 0.35);

function at(depthM: number, seed = 41): DiveState {
  return freezeDiveState({ ...createInitialDiveState(seed), depthM: metres(depthM), maxDepthM: metres(depthM) });
}

function step(state: DiveState, depthM: number, elapsedS = 1, breathing = openCircuit(AIR)): DiveState {
  return advanceDiveStep(state, { depthM: metres(depthM), breathing }, seconds(elapsedS));
}

/** Rises `rateMpm` for `secondsHeld` one-second steps. */
function rise(state: DiveState, rateMpm: number, secondsHeld: number): DiveState {
  let next = state;
  for (let second = 0; second < secondsHeld; second++) next = step(next, next.depthM - rateMpm / 60);
  return next;
}

function withTimers(state: DiveState, timers: Partial<DiveState["failure"]>): DiveState {
  return freezeDiveState({ ...state, failure: { ...state.failure, ...timers } });
}

describe("pulmonary barotrauma", () => {
  it("starts every dive with the timer at zero", () => {
    expect(createInitialDiveState(1).failure.barotraumaS).toBe(0);
  });

  it("counts each dive second of a fast ascent and ends the dive at 10", () => {
    const at9 = rise(at(40), 24, 9);
    expect(at9.failure.barotraumaS).toBe(9);
    expect(at9.failure.reason).toBeNull();
    const at10 = rise(at9, 24, 1);
    expect(at10.failure.barotraumaS).toBe(BAROTRAUMA_FAILURE_SECONDS);
    expect(at10.failure.reason).toBe("pulmonary-barotrauma");
    expect(at10.events.at(-1)).toMatchObject({ type: "failure", failureReason: "pulmonary-barotrauma" });
    // A failed dive does not move on.
    expect(step(at10, 20)).toBe(at10);
  });

  it("counts an ascent of exactly 18 m/min, as legacy's >=, and not one just slower", () => {
    // One minute's step, so the rate is exact.
    expect(step(at(40), 22, 60).failure.reason).toBe("pulmonary-barotrauma");
    const slower = step(withTimers(at(40), { barotraumaS: seconds(9) }), 23, 60);
    expect(slower.failure.reason).toBeNull();
    expect(slower.failure.barotraumaS).toBe(0);
  });

  it("counts down twice as fast at any slower rate, and never below zero", () => {
    const primed = withTimers(at(30), { barotraumaS: seconds(5) });
    // Holding depth, a 9 m/min ascent and a descent all count down.
    expect(step(primed, 30).failure.barotraumaS).toBe(3);
    expect(step(primed, 29.85).failure.barotraumaS).toBe(3);
    expect(step(primed, 30.5).failure.barotraumaS).toBe(3);
    expect(step(primed, 30, 2.5).failure.barotraumaS).toBe(0);
    expect(step(step(primed, 30, 2), 30).failure.barotraumaS).toBe(0);
  });

  it("is checked after the DCS timer and before hypoxia, as legacy orders them", () => {
    const due = withTimers(at(30), { barotraumaS: seconds(9.5) });
    const toxic = withTimers(due, { oxygenToxicityS: seconds(29.5) });
    expect(step(toxic, 29, 1, closedCircuit(1.7, AIR)).failure.reason).toBe("oxygen-toxicity");
    const hypoxic = withTimers(due, { hypoxiaS: seconds(9.5) });
    // 2 % oxygen at 29 m is 0.08 bar, hypoxic.
    expect(step(hypoxic, 29, 1, openCircuit(createGasMix(0.02, 0))).failure.reason).toBe("pulmonary-barotrauma");

    // 20 minutes at 45 m on 21/35: a 12 m stop, so straight up to 6 m both
    // counts the DCS timer and is a fast ascent.
    const model = new DiveModel(createInitialDiveState(31, { tanks: [createTankState(TRIMIX, 24, 200)] }));
    model.advance({ depthM: metres(45) }, seconds(20 * 60));
    const bottom = withTimers(model.snapshot, { barotraumaS: seconds(9.5) });
    const breathing = openCircuit(TRIMIX);
    expect(step(withTimers(bottom, { dcsViolationS: seconds(59.5) }), 6, 1, breathing).failure.reason)
      .toBe("decompression-sickness");
    // Surfacing with a ceiling is checked after both.
    const surfaced = step(bottom, 0, 1, breathing);
    expect(surfaced.failure.reason).toBe("pulmonary-barotrauma");
    expect(surfaced.failure.dcsViolationS).toBe(1);
  });

  it("leaves the timer where it was on a step a rebreather failure ends, which returns before legacy's check", () => {
    const loop = createCcrState(AIR, { targetPo2Bar: bars(1.3), actualPo2Bar: bars(1.3) });
    const primed = withTimers(
      freezeDiveState({ ...createInitialDiveState(7, { ccr: loop }), depthM: metres(30), maxDepthM: metres(30) }),
      { barotraumaS: seconds(5) },
    );
    // Without the failure, the fast step counts.
    expect(step(primed, 29, 1, closedCircuit(1.3, AIR)).failure.barotraumaS).toBe(6);
    const scrubberSpent = freezeDiveState({
      ...primed,
      ccr: { ...primed.ccr!, scrubberFailed: true, co2BuildupS: seconds(179.5) },
    });
    const failed = step(scrubberSpent, 29, 1, closedCircuit(1.3, AIR));
    expect(failed.failure.reason).toBe("ccr-co2");
    expect(failed.failure.barotraumaS).toBe(5);
  });

  it("ends a runaway ascent of the client's own buoyancy physics", () => {
    // W held from neutral at 30 m in 60 Hz frames, as the client drives it.
    const model = new DiveModel(freezeDiveState({ ...at(30), bcdGasSurfaceLiters: neutralBcdSurfaceLitres(30) }));
    const bounds = { ceilingM: 0, floorM: 100 };
    let frames = 0;
    while (model.snapshot.failure.reason === null && frames < 2000) {
      model.advanceWithBuoyancy(bounds, seconds(0.05), { inflate: true, vent: false });
      frames += 1;
    }
    expect(model.snapshot.failure.reason).toBe("pulmonary-barotrauma");
    expect(model.snapshot.depthM).toBeGreaterThan(0);
  });
});
