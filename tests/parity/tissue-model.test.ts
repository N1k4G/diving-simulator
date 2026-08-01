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
  };
  tissues: {
    n2_bar: number[];
    he_bar: number[];
  };
}

interface GoldenScenario {
  scenarioId: string;
  checkpoints: GoldenCheckpoint[];
}

const scenarios = baselineFixture.scenarios as GoldenScenario[];
const tolerance = baselineFixture.tolerances.absoluteEpsilon["tissues.*_bar"];

describe("pure tissue model parity", () => {
  it("matches the canonical air bottom and ascent checkpoints", () => {
    const scenario = findScenario("air-18m-30min");
    const bottom = findCheckpoint(scenario, "bottom-30min");
    const surfaced = findCheckpoint(scenario, "surfaced");
    const breathing = openCircuit(createGasMix(0.21, 0));
    const model = new DiveModel(createInitialDiveState(1));

    model.advance(
      { depthM: metres(18), breathing },
      minutesToSeconds(minutes(30)),
    );
    expectTissuesToMatch(model.snapshot, bottom);

    let depthM = 18;
    while (depthM > 0) {
      depthM = Math.max(0, depthM - 0.9);
      model.advance(
        { depthM: metres(depthM), breathing },
        minutesToSeconds(minutes(0.1)),
      );
    }
    expectTissuesToMatch(model.snapshot, surfaced);
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
      findScenario("ccr-30m-20min"),
      "bottom-20min",
    );
    const model = new DiveModel(createInitialDiveState(3));

    model.advance(
      {
        depthM: metres(30),
        breathing: closedCircuit(1.3, createGasMix(0.15, 0.45)),
      },
      minutesToSeconds(minutes(20)),
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
