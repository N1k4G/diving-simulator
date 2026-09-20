import { describe, expect, it } from "vitest";

import baselineFixture from "../fixtures/traces/baseline-v1.json";
import { diveStateFromLegacyCheckpoint } from "../../src/app/legacy-dive-adapter";
import {
  DiveModel,
  closedCircuit,
  openCircuit,
} from "../../src/core/dive-model";
import {
  createGasMix,
  createInitialDiveState,
  type BreathingSource,
  type DiveState,
} from "../../src/core/dive-state";
import { metres, minutes, minutesToSeconds } from "../../src/core/units";

interface GoldenCheckpoint {
  checkpointId: string;
  state: {
    depth_m: number;
    maxDepth_m: number;
    diveTime_min: number;
    diveMode?: string;
    activeTankIndex?: number;
  };
  configuration?: {
    amv_lpm?: number;
  };
  tissues: {
    n2_bar: number[];
    he_bar: number[];
  };
  tanks?: {
    fO2: number;
    fHe: number;
    volume_l: number;
    pressure_bar: number;
    gasRemaining_l: number;
  }[];
  // Every updateDiving() tick since the previous checkpoint, in order. depth_m
  // is the depth read back after the tick — the depth updateTissues()
  // integrated at, not the one the scenario asked for (#156).
  trajectory: { depth_m: number; dtDive_min: number }[];
  ccr?: {
    targetPO2_bar: number;
    actualPO2_bar: number;
    diluent: { fO2: number; fHe: number };
    o2Pressure_bar: number;
    diluentPressure_bar: number;
    scrubberRemaining_min: number;
    onBailout: boolean;
  };
}

interface GoldenScenario {
  scenarioId: string;
  checkpoints: GoldenCheckpoint[];
}

const scenarios = baselineFixture.scenarios as GoldenScenario[];
const tolerance = baselineFixture.tolerances.absoluteEpsilon["tissues.*_bar"];

describe("pure tissue model parity", () => {
  it("matches the canonical air bottom checkpoint", () => {
    const bottom = findCheckpoint(findScenario("air-18m-30min"), "bottom-30min");
    const model = new DiveModel(createInitialDiveState(1));

    model.advance(
      { depthM: metres(18), breathing: openCircuit(createGasMix(0.21, 0)) },
      minutesToSeconds(minutes(30)),
    );

    expectTissuesToMatch(model.snapshot, bottom);
  });

  // The ascent-reached checkpoint the fixture could not previously express
  // (#156). Until the trace recorded a trajectory, no depth schedule derivable
  // from it reproduced this: the nominal 12 m/min ramp landed ~1.2e-3 bar out
  // and a midpoint-depth replay ~1.0e-3, against a 1e-9 tolerance. The cause
  // was never the model — updateBuoyancyPhysics() moves `depth` before
  // updateTissues() reads it, so the legacy client integrates at depths the
  // ramp never visits. The fixture now records those depths as they were read
  // back after each tick, and replaying them closes the gap.
  //
  // Note what is asserted and what is not. The final trajectory step is at
  // 0.08 m while the checkpoint's state.depth_m is 0, because ascend() calls
  // setDepth(0) after its loop without a tick. The trajectory is the record of
  // what the tissues saw, not of where the diver was parked afterwards, so
  // this replays tissues and does not assert the final depth.
  it("matches the air surfaced checkpoint by replaying the recorded ascent", () => {
    const scenario = findScenario("air-18m-30min");
    const bottom = findCheckpoint(scenario, "bottom-30min");
    const surfaced = findCheckpoint(scenario, "surfaced");

    expect(surfaced.trajectory.length).toBeGreaterThan(0);

    const model = new DiveModel(diveStateFromLegacyCheckpoint(bottom, 4));
    replayTrajectory(model, surfaced.trajectory, () =>
      openCircuit(createGasMix(0.21, 0)),
    );

    expectTissuesToMatch(model.snapshot, surfaced);
  });

  it("replays the trimix ascent before the deco gas switch", () => {
    const scenario = findScenario("trimix-45m-20min");
    const bottom = findCheckpoint(scenario, "bottom-20min");
    const ascent = findCheckpoint(scenario, "ascent-21m");

    const model = new DiveModel(diveStateFromLegacyCheckpoint(bottom, 5));
    replayTrajectory(model, ascent.trajectory, () =>
      openCircuit(createGasMix(0.21, 0.35)),
    );

    expectTissuesToMatch(model.snapshot, ascent);
  });

  it("replays the CCR ascent at a held setpoint", () => {
    const scenario = findScenario("ccr-30m-30min");
    const bottom = findCheckpoint(scenario, "bottom-30min");
    const ascent = findCheckpoint(scenario, "ascent-12m");

    const model = new DiveModel(diveStateFromLegacyCheckpoint(bottom, 6));
    replayTrajectory(model, ascent.trajectory, () =>
      closedCircuit(1.3, createGasMix(0.15, 0.45)),
    );

    expectTissuesToMatch(model.snapshot, ascent);
  });

  it("matches the canonical trimix bottom checkpoint", () => {
    const bottom = findCheckpoint(
      findScenario("trimix-45m-20min"),
      "bottom-20min",
    );
    const model = new DiveModel(createInitialDiveState(2));

    model.advance(
      {
        depthM: metres(45),
        breathing: openCircuit(createGasMix(0.21, 0.35)),
      },
      minutesToSeconds(minutes(20)),
    );

    expectTissuesToMatch(model.snapshot, bottom);
  });

  it("matches the canonical CCR bottom checkpoint", () => {
    const bottom = findCheckpoint(
      findScenario("ccr-30m-30min"),
      "bottom-30min",
    );
    const model = new DiveModel(createInitialDiveState(3));

    model.advance(
      {
        depthM: metres(30),
        breathing: closedCircuit(1.3, createGasMix(0.15, 0.45)),
      },
      minutesToSeconds(minutes(30)),
    );

    expectTissuesToMatch(model.snapshot, bottom);
  });

  it("adapts a legacy checkpoint without sharing mutable tissue arrays", () => {
    const checkpoint = findCheckpoint(
      findScenario("air-18m-30min"),
      "bottom-30min",
    );
    const state = diveStateFromLegacyCheckpoint(checkpoint, 99);

    expectTissuesToMatch(state, checkpoint);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.tissues.nitrogenBar)).toBe(true);
    expect(state.tissues.nitrogenBar).not.toBe(checkpoint.tissues.n2_bar);
  });

  it("adapts canonical gas, timer, and CCR checkpoint fields", () => {
    const checkpoint = findCheckpoint(
      findScenario("ccr-30m-30min"),
      "bottom-30min",
    );
    const state = diveStateFromLegacyCheckpoint(checkpoint, 100);

    expect(state.elapsedTimeS).toBeCloseTo(1800, 6);
    expect(state.activeTankIndex).toBe(0);
    expect(state.tanks[0]?.gasRemainingL).toBe(2400);
    expect(state.surfaceAirConsumptionLpm).toBe(15);
    expect(state.ccr?.targetPo2Bar).toBe(1.3);
    expect(state.ccr?.actualPo2Bar).toBe(1.3);
    expect(state.ccr?.oxygenCylinderPressureBar).toBeCloseTo(188, 6);
    expect(state.ccr?.diluentCylinderPressureBar).toBe(200);
    expect(state.ccr?.scrubberRemainingS).toBeCloseTo(9_000, 6);
    expect(state.ccr?.onBailout).toBe(false);
  });
});

function findScenario(scenarioId: string): GoldenScenario {
  const scenario = scenarios.find((entry) => entry.scenarioId === scenarioId);

  if (!scenario) {
    throw new Error(`Missing golden scenario: ${scenarioId}`);
  }

  return scenario;
}

function findCheckpoint(
  scenario: GoldenScenario,
  checkpointId: string,
): GoldenCheckpoint {
  const checkpoint = scenario.checkpoints.find(
    (entry) => entry.checkpointId === checkpointId,
  );

  if (!checkpoint) {
    throw new Error(`Missing golden checkpoint: ${checkpointId}`);
  }

  return checkpoint;
}

// Drives the model through a recorded trajectory, one step per legacy tick.
//
// DiveModel.advance subdivides into FIXED_STEP_SECONDS, so a 1.5 s legacy tick
// becomes 1.0 s + 0.5 s. That is exact for this comparison rather than merely
// close: the tissue integrator is p + (t - p) * exp(-k * dt) at a constant
// depth, and exp(-k * 1.0) * exp(-k * 0.5) === exp(-k * 1.5) to within double
// rounding, far inside the 1e-9 tolerance.
function replayTrajectory(
  model: DiveModel,
  trajectory: { depth_m: number; dtDive_min: number }[],
  breathingAt: (depthM: number) => BreathingSource,
): void {
  for (const step of trajectory) {
    model.advance(
      { depthM: metres(step.depth_m), breathing: breathingAt(step.depth_m) },
      minutesToSeconds(minutes(step.dtDive_min)),
    );
  }
}

function expectTissuesToMatch(
  state: DiveState,
  checkpoint: GoldenCheckpoint,
): void {
  expect(state.tissues.nitrogenBar).toHaveLength(16);
  expect(state.tissues.heliumBar).toHaveLength(16);

  for (let index = 0; index < 16; index += 1) {
    expectDifferenceWithin(
      state.tissues.nitrogenBar[index],
      checkpoint.tissues.n2_bar[index],
    );
    expectDifferenceWithin(
      state.tissues.heliumBar[index],
      checkpoint.tissues.he_bar[index],
    );
  }
}

function expectDifferenceWithin(
  actual: number | undefined,
  expected: number | undefined,
): void {
  expect(actual).toBeTypeOf("number");
  expect(expected).toBeTypeOf("number");
  expect(Math.abs((actual ?? 0) - (expected ?? 0))).toBeLessThanOrEqual(
    tolerance,
  );
}
