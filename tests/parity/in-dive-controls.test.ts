import { describe, expect, it } from "vitest";

import baselineFixture from "../fixtures/traces/baseline-v1.json";
import { diveStateFromLegacyCheckpoint } from "../../src/app/legacy-dive-adapter";
import { DiveModel, advanceDiveStep } from "../../src/core/dive-model";
import { CCR_SETPOINT_STEP_BAR, type DiveState } from "../../src/core/dive-state";
import { NO_ACTS, type DiveActs } from "../../src/core/inputs";
import { metres, minutes, minutesToSeconds } from "../../src/core/units";

// #163 acceptance: "a recorded legacy dive with a tank switch, a setpoint
// change and a bailout reproduces the same model events in the migration
// client."
//
// Two recorded dives, because a CCR dive has one open-circuit cylinder in
// legacy too (TASK-019 loops to tankCount):
//   - tec-switch-21m: key 2 at 21 m, then three minutes on the new cylinder;
//   - ccr-setpoint-bailout-30m: ] at 30 m, five minutes, B, then an ascent.
//
// ONE MODEL PER DIVE, ON ITS OWN LIFE SUPPORT. Each test starts DiveModel
// once, from the checkpoint before the first key, and carries that same
// model through every later checkpoint. No breathing source is injected, so
// the model's own gas billing, loop update and scrubber run, and every field
// the checkpoint records is compared: discrete state, events, tissues,
// cylinders, loop PO2 and scrubber. An earlier revision injected the loop
// PO2 and passed while gas billing and the loop update were switched off
// (#184 review round 1).
//
// WHY THE KEYS ARE ZERO-LENGTH TICKS. Legacy's updateDiving() reads the keys
// after it has integrated the tissues, and the setpoint and B after the gas
// use. So a key read inside an ordinary tick splits that tick: for a switch,
// the tick integrates the old gas and bills the new one. The recording reads
// each key in a zero-length tick, on a tick boundary, where nothing else
// moves (scripts/baseline-scenarios.cjs), and the model replays it as a
// zero-length frame (DiveModel.switchGas, adjustSetpoint, bailOut). The five
// minutes after ] are recorded in one-second ticks, the model's fixed step,
// because the loop climbs to the new setpoint inside them.
//
// The model reads the keys inside its frames at legacy's points too (#202).
// Two older recordings read a key inside an ordinary 1.5 s tick:
// trimix-45m-20min's key 2 at 21 m and ccr-bailout-30m's B at 30 m. The last
// describe block replays each as one frame with the act.

interface Checkpoint {
  checkpointId: string;
  state: {
    depth_m: number;
    maxDepth_m: number;
    diveTime_min: number;
    diveMode?: string;
    cns_percent: number;
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
const eps = baselineFixture.tolerances.absoluteEpsilon;

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

/** Advances the model through a recorded segment, on its own breathing. */
function replay(model: DiveModel, segment: Checkpoint): void {
  for (const step of segment.trajectory) {
    model.advance(
      { depthM: metres(step.depth_m) },
      minutesToSeconds(minutes(step.dtDive_min)),
    );
  }
}

function within(actual: number | undefined, expected: number | undefined, tolerance: number, what: string): void {
  expect(actual, what).toBeDefined();
  expect(expected, what).toBeDefined();
  expect(Math.abs((actual ?? Number.NaN) - (expected ?? Number.NaN)), what).toBeLessThanOrEqual(tolerance);
}

function expectTissues(state: DiveState, expected: Checkpoint): void {
  // CNS exposure (#186), on the model's own breathing, against legacy.
  within(state.cnsPercent, expected.state.cns_percent, eps.default, `CNS at ${expected.checkpointId}`);
  for (let index = 0; index < 16; index += 1) {
    within(state.tissues.nitrogenBar[index], expected.tissues.n2_bar[index], eps["tissues.*_bar"], `N2 compartment ${index + 1} at ${expected.checkpointId}`);
    within(state.tissues.heliumBar[index], expected.tissues.he_bar[index], eps["tissues.*_bar"], `He compartment ${index + 1} at ${expected.checkpointId}`);
  }
}

function expectCylinders(state: DiveState, expected: Checkpoint): void {
  expect(state.tanks).toHaveLength(expected.tanks?.length ?? -1);
  expected.tanks?.forEach((tank, index) => {
    within(state.tanks[index]?.gasRemainingL, tank.gasRemaining_l, eps["tanks.*.gasRemaining_l"], `cylinder ${index + 1} gas at ${expected.checkpointId}`);
  });
}

function expectLoop(state: DiveState, expected: Checkpoint): void {
  const ccr = state.ccr;
  const recorded = expected.ccr;
  expect(ccr, expected.checkpointId).not.toBeNull();
  expect(ccr?.onBailout, `onBailout at ${expected.checkpointId}`).toBe(recorded?.onBailout);
  within(ccr?.targetPo2Bar, recorded?.targetPO2_bar, eps.default, `setpoint at ${expected.checkpointId}`);
  within(ccr?.actualPo2Bar, recorded?.actualPO2_bar, eps.default, `loop PO2 at ${expected.checkpointId}`);
  within(ccr?.oxygenCylinderPressureBar, recorded?.o2Pressure_bar, eps["ccr.*Pressure_bar"], `O2 cylinder at ${expected.checkpointId}`);
  within(ccr?.diluentCylinderPressureBar, recorded?.diluentPressure_bar, eps["ccr.*Pressure_bar"], `diluent cylinder at ${expected.checkpointId}`);
  within(
    (ccr?.scrubberRemainingS ?? Number.NaN) / 60,
    recorded?.scrubberRemaining_min,
    eps["ccr.scrubberRemaining_min"],
    `scrubber at ${expected.checkpointId}`,
  );
}

describe("in-dive controls against the recorded legacy dives", () => {
  it("key 2 at 21 m: the same cylinder, one event, and three minutes billed to it", () => {
    const start = checkpoint("tec-switch-21m", "ascent-21m");
    const switched = checkpoint("tec-switch-21m", "switched");
    const later = checkpoint("tec-switch-21m", "deco-gas-3min");
    const model = new DiveModel(diveStateFromLegacyCheckpoint(start, 401));
    expect(model.snapshot.activeTankIndex).toBe(0);

    replay(model, switched);
    model.switchGas(1);

    expect(model.snapshot.activeTankIndex).toBe(switched.state.activeTankIndex);
    expect(model.snapshot.events).toEqual([
      { type: "gas-switch", elapsedTimeS: model.snapshot.elapsedTimeS, tankIndex: 1 },
    ]);
    expectTissues(model.snapshot, switched);
    expectCylinders(model.snapshot, switched);

    // The same model, on its own breathing and billing, for three minutes.
    replay(model, later);
    expect(model.snapshot.activeTankIndex).toBe(later.state.activeTankIndex);
    expect(model.snapshot.failure.reason).toBeNull();
    expectTissues(model.snapshot, later);
    expectCylinders(model.snapshot, later);
  });

  it("] then B at 30 m: the setpoint, the loop, the bailout and the ascent after it", () => {
    const start = checkpoint("ccr-setpoint-bailout-30m", "bottom-10min");
    const raised = checkpoint("ccr-setpoint-bailout-30m", "setpoint-raised");
    const holding = checkpoint("ccr-setpoint-bailout-30m", "bottom-15min");
    const bailedOut = checkpoint("ccr-setpoint-bailout-30m", "bailed-out");
    const ascent = checkpoint("ccr-setpoint-bailout-30m", "bailout-ascent-21m");
    const model = new DiveModel(diveStateFromLegacyCheckpoint(start, 402));
    expect(model.snapshot.ccr?.targetPo2Bar).toBe(1.2);

    // ]: the setpoint moves, nothing else does yet, and no event is
    // recorded — legacy records none for a setpoint change.
    replay(model, raised);
    model.adjustSetpoint(CCR_SETPOINT_STEP_BAR);
    expect(model.snapshot.ccr?.targetPo2Bar).toBe(1.3);
    expect(model.snapshot.events).toEqual([]);
    expectTissues(model.snapshot, raised);
    expectLoop(model.snapshot, raised);

    // Five minutes: the model's loop has to climb to the new setpoint by
    // itself, and its oxygen, diluent and scrubber have to follow legacy's.
    replay(model, holding);
    expect(model.snapshot.failure.reason).toBeNull();
    expectTissues(model.snapshot, holding);
    expectLoop(model.snapshot, holding);

    // B: bailed out, one event, and a second B changes nothing.
    replay(model, bailedOut);
    model.bailOut();
    expect(model.snapshot.events).toEqual([
      { type: "bailout", elapsedTimeS: model.snapshot.elapsedTimeS },
    ]);
    expectTissues(model.snapshot, bailedOut);
    expectLoop(model.snapshot, bailedOut);
    const once = model.snapshot;
    expect(model.bailOut()).toBe(once);

    // The ascent on the diluent, drawn from the diluent cylinder.
    replay(model, ascent);
    expect(model.snapshot.failure.reason).toBeNull();
    expectTissues(model.snapshot, ascent);
    expectLoop(model.snapshot, ascent);
  });
});

describe("in-dive keys read inside an ordinary legacy tick (#202)", () => {
  /** The recorded tick with the key, as one model frame carrying the act. */
  function frameWithKey(start: Checkpoint, recorded: Checkpoint, seed: number, acts: DiveActs, actFirst: (state: DiveState) => DiveState = (state) => state): DiveState {
    expect(recorded.trajectory).toHaveLength(1);
    const tick = recorded.trajectory[0]!;
    return advanceDiveStep(
      actFirst(diveStateFromLegacyCheckpoint(start, seed)),
      { depthM: metres(tick.depth_m) },
      minutesToSeconds(minutes(tick.dtDive_min)),
      acts,
    );
  }

  it("key 2 at 21 m: the tick's tissues and CNS on the old gas, its gas billed to the new cylinder", () => {
    const start = checkpoint("trimix-45m-20min", "ascent-21m");
    const switched = checkpoint("trimix-45m-20min", "deco-gas-21m");
    const acts = { ...NO_ACTS, switchGasIndices: [1] };

    const after = frameWithKey(start, switched, 403, acts);
    expect(after.activeTankIndex).toBe(switched.state.activeTankIndex);
    expect(after.events).toEqual([
      { type: "gas-switch", elapsedTimeS: after.elapsedTimeS, tankIndex: 1 },
    ]);
    expectTissues(after, switched);
    expectCylinders(after, switched);

    // Counter-check: switched before the tick, as the client did before
    // #202, the tick breathes the 50 % and leaves the recording.
    const early = frameWithKey(start, switched, 403, NO_ACTS, (state) =>
      new DiveModel(state).switchGas(1),
    );
    expect(Math.abs(early.cnsPercent - switched.state.cns_percent)).toBeGreaterThan(eps.default);
    expect(Math.abs((early.tissues.nitrogenBar[0] ?? 0) - (switched.tissues.n2_bar[0] ?? 0))).toBeGreaterThan(eps["tissues.*_bar"]);
  });

  it("B at 30 m: the tick on the loop, its oxygen and scrubber used, the diluent untouched", () => {
    const start = checkpoint("ccr-bailout-30m", "pre-bailout");
    const bailedOut = checkpoint("ccr-bailout-30m", "bailed-out");
    const acts = { ...NO_ACTS, bailout: true };

    const after = frameWithKey(start, bailedOut, 404, acts);
    expect(after.events).toEqual([
      { type: "bailout", elapsedTimeS: after.elapsedTimeS },
    ]);
    expectTissues(after, bailedOut);
    expectLoop(after, bailedOut);

    // Counter-check: bailed out before the tick, it draws the diluent.
    const early = frameWithKey(start, bailedOut, 404, NO_ACTS, (state) =>
      new DiveModel(state).bailOut(),
    );
    expect(
      Math.abs((early.ccr?.diluentCylinderPressureBar ?? 0) - (bailedOut.ccr?.diluentPressure_bar ?? 0)),
    ).toBeGreaterThan(eps["ccr.*Pressure_bar"]);
  });
});
