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

  // The `surfaced` checkpoint is deliberately not asserted here. It is reached
  // through an ascent, and the golden fixture records depth only at
  // checkpoints — not the per-step trajectory. In the legacy client
  // updateBuoyancyPhysics() moves `depth` before updateTissues() runs, so
  // tissues load at depths the fixture never captures. Replaying the nominal
  // 12 m/min ramp lands ~1.2e-3 bar out, and a midpoint-depth replay ~1.0e-3,
  // so no depth schedule derivable from the fixture reproduces it at the
  // declared 1e-9 tolerance.
  //
  // This is a trace-contract gap, not a model defect: every static-depth
  // checkpoint matches exactly. Dynamic-depth parity is covered end to end by
  // tests/baseline.spec.js, which replays the real scenarios against the legacy
  // client and compares all checkpoints under the fixture's tolerance policy.
  // Asserting it here as well would require the trace schema to record the
  // depth trajectory, which is a WP-01 fixture change.

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
