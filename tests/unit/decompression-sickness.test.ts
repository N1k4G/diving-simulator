import { describe, expect, it } from "vitest";

import { decoStopDepth } from "../../src/core/decompression";
import {
  DCS_VIOLATION_FAILURE_SECONDS,
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

// Decompression sickness (#199), legacy's two checks in updateDiving(): the
// DCS timer, which counts each dive second shallower than the first stop
// while there is a ceiling and counts down otherwise, ending the dive at
// 60 s; and surfacing, shallower than 0.5 m, with a ceiling deeper than 3 m.

const TRIMIX = createGasMix(0.21, 0.35);

/** 20 minutes at 45 m on 21/35, legacy's trimix bottom: an 11.5 m ceiling. */
function trimixBottom(): DiveState {
  const model = new DiveModel(
    createInitialDiveState(31, { tanks: [createTankState(TRIMIX, 24, 200)] }),
  );
  model.advance({ depthM: metres(45) }, seconds(20 * 60));
  return model.snapshot;
}

function step(state: DiveState, depthM: number, elapsedS = 1, breathing = openCircuit(TRIMIX)): DiveState {
  return advanceDiveStep(state, { depthM: metres(depthM), breathing, gradientFactorHighPercent: 75 }, seconds(elapsedS));
}

function hold(state: DiveState, depthM: number, secondsHeld: number): DiveState {
  let next = state;
  for (let second = 0; second < secondsHeld; second++) next = step(next, depthM);
  return next;
}

function withTimers(state: DiveState, timers: Partial<DiveState["failure"]>): DiveState {
  return freezeDiveState({ ...state, failure: { ...state.failure, ...timers } });
}

describe("decompression sickness", () => {
  it("starts every dive with the timer at zero", () => {
    expect(createInitialDiveState(1).failure.dcsViolationS).toBe(0);
  });

  it("counts dive seconds above the first stop and ends the dive at 60", () => {
    const bottom = trimixBottom();
    expect(decoStopDepth(bottom.log.lastCeilingM)).toBe(12);
    const at59 = hold(bottom, 6, 59);
    expect(at59.failure.dcsViolationS).toBe(59);
    expect(at59.failure.reason).toBeNull();
    const at60 = step(at59, 6);
    expect(at60.failure.dcsViolationS).toBe(DCS_VIOLATION_FAILURE_SECONDS);
    expect(at60.failure.reason).toBe("decompression-sickness");
    expect(at60.events.at(-1)).toMatchObject({ type: "failure", failureReason: "decompression-sickness" });
    // A failed dive does not move on.
    expect(step(at60, 6)).toBe(at60);
  });

  it("counts down at the stop, second for second, and never below zero", () => {
    const above = hold(trimixBottom(), 6, 30);
    const atStop = hold(above, 12, 20);
    expect(decoStopDepth(atStop.log.lastCeilingM)).toBeLessThanOrEqual(12);
    expect(atStop.failure.dcsViolationS).toBe(10);
    expect(hold(atStop, 12, 30).failure.dcsViolationS).toBe(0);
  });

  it("does not count on a dive without a ceiling", () => {
    const model = new DiveModel(createInitialDiveState(3));
    model.advance({ depthM: metres(12) }, seconds(10 * 60));
    expect(model.snapshot.log.lastCeilingM).toBe(0);
    const surfaced = step(model.snapshot, 0, 1, openCircuit(createGasMix(0.21, 0)));
    expect(surfaced.failure.dcsViolationS).toBe(0);
    expect(surfaced.failure.reason).toBeNull();
  });

  it("ends a dive that surfaces with a ceiling deeper than 3 m on that step", () => {
    const surfaced = step(trimixBottom(), 0);
    expect(surfaced.log.lastCeilingM).toBeGreaterThan(3);
    expect(surfaced.failure.dcsViolationS).toBe(1);
    expect(surfaced.failure.reason).toBe("decompression-sickness");
  });

  it("lets a dive surface with a ceiling of 3 m or less, the timer counting", () => {
    // Stop by stop until the ceiling is 3 m or less, then up.
    let state = trimixBottom();
    // A failed dive stops moving, so the loop stops with it.
    while (state.log.lastCeilingM > 3 && state.failure.reason === null) {
      state = step(state, decoStopDepth(state.log.lastCeilingM));
    }
    expect(state.failure.reason).toBeNull();
    expect(state.failure.dcsViolationS).toBe(0);
    const surfaced = step(state, 0);
    expect(surfaced.log.lastCeilingM).toBeGreaterThan(0);
    expect(surfaced.log.lastCeilingM).toBeLessThanOrEqual(3);
    expect(surfaced.failure.reason).toBeNull();
    expect(surfaced.failure.dcsViolationS).toBe(1);
  });

  it("is checked after oxygen toxicity and before hypoxia, as legacy orders them", () => {
    const due = withTimers(trimixBottom(), { dcsViolationS: seconds(59.5) });
    const toxic = withTimers(due, { oxygenToxicityS: seconds(29.5) });
    expect(step(toxic, 6, 1, closedCircuit(1.7, TRIMIX)).failure.reason).toBe("oxygen-toxicity");
    const hypoxic = withTimers(due, { hypoxiaS: seconds(9.5) });
    expect(step(hypoxic, 6, 1, openCircuit(createGasMix(0.05, 0))).failure.reason).toBe("decompression-sickness");
  });

  it("checks surfacing after hypoxia, as legacy does", () => {
    const hypoxic = withTimers(trimixBottom(), { hypoxiaS: seconds(9.5) });
    expect(step(hypoxic, 0, 1, openCircuit(createGasMix(0.05, 0))).failure.reason).toBe("hypoxia");
  });

  it("leaves the timer where it was on a step a rebreather failure ends, which returns before legacy's check", () => {
    const model = new DiveModel(
      createInitialDiveState(7, { ccr: createCcrState(createGasMix(0.21, 0), { targetPo2Bar: bars(1.3) }) }),
    );
    model.advance({ depthM: metres(45) }, seconds(30 * 60));
    const loaded = model.snapshot;
    expect(decoStopDepth(loaded.log.lastCeilingM)).toBeGreaterThan(6);
    const primed = withTimers(loaded, { dcsViolationS: seconds(20) });
    // Without the failure, the step above the stop counts.
    expect(step(primed, 6, 1, closedCircuit(1.3, createGasMix(0.21, 0))).failure.dcsViolationS).toBe(21);
    const scrubberSpent = freezeDiveState({
      ...primed,
      ccr: { ...primed.ccr!, scrubberFailed: true, co2BuildupS: seconds(179.5) },
    });
    const failed = step(scrubberSpent, 6, 1, closedCircuit(1.3, createGasMix(0.21, 0)));
    expect(failed.failure.reason).toBe("ccr-co2");
    expect(failed.failure.dcsViolationS).toBe(20);
  });
});
