import { describe, expect, it } from "vitest";

import {
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
} from "../../src/core/dive-state";
import { litres, metres, seconds } from "../../src/core/units";
import { ForecastScheduler } from "../../src/planner/forecast-scheduler";

describe("ForecastScheduler", () => {
  it("copies state at a lower cadence while the forecast inputs are stable", () => {
    const state = createInitialDiveState(50);
    const scheduler = new ForecastScheduler(seconds(2));

    const first = scheduler.takeSnapshotIfDue(state, seconds(0));
    const early = scheduler.takeSnapshotIfDue(state, seconds(1));
    const due = scheduler.takeSnapshotIfDue(state, seconds(2));

    expect(first).not.toBe(state);
    expect(first?.tissues.nitrogenBar).not.toBe(state.tissues.nitrogenBar);
    expect(early).toBeNull();
    expect(due).not.toBeNull();
  });

  it("requests immediately when a relevant input crosses a threshold", () => {
    const state = createInitialDiveState(51);
    const scheduler = new ForecastScheduler(seconds(5));
    scheduler.takeSnapshotIfDue(state, seconds(0));
    const deeperState = freezeDiveState({ ...state, depthM: metres(1) });

    expect(scheduler.takeSnapshotIfDue(deeperState, seconds(1))).not.toBeNull();
  });

  it("detects gas availability changes without reading mutable globals", () => {
    const state = createInitialDiveState(52, {
      tanks: [
        createTankState(createGasMix(0.21, 0)),
        createTankState(createGasMix(0.5, 0)),
      ],
    });
    const scheduler = new ForecastScheduler(seconds(5));
    scheduler.takeSnapshotIfDue(state, seconds(0));
    const emptyDecoTank = freezeDiveState({
      ...state,
      tanks: [
        state.tanks[0]!,
        { ...state.tanks[1]!, gasRemainingL: litres(0) },
      ],
    });

    expect(
      scheduler.takeSnapshotIfDue(emptyDecoTank, seconds(1)),
    ).not.toBeNull();
  });

  it("supports an explicit refresh and reset", () => {
    const state = createInitialDiveState(53);
    const scheduler = new ForecastScheduler(seconds(5));
    scheduler.takeSnapshotIfDue(state, seconds(0));

    expect(scheduler.takeSnapshotIfDue(state, seconds(1), true)).not.toBeNull();
    scheduler.reset();
    expect(scheduler.takeSnapshotIfDue(state, seconds(1))).not.toBeNull();
  });
});
