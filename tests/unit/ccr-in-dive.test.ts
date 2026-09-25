import { describe, expect, it } from "vitest";

import { DiveModel } from "../../src/core/dive-model";
import {
  CCR_SETPOINT_MAX_BAR,
  CCR_SETPOINT_MIN_BAR,
  CCR_SETPOINT_STEP_BAR,
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
} from "../../src/core/dive-state";
import { bars, metres, seconds } from "../../src/core/units";

// The in-dive rebreather operations (#163): the setpoint and the bailout,
// applied when pressed rather than sampled at the next step, with the same
// refusal rules legacy applies in src/game-loop.js updateDiving.

function ccrModel(targetPo2Bar = 0.7) {
  const ccr = createCcrState(createGasMix(0.21, 0), {
    targetPo2Bar: bars(targetPo2Bar),
    actualPo2Bar: bars(targetPo2Bar),
  });
  return new DiveModel(createInitialDiveState(41, { ccr }));
}

describe("DiveModel.adjustSetpoint", () => {
  it("uses the legacy bounds and step", () => {
    // src/constants.js CCR_SP_MIN, CCR_SP_MAX, CCR_SP_STEP.
    expect(CCR_SETPOINT_MIN_BAR).toBe(0.5);
    expect(CCR_SETPOINT_MAX_BAR).toBe(1.6);
    expect(CCR_SETPOINT_STEP_BAR).toBe(0.1);
  });

  it("moves the setpoint by a step, without a floating-point tail", () => {
    const model = ccrModel(0.7);

    const raised = model.adjustSetpoint(CCR_SETPOINT_STEP_BAR);
    // 0.7 + 0.1 is 0.7999999999999999 in binary; legacy's toFixed(1) snaps
    // it, and so does this.
    expect(raised.ccr?.targetPo2Bar).toBe(0.8);

    const lowered = model.adjustSetpoint(-CCR_SETPOINT_STEP_BAR);
    expect(lowered.ccr?.targetPo2Bar).toBe(0.7);
  });

  it("reaches 1.3 in six exact steps from 0.7", () => {
    const model = ccrModel(0.7);
    for (let i = 0; i < 6; i += 1) {
      model.adjustSetpoint(CCR_SETPOINT_STEP_BAR);
    }
    expect(model.snapshot.ccr?.targetPo2Bar).toBe(1.3);
  });

  it("clamps at both bounds and reports no change there", () => {
    const high = ccrModel(1.6);
    const before = high.snapshot;
    expect(high.adjustSetpoint(CCR_SETPOINT_STEP_BAR)).toBe(before);
    expect(high.adjustSetpoint(5)).toBe(before);

    const low = ccrModel(0.5);
    const lowBefore = low.snapshot;
    expect(low.adjustSetpoint(-CCR_SETPOINT_STEP_BAR)).toBe(lowBefore);

    // A large delta lands on the bound rather than overshooting it.
    expect(ccrModel(0.7).adjustSetpoint(5).ccr?.targetPo2Bar).toBe(1.6);
    expect(ccrModel(0.7).adjustSetpoint(-5).ccr?.targetPo2Bar).toBe(0.5);
  });

  it("does nothing on open circuit", () => {
    const model = new DiveModel(
      createInitialDiveState(42, {
        tanks: [createTankState(createGasMix(0.21, 0))],
      }),
    );
    const before = model.snapshot;
    expect(model.adjustSetpoint(CCR_SETPOINT_STEP_BAR)).toBe(before);
  });

  it("does nothing after a bailout", () => {
    // Legacy: `if (diveMode === 'ccr' && !ccrState.onBailout)` around the
    // setpoint keys. The loop is no longer breathed, so its setpoint is
    // moot.
    const model = ccrModel(0.7);
    model.bailOut();
    const before = model.snapshot;
    expect(model.adjustSetpoint(CCR_SETPOINT_STEP_BAR)).toBe(before);
    expect(model.snapshot.ccr?.targetPo2Bar).toBe(0.7);
  });

  it("ignores a non-finite or zero delta", () => {
    const model = ccrModel(0.7);
    const before = model.snapshot;
    expect(model.adjustSetpoint(0)).toBe(before);
    expect(model.adjustSetpoint(Number.NaN)).toBe(before);
    expect(model.adjustSetpoint(Number.POSITIVE_INFINITY)).toBe(before);
  });

  it("records no event, as legacy records none", () => {
    const model = ccrModel(0.7);
    model.adjustSetpoint(CCR_SETPOINT_STEP_BAR);
    expect(model.snapshot.events).toEqual([]);
  });

  it("leaves the previous snapshot untouched", () => {
    const model = ccrModel(0.7);
    const before = model.snapshot;
    model.adjustSetpoint(CCR_SETPOINT_STEP_BAR);
    expect(before.ccr?.targetPo2Bar).toBe(0.7);
    expect(Object.isFrozen(model.snapshot.ccr)).toBe(true);
  });
});

describe("DiveModel.bailOut", () => {
  it("bails out at once and records exactly one event", () => {
    const model = ccrModel(1.3);
    model.advance({ depthM: metres(30) }, seconds(10));

    const after = model.bailOut();

    expect(after.ccr?.onBailout).toBe(true);
    expect(after.ccr?.co2BuildupS).toBe(0);
    expect(after.events).toEqual([{ type: "bailout", elapsedTimeS: 10 }]);
  });

  it("cannot be reversed, and a second call is a no-op", () => {
    // Irreversible by construction: nothing clears onBailout. Confirmed by
    // the state, not by a dialog (#67).
    const model = ccrModel(1.3);
    model.bailOut();
    const after = model.snapshot;

    expect(model.bailOut()).toBe(after);
    model.advance({ depthM: metres(30) }, seconds(60));
    expect(model.snapshot.ccr?.onBailout).toBe(true);
    expect(
      model.snapshot.events.filter((event) => event.type === "bailout"),
    ).toHaveLength(1);
  });

  it("breathes the diluent open-circuit afterwards", () => {
    const model = ccrModel(1.3);
    model.bailOut();
    const pressureBefore = model.snapshot.ccr?.diluentCylinderPressureBar ?? 0;

    model.advance({ depthM: metres(30) }, seconds(60));

    // 15 L/min at 4 bar for one minute from a 3 L cylinder: 20 bar.
    expect(model.snapshot.ccr?.diluentCylinderPressureBar).toBeCloseTo(
      pressureBefore - 20,
      9,
    );
  });

  it("does nothing on open circuit", () => {
    const model = new DiveModel(createInitialDiveState(43));
    const before = model.snapshot;
    expect(model.bailOut()).toBe(before);
    expect(model.snapshot.events).toEqual([]);
  });

  it("does nothing on a failed dive", () => {
    // Hypoxic loop until the model fails, then try to bail out.
    const ccr = createCcrState(createGasMix(0.21, 0), {
      targetPo2Bar: bars(0.7),
      actualPo2Bar: bars(0.05),
      oxygenCylinderPressureBar: bars(0),
    });
    const model = new DiveModel(createInitialDiveState(44, { ccr }));
    model.advance({ depthM: metres(10) }, seconds(120));
    expect(model.snapshot.failure.reason).toBe("ccr-hypoxia");

    const failed = model.snapshot;
    expect(model.bailOut()).toBe(failed);
    expect(model.adjustSetpoint(CCR_SETPOINT_STEP_BAR)).toBe(failed);
  });
});
