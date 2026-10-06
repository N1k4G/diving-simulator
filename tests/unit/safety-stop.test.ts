import { describe, expect, it } from "vitest";

import { DiveModel, isAtSafetyStop } from "../../src/core/dive-model";
import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
  type DiveState,
} from "../../src/core/dive-state";
import { metres, seconds } from "../../src/core/units";

// The adaptive safety stop (#199), on dictated depths in one-second steps.
// Ports of legacy's harness cases TC-22 to TC-31 and TC-90
// (src/diving-simulator-tests.html); the recorded dives are compared in
// tests/parity/dive-log.test.ts.

const air = createGasMix(0.21, 0);

function diver(depthM: number, maxDepthM = depthM, edit: (state: DiveState) => DiveState = (state) => state): DiveModel {
  const base = createInitialDiveState(9, { tanks: [createTankState(air)] });
  return new DiveModel(
    edit(freezeDiveState({ ...base, depthM: metres(depthM), maxDepthM: metres(maxDepthM) })),
  );
}

function hold(model: DiveModel, depthM: number, stepsS: number): void {
  for (let second = 0; second < stepsS; second += 1) model.advance({ depthM: metres(depthM) }, seconds(1));
}

describe("the adaptive safety stop", () => {
  it("starts with nothing set (TC-31)", () => {
    expect(createInitialDiveState(1).safetyStop).toEqual({
      needed: false,
      countdownStarted: false,
      remainingS: 0,
      paused: false,
      complete: false,
    });
  });

  it("is not needed after a dive no deeper than 11 m (TC-22)", () => {
    const model = diver(11);
    hold(model, 11, 5);
    hold(model, 4, 5);
    expect(model.snapshot.safetyStop.needed).toBe(false);
    expect(model.snapshot.safetyStop.countdownStarted).toBe(false);
  });

  it("is needed once deeper than 11 m, and lasts 3 minutes (TC-23)", () => {
    const model = diver(12);
    hold(model, 12, 1);
    expect(model.snapshot.safetyStop.needed).toBe(true);
    hold(model, 5, 1);
    // Started and counted in the same step, as legacy does.
    expect(model.snapshot.safetyStop.countdownStarted).toBe(true);
    expect(model.snapshot.safetyStop.remainingS).toBe(180 - 1);
  });

  it("lasts 5 minutes after a dive deeper than 30 m (TC-24)", () => {
    const model = diver(5, 31);
    hold(model, 5, 1);
    expect(model.snapshot.safetyStop.remainingS).toBe(300 - 1);
  });

  it("lasts 5 minutes after the NDL fell below 5 (TC-25)", () => {
    const model = diver(5, 15, (state) =>
      freezeDiveState({ ...state, log: { ...state.log, minNdlMin: 4, ndlDroppedBelowFiveMinutes: true } }),
    );
    hold(model, 5, 1);
    expect(model.snapshot.safetyStop.remainingS).toBe(300 - 1);
  });

  it("starts its countdown only shallower than 6 m (TC-26)", () => {
    const model = diver(7, 20);
    hold(model, 7, 3);
    expect(model.snapshot.safetyStop.countdownStarted).toBe(false);
    hold(model, 5.9, 1);
    expect(model.snapshot.safetyStop.countdownStarted).toBe(true);
  });

  it("counts down inside 2.4 to 8.3 m (TC-27)", () => {
    const model = diver(5, 20);
    hold(model, 5, 1);
    hold(model, 8.3, 4);
    hold(model, 2.4, 5);
    expect(model.snapshot.safetyStop.remainingS).toBe(180 - 10);
    expect(model.snapshot.safetyStop.paused).toBe(false);
    expect(isAtSafetyStop(model.snapshot)).toBe(true);
  });

  it("pauses outside that band, and resumes inside it (TC-28)", () => {
    const model = diver(5, 20);
    hold(model, 5, 1);
    hold(model, 2, 5);
    expect(model.snapshot.safetyStop.paused).toBe(true);
    expect(model.snapshot.safetyStop.remainingS).toBe(180 - 1);
    expect(isAtSafetyStop(model.snapshot)).toBe(false);
    hold(model, 9, 5);
    expect(model.snapshot.safetyStop.paused).toBe(true);
    expect(model.snapshot.safetyStop.remainingS).toBe(180 - 1);
    hold(model, 5, 1);
    expect(model.snapshot.safetyStop.paused).toBe(false);
    expect(model.snapshot.safetyStop.remainingS).toBe(180 - 2);
  });

  it("starts over when the diver goes back below 11 m (TC-29)", () => {
    const model = diver(5, 20);
    hold(model, 5, 10);
    hold(model, 12, 1);
    expect(model.snapshot.safetyStop).toEqual({
      needed: true,
      countdownStarted: false,
      remainingS: 0,
      paused: false,
      complete: false,
    });
  });

  it("completes when the countdown reaches zero, and then stops counting (TC-30)", () => {
    const model = diver(5, 20);
    hold(model, 5, 180);
    expect(model.snapshot.safetyStop.complete).toBe(true);
    expect(model.snapshot.safetyStop.remainingS).toBe(0);
    hold(model, 2, 3);
    expect(model.snapshot.safetyStop.paused).toBe(false);
    expect(isAtSafetyStop(model.snapshot)).toBe(false);
  });

  it("is not updated on the step a rebreather failure ends the dive on", () => {
    // Legacy runs the stop after updateCCR(), which returns on the failure.
    const loop = createCcrState(air);
    const model = diver(5, 20, (state) =>
      freezeDiveState({
        ...state,
        ccr: { ...loop, scrubberFailed: true, co2BuildupS: seconds(179.5) },
        safetyStop: { needed: true, countdownStarted: true, remainingS: seconds(100), paused: false, complete: false },
      }),
    );
    hold(model, 5, 1);
    expect(model.snapshot.failure.reason).toBe("ccr-co2");
    expect(model.snapshot.safetyStop.remainingS).toBe(100);
  });

  it("needs a new stop after a completed one, if the diver goes back below 11 m (#90)", () => {
    const model = diver(5, 20);
    hold(model, 5, 180);
    expect(model.snapshot.safetyStop.complete).toBe(true);
    hold(model, 12, 1);
    expect(model.snapshot.safetyStop.complete).toBe(false);
    hold(model, 5, 1);
    expect(model.snapshot.safetyStop.countdownStarted).toBe(true);
    expect(model.snapshot.safetyStop.remainingS).toBe(180 - 1);
  });
});
