// The closed-circuit half of the pre-dive configuration: the diluent, the loop
// setpoint and the two cylinders.
//
// Same rule as tec-controls.ts — every bound is read out of the legacy client
// and names the function it came from. A number here without a cited source is
// a bug, not a specification; #158's first slice invented two bounds and the
// tests wrote the invention down as the contract.
//
// Kept apart from dive-setup.ts because that file is the open-circuit surface
// and this is the part no open-circuit mode shows. The dependency runs one
// way, as it does for tec-controls.
import {
  CCR_SETPOINT_MAX_BAR,
  CCR_SETPOINT_MIN_BAR,
  CCR_SETPOINT_STEP_BAR,
  createGasMix,
} from "../../core/dive-state";
import type { CcrSetup, DiveSetup, GasPreset } from "./dive-setup";

/**
 * src/state.js CCR_DIL_PRESETS, in order, because the legacy screen binds them
 * to keys 1-5 by index.
 *
 * These are not GAS_PRESETS: three of the five mixes appear nowhere in the
 * open-circuit list, and the two that share a name are at different indices.
 * Reusing that list would have bound key 3 to EAN32 as a diluent.
 */
export const CCR_DILUENT_PRESETS: readonly GasPreset[] = Object.freeze([
  Object.freeze({ id: "air", oxygenFraction: 0.21, heliumFraction: 0 }),
  Object.freeze({ id: "tx21-35", oxygenFraction: 0.21, heliumFraction: 0.35 }),
  Object.freeze({ id: "tx15-45", oxygenFraction: 0.15, heliumFraction: 0.45 }),
  Object.freeze({ id: "tx10-70", oxygenFraction: 0.1, heliumFraction: 0.7 }),
  Object.freeze({ id: "hx10-90", oxygenFraction: 0.1, heliumFraction: 0.9 }),
]);

// src/constants.js: CCR_SP_MIN 0.5, CCR_SP_MAX 1.6, CCR_SP_STEP 0.1 — held in
// the core since #163, because the in-dive adjustment is a model operation
// and the same three numbers must bound both; CCR_DIL_VOL_MIN 2,
// CCR_DIL_VOL_MAX 12; CCR_O2_VOL_MIN 2, CCR_O2_VOL_MAX 5; CCR_O2_PRES_MIN 50,
// CCR_O2_PRES_MAX 300, CCR_O2_PRES_STEP 10.
export const SETPOINT_RANGE_BAR = Object.freeze({
  min: CCR_SETPOINT_MIN_BAR,
  max: CCR_SETPOINT_MAX_BAR,
});
export const SETPOINT_STEP_BAR = CCR_SETPOINT_STEP_BAR;
export const DILUENT_VOLUME_RANGE_L = Object.freeze({ min: 2, max: 12 });
export const OXYGEN_VOLUME_RANGE_L = Object.freeze({ min: 2, max: 5 });
export const CCR_VOLUME_STEP_L = 1;
export const OXYGEN_PRESSURE_RANGE_BAR = Object.freeze({ min: 50, max: 300 });
export const CCR_PRESSURE_STEP_BAR = 10;

/**
 * src/state.js ccrApplyDilPreset: sets the three diluent fractions and nothing
 * else. Out-of-range indices are refused rather than clamped, as the
 * open-circuit presets are — a silent neighbouring mix is worse than nothing
 * happening, and more so for a diluent, where the neighbour can be hypoxic.
 */
export function applyDiluentPreset(setup: DiveSetup, index: number): DiveSetup {
  if (!Number.isInteger(index)) return setup;
  const preset = CCR_DILUENT_PRESETS[index];
  if (!preset) return setup;

  return withCcr(setup, {
    ...setup.ccr,
    diluent: createGasMix(preset.oxygenFraction, preset.heliumFraction),
  });
}

/**
 * src/state.js ccrAdjustSP:
 * `Math.max(CCR_SP_MIN, Math.min(CCR_SP_MAX, +(targetSP + delta).toFixed(1)))`.
 * The toFixed(1) is there because 0.7 + 0.1 is not 0.8 in binary floating
 * point; snapping in whole steps below does the same job without the string
 * round trip.
 */
export function adjustSetpoint(setup: DiveSetup, deltaBar: number): DiveSetup {
  const next = clampToStep(
    setup.ccr.setpointBar + deltaBar,
    SETPOINT_RANGE_BAR.min,
    SETPOINT_RANGE_BAR.max,
    SETPOINT_STEP_BAR,
  );
  return next === setup.ccr.setpointBar
    ? setup
    : withCcr(setup, { ...setup.ccr, setpointBar: next });
}

/** src/state.js ccrAdjustDilVol: clamped to CCR_DIL_VOL_MIN/MAX. */
export function adjustDiluentVolume(setup: DiveSetup, deltaL: number): DiveSetup {
  const next = clampToStep(
    setup.ccr.diluentCylinderVolumeL + deltaL,
    DILUENT_VOLUME_RANGE_L.min,
    DILUENT_VOLUME_RANGE_L.max,
    CCR_VOLUME_STEP_L,
  );
  return next === setup.ccr.diluentCylinderVolumeL
    ? setup
    : withCcr(setup, { ...setup.ccr, diluentCylinderVolumeL: next });
}

/** src/state.js ccrAdjustO2Vol, the BUG-CCR-4 fix: clamped to 2-5 L. */
export function adjustOxygenVolume(setup: DiveSetup, deltaL: number): DiveSetup {
  const next = clampToStep(
    setup.ccr.oxygenCylinderVolumeL + deltaL,
    OXYGEN_VOLUME_RANGE_L.min,
    OXYGEN_VOLUME_RANGE_L.max,
    CCR_VOLUME_STEP_L,
  );
  return next === setup.ccr.oxygenCylinderVolumeL
    ? setup
    : withCcr(setup, { ...setup.ccr, oxygenCylinderVolumeL: next });
}

/** src/state.js ccrAdjustO2Pres: clamped to 50-300 bar in steps of 10. */
export function adjustOxygenPressure(
  setup: DiveSetup,
  deltaBar: number,
): DiveSetup {
  const next = clampToStep(
    setup.ccr.oxygenCylinderPressureBar + deltaBar,
    OXYGEN_PRESSURE_RANGE_BAR.min,
    OXYGEN_PRESSURE_RANGE_BAR.max,
    CCR_PRESSURE_STEP_BAR,
  );
  return next === setup.ccr.oxygenCylinderPressureBar
    ? setup
    : withCcr(setup, { ...setup.ccr, oxygenCylinderPressureBar: next });
}

/**
 * Which preset the current diluent is, or null for a mix that is none of them.
 *
 * src/state.js ccrDilPresetName matches with a 0.005 tolerance and falls back
 * to the string 'Custom'. Returning null instead keeps the catalogue as the
 * only place a user-facing word is written.
 */
export function matchingDiluentPreset(ccr: CcrSetup): GasPreset | null {
  return (
    CCR_DILUENT_PRESETS.find(
      (preset) =>
        Math.abs(ccr.diluent.oxygenFraction - preset.oxygenFraction) < 0.005 &&
        Math.abs(ccr.diluent.heliumFraction - preset.heliumFraction) < 0.005,
    ) ?? null
  );
}

function withCcr(setup: DiveSetup, ccr: CcrSetup): DiveSetup {
  return Object.freeze({ ...setup, ccr: Object.freeze(ccr) });
}

// Same grid-snapping rationale as dive-setup.ts and tec-controls.ts: round in
// step units so repeated nudges from an off-grid value converge instead of
// carrying the offset forever. It matters more here than elsewhere, because
// the setpoint step is 0.1 and binary floating point cannot represent it.
function clampToStep(
  value: number,
  min: number,
  max: number,
  step: number,
): number {
  const snapped = Math.round(value / step) * step;
  const bounded = Math.min(max, Math.max(min, snapped));
  return Math.round(bounded / step) * step;
}
