import { describe, expect, it } from "vitest";

import {
  NARCOSIS_FAILURE_SECONDS,
  NARCOSIS_KO_INDEX,
  NARCOSIS_RAMP_DOWN_PER_S,
  NARCOSIS_RAMP_UP_PER_S,
  advanceDiveStep,
  closedCircuit,
  openCircuit,
} from "../../src/core/dive-model";
import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  freezeDiveState,
  type DiveState,
} from "../../src/core/dive-state";
import { bars, metres, seconds } from "../../src/core/units";

// Nitrogen narcosis (#189), legacy's updateNarcosis() (src/physics.js
// WP-020): the narcosis index moves toward smoothstep(1.5, 8 bar) of the
// narcotic partial pressure, (1 - fHe) times the ambient pressure, by 0.012
// of the gap per dive second rising and 0.025 falling, within 0 to 1. Each
// dive second at 0.95 or above counts towards a KO at 30 s; a step below it
// starts the count over.

const AIR = createGasMix(0.21, 0);

function at(depthM: number, narcosisIndex = 0, seed = 43): DiveState {
  return freezeDiveState({
    ...createInitialDiveState(seed),
    depthM: metres(depthM),
    maxDepthM: metres(depthM),
    narcosisIndex,
  });
}

function step(state: DiveState, depthM: number, elapsedS = 1, breathing = openCircuit(AIR)): DiveState {
  return advanceDiveStep(state, { depthM: metres(depthM), breathing }, seconds(elapsedS));
}

function withTimers(state: DiveState, timers: Partial<DiveState["failure"]>): DiveState {
  return freezeDiveState({ ...state, failure: { ...state.failure, ...timers } });
}

/** smoothstep(1.5, 8, bar), written out. */
function target(narcoticBar: number): number {
  const t = Math.max(0, Math.min(1, (narcoticBar - 1.5) / 6.5));
  return t * t * (3 - 2 * t);
}

describe("nitrogen narcosis", () => {
  it("starts every dive with the index and the KO timer at zero", () => {
    const state = createInitialDiveState(1);
    expect(state.narcosisIndex).toBe(0);
    expect(state.failure.narcosisKoS).toBe(0);
  });

  it("rises toward the target of the narcotic pressure by 0.012 of the gap per dive second", () => {
    // Air at 40 m: 5 bar narcotic.
    expect(step(at(40), 40).narcosisIndex).toBeCloseTo(target(5) * NARCOSIS_RAMP_UP_PER_S, 15);
    expect(step(at(40, 0.1), 40, 2).narcosisIndex).toBeCloseTo(0.1 + (target(5) - 0.1) * NARCOSIS_RAMP_UP_PER_S * 2, 15);
  });

  it("falls by 0.025 of the gap per dive second, faster than it rises", () => {
    // At 10 m, 2 bar: a target far below the index.
    expect(step(at(10, 0.9), 10).narcosisIndex).toBeCloseTo(0.9 + (target(2) - 0.9) * NARCOSIS_RAMP_DOWN_PER_S, 15);
  });

  it("does not count helium, and counts the oxygen, as legacy's (1 - fHe)", () => {
    const trimix = step(at(40), 40, 1, openCircuit(createGasMix(0.21, 0.35)));
    expect(trimix.narcosisIndex).toBeCloseTo(target(5 * 0.65) * NARCOSIS_RAMP_UP_PER_S, 15);
    // Nitrox 50 is as narcotic as air at the same depth.
    const nitrox = step(at(40), 40, 1, openCircuit(createGasMix(0.5, 0)));
    expect(nitrox.narcosisIndex).toBe(step(at(40), 40).narcosisIndex);
  });

  it("reads a rebreather's loop gas, the diluent's helium share of what is not oxygen", () => {
    // Tx 15/45 diluent at 30 m, 4 bar, loop PO2 1.3: helium is
    // (1 - 1.3 / 4) * 45 / 85 of the loop.
    const diluent = createGasMix(0.15, 0.45);
    const loop = step(at(30), 30, 1, closedCircuit(1.3, diluent));
    const heliumFraction = (1 - 1.3 / 4) * (0.45 / 0.85);
    expect(loop.narcosisIndex).toBeCloseTo(target((1 - heliumFraction) * 4) * NARCOSIS_RAMP_UP_PER_S, 15);
  });

  it("stays within 0 and 1 on a step long enough to overshoot", () => {
    expect(step(at(90, 0.5), 90, 200).narcosisIndex).toBe(1);
    expect(step(at(0, 0.5), 0.2, 100).narcosisIndex).toBe(0);
  });

  it("counts each dive second at 0.95 or above, and starts over below it", () => {
    // At 90 m the target is 1, so an index at the threshold rises.
    const counting = step(withTimers(at(90, NARCOSIS_KO_INDEX), { narcosisKoS: seconds(12) }), 90);
    expect(counting.failure.narcosisKoS).toBe(13);
    // At 40 m it falls below the threshold: the count is gone, not decayed.
    const reset = step(withTimers(at(40, NARCOSIS_KO_INDEX), { narcosisKoS: seconds(12) }), 40);
    expect(reset.narcosisIndex).toBeLessThan(NARCOSIS_KO_INDEX);
    expect(reset.failure.narcosisKoS).toBe(0);
  });

  it("ends the dive after 30 dive seconds at or above 0.95", () => {
    const at29 = withTimers(at(90, 0.99), { narcosisKoS: seconds(29) });
    const failed = step(at29, 90);
    expect(failed.failure.narcosisKoS).toBe(NARCOSIS_FAILURE_SECONDS);
    expect(failed.failure.reason).toBe("nitrogen-narcosis");
    expect(failed.events.at(-1)).toMatchObject({ type: "failure", failureReason: "nitrogen-narcosis" });
    expect(step(failed, 90)).toBe(failed);
  });

  it("is checked after hypoxia and barotrauma, and before surfacing with a ceiling, as legacy orders them", () => {
    const due = withTimers(at(90, 0.99), { narcosisKoS: seconds(29.5) });
    const hypoxic = withTimers(due, { hypoxiaS: seconds(9.5) });
    // 1 % oxygen at 90 m is 0.1 bar, hypoxic.
    expect(step(hypoxic, 90, 1, openCircuit(createGasMix(0.01, 0))).failure.reason).toBe("hypoxia");
    const rising = withTimers(due, { barotraumaS: seconds(9.5) });
    expect(step(rising, 89).failure.reason).toBe("pulmonary-barotrauma");
    // A deep ceiling, and a step to the surface that keeps the index high.
    const loaded = freezeDiveState({
      ...withTimers(at(1, 1), { narcosisKoS: seconds(29.5) }),
      tissues: { nitrogenBar: Array(16).fill(bars(4)), heliumBar: Array(16).fill(bars(0)) },
    });
    const surfaced = step(loaded, 0.2);
    expect(surfaced.narcosisIndex).toBeGreaterThanOrEqual(NARCOSIS_KO_INDEX);
    expect(surfaced.failure.reason).toBe("nitrogen-narcosis");
  });

  it("still moves on a step a rebreather failure ends, as legacy updates it before updateCCR() returns", () => {
    const loop = createCcrState(AIR, { targetPo2Bar: bars(1.3), actualPo2Bar: bars(1.3) });
    const primed = freezeDiveState({
      ...createInitialDiveState(9, { ccr: loop }),
      depthM: metres(60),
      maxDepthM: metres(60),
      narcosisIndex: 0.96,
      failure: { ...createInitialDiveState(9).failure, narcosisKoS: seconds(10) },
    });
    const scrubberSpent = freezeDiveState({
      ...primed,
      ccr: { ...primed.ccr!, scrubberFailed: true, co2BuildupS: seconds(179.5) },
    });
    const failed = step(scrubberSpent, 60, 1, closedCircuit(1.3, AIR));
    expect(failed.failure.reason).toBe("ccr-co2");
    expect(failed.narcosisIndex).not.toBe(0.96);
    expect(failed.narcosisIndex).toBe(step(primed, 60, 1, closedCircuit(1.3, AIR)).narcosisIndex);
    expect(failed.failure.narcosisKoS).toBe(11);
  });
});
