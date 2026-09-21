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
import {
  adjustSetpoint,
  applyDiluentPreset,
} from "../../src/app/setup/ccr-controls";

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

interface FixtureCcr {
  targetPO2_bar: number;
  actualPO2_bar: number;
  diluent: { fO2: number; fHe: number; fN2: number };
  o2Pressure_bar: number;
  diluentPressure_bar: number;
  scrubberRemaining_min: number;
  onBailout: boolean;
}

interface FixtureCheckpoint {
  checkpointId: string;
  configuration: { amv_lpm: number };
  tanks: FixtureTank[];
  ccr?: FixtureCcr;
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

  it("a CCR setup matches the closed-circuit scenario's loop and cylinders", () => {
    // scripts/baseline-scenarios.cjs configures ccr-30m-30min with setpoint
    // 1.3 and a Tx 15/45 diluent, which is diluent preset index 2 — the key
    // the legacy screen labels 3.
    const expected = surfaceCheckpoint("ccr-30m-30min");
    const fixture = expected.ccr;
    if (!fixture) throw new Error("ccr scenario has no ccr block");

    let setup = applyDiluentPreset(selectMode(createDefaultSetup(), "ccr"), 2);
    setup = adjustSetpoint(setup, 1.3 - 0.7);

    const state = toInitialDiveOptions(setup).ccr;
    expect(state).not.toBeNull();

    expect(state?.targetPo2Bar).toBe(fixture.targetPO2_bar);
    expect(state?.diluent.oxygenFraction).toBeCloseTo(fixture.diluent.fO2, 10);
    expect(state?.diluent.heliumFraction).toBeCloseTo(fixture.diluent.fHe, 10);
    expect(state?.diluent.nitrogenFraction).toBeCloseTo(fixture.diluent.fN2, 10);
    expect(state?.oxygenCylinderPressureBar).toBe(fixture.o2Pressure_bar);
    expect(state?.diluentCylinderPressureBar).toBe(fixture.diluentPressure_bar);
    expect(state?.scrubberRemainingS).toBe(fixture.scrubberRemaining_min * 60);
    expect(state?.onBailout).toBe(fixture.onBailout);

    // The scenario also keeps one open-circuit cylinder, as entering CCR does.
    expect(toInitialDiveOptions(setup).tanks).toHaveLength(expected.tanks.length);
  });

  it("does not claim parity for the loop's starting PO2", () => {
    // The fixture records actualPO2 1.3 because the scenario script forces it
    // after configuring, to skip the equilibration. A dive started from the
    // screen does not: src/game-loop.js sets
    // `actualPO2 = targetSP < ambientPressure(0) ? targetSP : 0.21`, and 1.3
    // is not below one bar, so the loop begins at 0.21 in both clients. The
    // two numbers disagree for a reason, and asserting equality here would
    // have meant "fixing" the model to match a test fixture.
    const fixture = surfaceCheckpoint("ccr-30m-30min").ccr;
    let setup = applyDiluentPreset(selectMode(createDefaultSetup(), "ccr"), 2);
    setup = adjustSetpoint(setup, 1.3 - 0.7);

    expect(fixture?.actualPO2_bar).toBe(1.3);
    expect(toInitialDiveOptions(setup).ccr?.actualPo2Bar).toBe(0.21);
  });
});
