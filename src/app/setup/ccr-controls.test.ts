import { describe, expect, it } from "vitest";

import {
  createDefaultSetup,
  selectMode,
  toInitialDiveOptions,
  type DiveSetup,
} from "./dive-setup";
import {
  CCR_DILUENT_PRESETS,
  CCR_PRESSURE_STEP_BAR,
  DILUENT_VOLUME_RANGE_L,
  OXYGEN_PRESSURE_RANGE_BAR,
  OXYGEN_VOLUME_RANGE_L,
  SETPOINT_RANGE_BAR,
  SETPOINT_STEP_BAR,
  adjustDiluentVolume,
  adjustOxygenPressure,
  adjustOxygenVolume,
  adjustSetpoint,
  applyDiluentPreset,
  matchingDiluentPreset,
} from "./ccr-controls";
import {
  adjustOxygenFraction,
  applyPreset,
  presetCountFor,
} from "./dive-setup";
import { createGasMix } from "../../core/dive-state";

const ccr = (): DiveSetup => selectMode(createDefaultSetup(), "ccr");

// Every bound below cites the legacy function it was read from. A number in
// this file that cannot be traced to src/state.js or src/constants.js is a bug
// in the test, not a specification — the lesson from the first slice, where
// invented bounds were asserted as if they were the contract.

describe("the diluent, from ccrApplyDilPreset", () => {
  it("offers the five legacy mixes in the legacy order", () => {
    // src/state.js CCR_DIL_PRESETS. The order is load-bearing: the screen
    // binds them to keys 1-5 by index.
    expect(
      CCR_DILUENT_PRESETS.map((preset) => [
        preset.oxygenFraction,
        preset.heliumFraction,
      ]),
    ).toEqual([
      [0.21, 0],
      [0.21, 0.35],
      [0.15, 0.45],
      [0.1, 0.7],
      [0.1, 0.9],
    ]);
  });

  it("sets all three fractions and touches nothing else", () => {
    const trimix = applyDiluentPreset(ccr(), 2);

    expect(trimix.ccr.diluent.oxygenFraction).toBeCloseTo(0.15, 10);
    expect(trimix.ccr.diluent.heliumFraction).toBeCloseTo(0.45, 10);
    expect(trimix.ccr.diluent.nitrogenFraction).toBeCloseTo(0.4, 10);
    expect(trimix.ccr.setpointBar).toBe(0.7);
    expect(trimix.ccr.oxygenCylinderVolumeL).toBe(2);
  });

  it("refuses an index outside the list rather than clamping", () => {
    // Same rule as the open-circuit presets, and it matters more here: the
    // neighbouring mix of a diluent can be hypoxic at the surface.
    const setup = ccr();
    expect(applyDiluentPreset(setup, 5)).toBe(setup);
    expect(applyDiluentPreset(setup, -1)).toBe(setup);
    expect(applyDiluentPreset(setup, 1.5)).toBe(setup);
  });

  it("leaves the open-circuit presets unreachable in CCR", () => {
    // src/ui.js hides presetsDiv in CCR and updateGasSetup returns before the
    // preset loop, so the legacy screen cannot apply one. presetCountFor
    // returned GAS_PRESETS.length here, which let applyPreset change the
    // cylinder CCR deliberately hides — no player could reach it through the
    // screen, but the pure model is the contract and it said otherwise.
    expect(presetCountFor("ccr")).toBe(0);

    const setup = ccr();
    for (let index = 0; index < 8; index += 1) {
      expect(applyPreset(setup, index)).toBe(setup);
    }
  });

  it("is not the open-circuit preset list", () => {
    // Index 2 is EAN32 open-circuit and Tx 15/45 as a diluent. Sharing one
    // list would have bound key 3 to a 32% nitrox diluent.
    const asDiluent = applyDiluentPreset(ccr(), 2).ccr.diluent;
    const asTank = applyPreset(createDefaultSetup(), 2).tanks[0]!.gas;

    expect(asDiluent.oxygenFraction).toBeCloseTo(0.15, 10);
    expect(asTank.oxygenFraction).toBeCloseTo(0.32, 10);
  });

  it("names the matching preset, and nothing for a mix that is none of them", () => {
    // src/state.js ccrDilPresetName matches within 0.005 and otherwise says
    // 'Custom'; this returns null so the word stays in the catalogue.
    expect(matchingDiluentPreset(ccr().ccr)?.id).toBe("air");
    expect(matchingDiluentPreset(applyDiluentPreset(ccr(), 3).ccr)?.id).toBe(
      "tx10-70",
    );

    const drifted = { ...ccr().ccr, diluent: createGasMix(0.3, 0.2) };
    expect(matchingDiluentPreset(drifted)).toBeNull();
  });
});

describe("the setpoint, from ccrAdjustSP", () => {
  it("clamps to CCR_SP_MIN and CCR_SP_MAX", () => {
    // src/constants.js CCR_SP_MIN 0.5, CCR_SP_MAX 1.6, CCR_SP_STEP 0.1.
    expect(SETPOINT_RANGE_BAR.min).toBe(0.5);
    expect(SETPOINT_RANGE_BAR.max).toBe(1.6);
    expect(SETPOINT_STEP_BAR).toBe(0.1);

    expect(adjustSetpoint(ccr(), 999).ccr.setpointBar).toBe(1.6);
    expect(adjustSetpoint(ccr(), -999).ccr.setpointBar).toBe(0.5);
  });

  it("does not accumulate floating-point drift", () => {
    // Legacy writes +(x).toFixed(1) for exactly this reason: 0.7 + 0.1 is
    // 0.7999999999999999. Six steps up from 0.7 must be 1.3 on the nose,
    // because the parity fixture's CCR scenario is configured at 1.3.
    let setup = ccr();
    for (let i = 0; i < 6; i += 1) setup = adjustSetpoint(setup, SETPOINT_STEP_BAR);

    expect(setup.ccr.setpointBar).toBe(1.3);
  });

  it("returns the same object when it cannot move", () => {
    const floored = adjustSetpoint(ccr(), -999);
    expect(adjustSetpoint(floored, -SETPOINT_STEP_BAR)).toBe(floored);
  });
});

describe("the cylinders, from ccrAdjustDilVol, ccrAdjustO2Vol and ccrAdjustO2Pres", () => {
  it("clamps the diluent cylinder to CCR_DIL_VOL_MIN and MAX", () => {
    // src/constants.js CCR_DIL_VOL_MIN 2, CCR_DIL_VOL_MAX 12.
    expect(DILUENT_VOLUME_RANGE_L.min).toBe(2);
    expect(DILUENT_VOLUME_RANGE_L.max).toBe(12);

    expect(adjustDiluentVolume(ccr(), 1).ccr.diluentCylinderVolumeL).toBe(4);
    expect(adjustDiluentVolume(ccr(), 999).ccr.diluentCylinderVolumeL).toBe(12);
    expect(adjustDiluentVolume(ccr(), -999).ccr.diluentCylinderVolumeL).toBe(2);
  });

  it("clamps the oxygen cylinder to CCR_O2_VOL_MIN and MAX", () => {
    // src/constants.js CCR_O2_VOL_MIN 2, CCR_O2_VOL_MAX 5 — the BUG-CCR-4 fix.
    expect(OXYGEN_VOLUME_RANGE_L.min).toBe(2);
    expect(OXYGEN_VOLUME_RANGE_L.max).toBe(5);

    expect(adjustOxygenVolume(ccr(), 999).ccr.oxygenCylinderVolumeL).toBe(5);
    expect(adjustOxygenVolume(ccr(), -999).ccr.oxygenCylinderVolumeL).toBe(2);
  });

  it("clamps the oxygen pressure to CCR_O2_PRES_MIN and MAX in steps of ten", () => {
    // src/constants.js CCR_O2_PRES_MIN 50, CCR_O2_PRES_MAX 300, step 10 —
    // a wider range than the open-circuit 200-300 of gsAdjustPressure.
    expect(OXYGEN_PRESSURE_RANGE_BAR.min).toBe(50);
    expect(OXYGEN_PRESSURE_RANGE_BAR.max).toBe(300);
    expect(CCR_PRESSURE_STEP_BAR).toBe(10);

    expect(adjustOxygenPressure(ccr(), 999).ccr.oxygenCylinderPressureBar).toBe(300);
    expect(adjustOxygenPressure(ccr(), -999).ccr.oxygenCylinderPressureBar).toBe(50);
  });
});

describe("conversion into a dive", () => {
  it("builds a CCR state in CCR and none outside it", () => {
    expect(toInitialDiveOptions(createDefaultSetup()).ccr).toBeNull();
    expect(toInitialDiveOptions(ccr()).ccr).not.toBeNull();
  });

  it("carries the configured diluent, setpoint and cylinders", () => {
    let setup = applyDiluentPreset(ccr(), 2);
    for (let i = 0; i < 6; i += 1) setup = adjustSetpoint(setup, SETPOINT_STEP_BAR);
    setup = adjustDiluentVolume(setup, 2);
    setup = adjustOxygenVolume(setup, 1);
    setup = adjustOxygenPressure(setup, -50);

    const state = toInitialDiveOptions(setup).ccr!;

    expect(state.targetPo2Bar).toBe(1.3);
    expect(state.diluent.oxygenFraction).toBeCloseTo(0.15, 10);
    expect(state.diluent.heliumFraction).toBeCloseTo(0.45, 10);
    expect(state.diluentCylinderVolumeL).toBe(5);
    expect(state.oxygenCylinderVolumeL).toBe(3);
    expect(state.oxygenCylinderPressureBar).toBe(150);
  });

  it("leaves the loop at 0.21 when the setpoint cannot be reached at the surface", () => {
    // src/game-loop.js on dive start:
    // `actualPO2 = targetSP < ambientPressure(0) ? targetSP : 0.21`, and
    // ambientPressure(0) is 1.0. createCcrState already implements the rule;
    // this pins that the setup path does not bypass it.
    let high = ccr();
    for (let i = 0; i < 6; i += 1) high = adjustSetpoint(high, SETPOINT_STEP_BAR);
    expect(toInitialDiveOptions(high).ccr?.actualPo2Bar).toBe(0.21);

    // The default 0.7 is below one bar, so the loop starts there.
    expect(toInitialDiveOptions(ccr()).ccr?.actualPo2Bar).toBe(0.7);
  });

  it("keeps the open-circuit cylinder the dive still carries", () => {
    // Legacy normalises to one tank on entering CCR and stops offering the
    // controls; the tank itself stays, because the model wants one.
    const options = toInitialDiveOptions(ccr());
    expect(options.tanks).toHaveLength(1);
    expect(options.tanks?.[0]?.gas.oxygenFraction).toBeCloseTo(0.21, 10);
  });

  it("fills the fields the legacy setup screen cannot change from CCR_DEFAULTS", () => {
    // 200 bar diluent, a 6 L loop, 180 minutes of scrubber, 0.8 L/min
    // metabolic rate. No control exists for any of them, in either client.
    const state = toInitialDiveOptions(ccr()).ccr!;

    expect(state.diluentCylinderPressureBar).toBe(200);
    expect(state.loopVolumeL).toBe(6);
    expect(state.scrubberRemainingS).toBe(180 * 60);
    expect(state.metabolicOxygenLpm).toBe(0.8);
  });
});

describe("mode memory, from saveModeSettings", () => {
  it("survives a trip through another mode", () => {
    // src/state.js keeps ccrState in modeSettings alongside the tanks and the
    // gradient factors, so leaving CCR and coming back restores the loop.
    const configured = adjustSetpoint(applyDiluentPreset(ccr(), 3), 0.3);
    expect(configured.ccr.setpointBar).toBe(1);

    const returned = selectMode(selectMode(configured, "rec"), "ccr");

    expect(returned.ccr.setpointBar).toBe(1);
    expect(returned.ccr.diluent.heliumFraction).toBeCloseTo(0.7, 10);
  });

  it("is per mode, so the value seen in rec is rec's own", () => {
    // Surprising but faithful: legacy keeps ccrState inside each mode's
    // modeSettings entry, so entering rec restores rec's copy — the default,
    // if CCR was configured after rec was last left. The configured loop is
    // not lost, it is parked under 'ccr' until CCR is entered again, which
    // the test above covers. Written down because "the diluent changed when I
    // went to rec" looks like a bug until you know it is the oracle.
    const configured = applyDiluentPreset(ccr(), 2);
    const inRec = selectMode(configured, "rec");

    expect(inRec.ccr.diluent.oxygenFraction).toBeCloseTo(0.21, 10);
    expect(selectMode(inRec, "ccr").ccr.diluent.oxygenFraction).toBeCloseTo(
      0.15,
      10,
    );
  });

  it("does not let an open-circuit control reach the diluent", () => {
    // The diluent is not a tank. Nothing on the open-circuit side may touch
    // it, or a mode switch would quietly put the last bottom mix in the loop.
    const configured = applyDiluentPreset(ccr(), 2);
    const edited = adjustOxygenFraction(configured, -0.05);

    expect(edited.tanks[0]?.gas.oxygenFraction).toBeCloseTo(0.16, 10);
    expect(edited.ccr.diluent.oxygenFraction).toBeCloseTo(0.15, 10);
    expect(edited.ccr.diluent.heliumFraction).toBeCloseTo(0.45, 10);
  });
});

describe("immutability", () => {
  it("never mutates the setup it is given", () => {
    const setup = ccr();
    const snapshot = JSON.stringify(setup);

    applyDiluentPreset(setup, 1);
    adjustSetpoint(setup, 0.2);
    adjustDiluentVolume(setup, 2);
    adjustOxygenVolume(setup, 1);
    adjustOxygenPressure(setup, 20);

    expect(JSON.stringify(setup)).toBe(snapshot);
  });
});
