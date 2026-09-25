import { describe, expect, it } from "vitest";

import baselineFixture from "../fixtures/traces/baseline-v1.json";
import { diveStateFromLegacyCheckpoint } from "../../src/app/legacy-dive-adapter";
import {
  DiveModel,
  closedCircuit,
  openCircuit,
} from "../../src/core/dive-model";
import {
  CCR_SETPOINT_STEP_BAR,
  createGasMix,
  type BreathingSource,
  type DiveState,
} from "../../src/core/dive-state";
import { metres, minutes, minutesToSeconds } from "../../src/core/units";

// #163 acceptance: "a recorded legacy dive with a tank switch, a setpoint
// change and a bailout reproduces the same model events in the migration
// client."
//
// The three acts come from two recorded dives, because in legacy too a CCR
// dive has a single open-circuit cylinder (TASK-019 loops to tankCount):
//   - the tank switch is trimix-45m-20min/deco-gas-21m, key 2 at 21 m;
//   - the setpoint change and the bailout are ccr-setpoint-bailout-30m, keys
//     ] and B at 30 m, recorded for this issue.
//
// Each test starts the model from the legacy checkpoint just before the key,
// replays the recorded tick in which legacy read it, applies the same act
// through the operation the migration client calls on that key
// (switchGas / adjustSetpoint / bailOut), and compares with the checkpoint
// after it: the discrete state and the event the model records, and the
// tissues at the fixture's own tolerance.
//
// ORDER WITHIN THE TICK. Legacy's updateDiving() integrates the tissues
// first and reads the tank, setpoint and bailout keys after
// (src/game-loop.js: updateTissues, then TASK-019, then the CCR setpoint
// block, then TASK-032F). So the tick that reads a key breathes the old gas,
// and the act applies from the next tick. The migration client applies an
// act between whole-second steps, when it is pressed, which is the same
// thing: advance the tick, then apply the act.
//
// WHAT IS NOT COMPARED. Open-circuit gas billing across the switch tick:
// legacy switches before it bills that tick's gas, so the 1.5 s tick is drawn
// from the new cylinder, where the migration client bills the step before
// the press to the old one. At most one tick of gas, on a cylinder the
// planner and the HUD read to the tenth of a bar. Recorded, not asserted.

interface Checkpoint {
  checkpointId: string;
  state: {
    depth_m: number;
    maxDepth_m: number;
    diveTime_min: number;
    diveMode?: string;
    activeTankIndex: number;
  };
  configuration?: { amv_lpm?: number };
  tissues: { n2_bar: number[]; he_bar: number[] };
  tanks?: {
    fO2: number;
    fHe: number;
    volume_l: number;
    pressure_bar: number;
    gasRemaining_l: number;
  }[];
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

interface Scenario {
  scenarioId: string;
  checkpoints: Checkpoint[];
}

const scenarios = baselineFixture.scenarios as unknown as Scenario[];
const tissueTolerance =
  baselineFixture.tolerances.absoluteEpsilon["tissues.*_bar"];
const cylinderTolerance =
  baselineFixture.tolerances.absoluteEpsilon["ccr.*Pressure_bar"];

function checkpoint(scenarioId: string, checkpointId: string): Checkpoint {
  const scenario = scenarios.find((entry) => entry.scenarioId === scenarioId);
  const found = scenario?.checkpoints.find(
    (entry) => entry.checkpointId === checkpointId,
  );
  if (!found) {
    throw new Error(`Missing golden checkpoint: ${scenarioId}/${checkpointId}`);
  }
  return found;
}

function modelFrom(start: Checkpoint, seed: number): DiveModel {
  return new DiveModel(diveStateFromLegacyCheckpoint(start, seed));
}

function replay(
  model: DiveModel,
  trajectory: Checkpoint["trajectory"],
  breathingForStep: (index: number) => BreathingSource | undefined,
): void {
  trajectory.forEach((step, index) => {
    const breathing = breathingForStep(index);
    model.advance(
      breathing
        ? { depthM: metres(step.depth_m), breathing }
        : { depthM: metres(step.depth_m) },
      minutesToSeconds(minutes(step.dtDive_min)),
    );
  });
}

function expectTissues(state: DiveState, expected: Checkpoint): void {
  for (let index = 0; index < 16; index += 1) {
    expect(
      Math.abs(
        (state.tissues.nitrogenBar[index] ?? Number.NaN) -
          (expected.tissues.n2_bar[index] ?? Number.NaN),
      ),
      `N2 compartment ${index + 1}`,
    ).toBeLessThanOrEqual(tissueTolerance);
    expect(
      Math.abs(
        (state.tissues.heliumBar[index] ?? Number.NaN) -
          (expected.tissues.he_bar[index] ?? Number.NaN),
      ),
      `He compartment ${index + 1}`,
    ).toBeLessThanOrEqual(tissueTolerance);
  }
}

describe("in-dive controls against the recorded legacy dives", () => {
  it("a tank switch at 21 m: the same cylinder, one event, the same tissues", () => {
    const before = checkpoint("trimix-45m-20min", "ascent-21m");
    const after = checkpoint("trimix-45m-20min", "deco-gas-21m");
    const model = modelFrom(before, 301);
    expect(model.snapshot.activeTankIndex).toBe(0);

    // The tick that read `2` still breathed Tx 21/35.
    replay(model, after.trajectory, () => openCircuit(createGasMix(0.21, 0.35)));
    model.switchGas(1);

    expect(model.snapshot.activeTankIndex).toBe(after.state.activeTankIndex);
    expect(model.snapshot.activeTankIndex).toBe(1);
    const switches = model.snapshot.events.filter(
      (event) => event.type === "gas-switch",
    );
    expect(switches).toHaveLength(1);
    expect(switches[0]?.tankIndex).toBe(1);
    expectTissues(model.snapshot, after);
  });

  it("] at 30 m: the setpoint legacy reached, and no event for it", () => {
    const before = checkpoint("ccr-setpoint-bailout-30m", "bottom-10min");
    const after = checkpoint("ccr-setpoint-bailout-30m", "setpoint-raised");
    expect(before.ccr?.targetPO2_bar).toBe(1.2);
    const model = modelFrom(before, 302);

    // The tick that read `]` integrated on the loop at the old 1.2 bar.
    replay(model, after.trajectory, () =>
      closedCircuit(1.2, createGasMix(0.15, 0.45)),
    );
    model.adjustSetpoint(CCR_SETPOINT_STEP_BAR);

    expect(model.snapshot.ccr?.targetPo2Bar).toBe(after.ccr?.targetPO2_bar);
    expect(model.snapshot.ccr?.targetPo2Bar).toBe(1.3);
    // Legacy records no event for a setpoint change, and neither does the
    // model; the parity is in the field, checkpoint by checkpoint.
    expect(model.snapshot.events).toEqual([]);
    expectTissues(model.snapshot, after);
  });

  it("the five minutes after ] breathe the raised setpoint", () => {
    // The act has to change what is breathed, not only a stored number. The
    // first tick after the change still integrates at 1.2 bar: legacy's loop
    // rises inside that tick, after the tissues (updateCCRLoop runs after
    // updateTissues), and one 6 s tick at 0.05 bar/s covers the 0.1 bar.
    // Every later tick is at 1.3.
    const before = checkpoint("ccr-setpoint-bailout-30m", "setpoint-raised");
    const after = checkpoint("ccr-setpoint-bailout-30m", "bottom-15min");
    const model = modelFrom(before, 303);
    const diluent = createGasMix(0.15, 0.45);

    replay(model, after.trajectory, (index) =>
      closedCircuit(index === 0 ? 1.2 : 1.3, diluent),
    );

    expect(after.ccr?.actualPO2_bar).toBeCloseTo(1.3, 12);
    expectTissues(model.snapshot, after);
  });

  it("B at 30 m: bailed out, one event, the same tissues, and it stays so", () => {
    const before = checkpoint("ccr-setpoint-bailout-30m", "bottom-15min");
    const after = checkpoint("ccr-setpoint-bailout-30m", "bailed-out");
    expect(before.ccr?.onBailout).toBe(false);
    const model = modelFrom(before, 304);

    // The tick that read `B` was still breathed on the loop.
    replay(model, after.trajectory, () =>
      closedCircuit(1.3, createGasMix(0.15, 0.45)),
    );
    model.bailOut();

    expect(model.snapshot.ccr?.onBailout).toBe(after.ccr?.onBailout);
    expect(model.snapshot.ccr?.onBailout).toBe(true);
    const bailouts = model.snapshot.events.filter(
      (event) => event.type === "bailout",
    );
    expect(bailouts).toHaveLength(1);
    expectTissues(model.snapshot, after);

    // Irreversible, as in legacy: a second B changes nothing and records
    // nothing.
    const bailedOut = model.snapshot;
    expect(model.bailOut()).toBe(bailedOut);
  });

  it("the ascent after B breathes and draws down the diluent, as legacy does", () => {
    // No breathing override here: after the bailout the model's own source
    // is the diluent open-circuit, a constant gas, so the whole-second
    // subdivision is exact, and its gas billing runs. That makes the diluent
    // cylinder's pressure a second, independent check of what is breathed.
    const before = checkpoint("ccr-setpoint-bailout-30m", "bailed-out");
    const after = checkpoint("ccr-setpoint-bailout-30m", "bailout-ascent-21m");
    const model = modelFrom(before, 305);

    replay(model, after.trajectory, () => undefined);

    expect(model.snapshot.failure.reason).toBeNull();
    expectTissues(model.snapshot, after);
    expect(
      Math.abs(
        (model.snapshot.ccr?.diluentCylinderPressureBar ?? Number.NaN) -
          (after.ccr?.diluentPressure_bar ?? Number.NaN),
      ),
    ).toBeLessThanOrEqual(cylinderTolerance);
  });
});
