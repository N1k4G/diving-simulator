import { describe, expect, it } from "vitest";

import baselineFixture from "../fixtures/traces/baseline-v1.json";
import {
  adjustOxygenFraction,
  applyPreset,
  createDefaultSetup,
  selectMode,
  toInitialDiveOptions,
} from "../../src/app/setup/dive-setup";
import { addTank, selectTankTab } from "../../src/app/setup/tec-controls";

// The setup screen configures a dive; the golden trace records what the legacy
// client was configured with when it produced those checkpoints. If the two
// disagree, a dive set up in the migration client is not the dive the fixture
// describes, and every downstream parity assertion is comparing two different
// dives (#158).
//
// This asserts the configuration, not the simulation: tissue and planner
// parity live in the other files here. What it pins is that "air, 12 L,
// 200 bar" means the same thing on both sides, down to the derived
// gasRemaining the model stores instead of a pressure.

interface FixtureTank {
  fO2: number;
  fHe: number;
  fN2: number;
  volume_l: number;
  pressure_bar: number;
  gasRemaining_l: number;
}

interface FixtureCheckpoint {
  checkpointId: string;
  configuration: { amv_lpm: number };
  tanks: FixtureTank[];
}

interface FixtureScenario {
  scenarioId: string;
  checkpoints: FixtureCheckpoint[];
}

const scenarios = baselineFixture.scenarios as unknown as FixtureScenario[];

function surfaceCheckpoint(scenarioId: string): FixtureCheckpoint {
  const scenario = scenarios.find((entry) => entry.scenarioId === scenarioId);
  if (!scenario) throw new Error(`missing scenario: ${scenarioId}`);
  const checkpoint = scenario.checkpoints.find(
    (entry) => entry.checkpointId === "surface",
  );
  if (!checkpoint) throw new Error(`missing surface checkpoint: ${scenarioId}`);
  return checkpoint;
}

describe("setup configuration parity with the golden trace", () => {
  it("default rec setup matches the air scenario's tank and consumption", () => {
    const expected = surfaceCheckpoint("air-18m-30min");
    const options = toInitialDiveOptions(createDefaultSetup());
    const tank = options.tanks?.[0];
    const fixtureTank = expected.tanks[0]!;

    expect(tank?.gas.oxygenFraction).toBeCloseTo(fixtureTank.fO2, 10);
    expect(tank?.gas.heliumFraction).toBeCloseTo(fixtureTank.fHe, 10);
    expect(tank?.gas.nitrogenFraction).toBeCloseTo(fixtureTank.fN2, 10);
    expect(tank?.volumeL).toBe(fixtureTank.volume_l);
    // The model stores litres at the surface rather than a pressure, so this
    // is where a volume-times-pressure mistake would surface.
    expect(tank?.gasRemainingL).toBe(fixtureTank.gasRemaining_l);
    expect(options.surfaceAirConsumptionLpm).toBe(expected.configuration.amv_lpm);
  });

  it("tec setup on the Tx 21/35 preset matches the trimix scenario's first tank", () => {
    const expected = surfaceCheckpoint("trimix-45m-20min");
    const fixtureTank = expected.tanks[0]!;

    // Preset index 4 is Tx 21/35, which the legacy screen binds to key 5 and
    // which the trimix scenario configures as its bottom gas.
    const setup = applyPreset(selectMode(createDefaultSetup(), "tec"), 4);
    const tank = toInitialDiveOptions(setup).tanks?.[0];

    expect(tank?.gas.oxygenFraction).toBeCloseTo(fixtureTank.fO2, 10);
    expect(tank?.gas.heliumFraction).toBeCloseTo(fixtureTank.fHe, 10);
    expect(tank?.gas.nitrogenFraction).toBeCloseTo(fixtureTank.fN2, 10);
    expect(tank?.volumeL).toBe(fixtureTank.volume_l);
    expect(tank?.gasRemainingL).toBe(fixtureTank.gasRemaining_l);
  });

  it("a two-tank tec setup matches the trimix scenario's cylinder pair", () => {
    // The trimix scenario is configured with [[0.21, 0.35, 200], [0.5, 0, 200]]
    // in scripts/baseline-scenarios.cjs, so a two-tank tec setup has to
    // reproduce both. This is what the multi-tank slice is for.
    const expected = surfaceCheckpoint("trimix-45m-20min");
    expect(expected.tanks).toHaveLength(2);

    let setup = addTank(applyPreset(selectMode(createDefaultSetup(), "tec"), 4));
    setup = selectTankTab(setup, 1);
    // 50% deco gas: no preset carries it, so it is dialled in, which is what
    // the legacy screen does with the arrow keys too.
    setup = adjustOxygenFraction(setup, 0.5 - 0.21);

    const tanks = toInitialDiveOptions(setup).tanks;
    expect(tanks).toHaveLength(2);
    expect(tanks?.[0]?.gas.oxygenFraction).toBeCloseTo(expected.tanks[0]!.fO2, 10);
    expect(tanks?.[0]?.gas.heliumFraction).toBeCloseTo(expected.tanks[0]!.fHe, 10);
    expect(tanks?.[1]?.gas.oxygenFraction).toBeCloseTo(expected.tanks[1]!.fO2, 10);
    expect(tanks?.[1]?.gas.heliumFraction).toBeCloseTo(expected.tanks[1]!.fHe, 10);
    expect(tanks?.[1]?.gasRemainingL).toBe(expected.tanks[1]!.gasRemaining_l);
  });

  it("does not yet configure the CCR scenario, and says so", () => {
    // CCR lands in the third slice of #158. Asserting the current limit keeps
    // this file honest about what parity has actually been established: a
    // reader should not infer CCR coverage from the two tests above.
    const options = toInitialDiveOptions(createDefaultSetup());
    expect(options.ccr).toBeNull();
    expect(surfaceCheckpoint("ccr-30m-30min").tanks).toHaveLength(1);
  });
});
