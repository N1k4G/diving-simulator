// The technical-mode half of the pre-dive configuration: helium, gradient
// factors, consumption, tank size, and the multi-tank list.
//
// Every bound here is read out of the legacy client rather than chosen, and
// each one names the function it came from. #158's first slice invented two of
// them and the unit tests wrote the invention down as the contract, so the
// convention now is that a number without a cited source does not go in.
//
// Kept beside dive-setup.ts rather than inside it because that file is already
// the rec surface; this is the part the rec screen never shows.
import { createGasMix } from "../../core/dive-state";
import {
  AIR_PRESET,
  MAX_TANKS,
  type DiveSetup,
  type SetupTank,
} from "./dive-setup";

// src/constants.js. TANK_VOL_MIN/MAX 6/24, AMV_MIN/MAX 8/25,
// GF_LOW_MIN/MAX and GF_HIGH_MIN/MAX all 30/100.
export const HELIUM_FRACTION_STEP = 0.01;
export const AMV_RANGE_LPM = Object.freeze({ min: 8, max: 25 });
export const AMV_STEP_LPM = 1;
export const TANK_VOLUME_RANGE_L = Object.freeze({ min: 6, max: 24 });
export const TANK_VOLUME_STEP_L = 1;
export const GRADIENT_FACTOR_RANGE = Object.freeze({ min: 30, max: 100 });
export const GRADIENT_FACTOR_STEP = 5;

/**
 * The size a new cylinder gets.
 *
 * Legacy `gsAddTank` calls `createTank(0.21, 0, 200)`, and `createTank` reads
 * the module-level `tankVolume` (src/constants.js, 12). Crucially
 * `gsAdjustTankVol` writes `t.volume` and never `tankVolume`, so resizing the
 * selected cylinder does NOT change what the next one is created at — set
 * tank 1 to 15 L in the legacy screen and tank 2 still arrives at 12.
 *
 * An earlier revision inherited the selected tank's size here and asserted it
 * in a test, which is the second time in this issue that a deviation was
 * written down as the contract.
 */
export const NEW_TANK_VOLUME_L = 12;

/**
 * Helium on the selected tank.
 *
 * src/state.js gsAdjustHe: `Math.min(1.0 - t.fO2, ...)` up,
 * `Math.max(0, ...)` down — so oxygen is the ceiling and it is never moved to
 * make room.
 */
export function adjustHeliumFraction(
  setup: DiveSetup,
  deltaFraction: number,
): DiveSetup {
  const tank = selectedTank(setup);
  const next = clampToStep(
    tank.gas.heliumFraction + deltaFraction,
    0,
    1 - tank.gas.oxygenFraction,
    HELIUM_FRACTION_STEP,
  );
  if (next === tank.gas.heliumFraction) return setup;

  return withTank(setup, {
    ...tank,
    gas: createGasMix(tank.gas.oxygenFraction, next),
  });
}

/**
 * src/state.js gsAdjustAMV: `Math.max(AMV_MIN, Math.min(AMV_MAX, ...))`.
 * Consumption is per-dive, not per-tank.
 */
export function adjustSurfaceAirConsumption(
  setup: DiveSetup,
  deltaLpm: number,
): DiveSetup {
  const next = clampToStep(
    setup.surfaceAirConsumptionLpm + deltaLpm,
    AMV_RANGE_LPM.min,
    AMV_RANGE_LPM.max,
    AMV_STEP_LPM,
  );
  return next === setup.surfaceAirConsumptionLpm
    ? setup
    : Object.freeze({ ...setup, surfaceAirConsumptionLpm: next });
}

/**
 * src/state.js gsAdjustTankVol: clamps to TANK_VOL_MIN/MAX and recomputes the
 * gas the cylinder holds. Applies to the selected tank, as the legacy screen
 * does — `t = tanks[selectedTankTab]`.
 */
export function adjustTankVolume(setup: DiveSetup, deltaL: number): DiveSetup {
  const tank = selectedTank(setup);
  const next = clampToStep(
    tank.volumeL + deltaL,
    TANK_VOLUME_RANGE_L.min,
    TANK_VOLUME_RANGE_L.max,
    TANK_VOLUME_STEP_L,
  );
  return next === tank.volumeL ? setup : withTank(setup, { ...tank, volumeL: next });
}

/**
 * src/state.js gsAdjustGFLow: clamp to 30-100, then `if (gfLow > gfHigh)
 * gfLow = gfHigh`. The second step matters — the pair cannot cross, and low
 * yields to high rather than pushing it.
 */
export function adjustGradientFactorLow(
  setup: DiveSetup,
  deltaPercent: number,
): DiveSetup {
  const clamped = clampToStep(
    setup.gradientFactorLow + deltaPercent,
    GRADIENT_FACTOR_RANGE.min,
    GRADIENT_FACTOR_RANGE.max,
    GRADIENT_FACTOR_STEP,
  );
  const next = Math.min(clamped, setup.gradientFactorHigh);
  return next === setup.gradientFactorLow
    ? setup
    : Object.freeze({ ...setup, gradientFactorLow: next });
}

/**
 * src/state.js gsAdjustGFHigh: clamp to 30-100, then `if (gfHigh < gfLow)
 * gfHigh = gfLow`.
 */
export function adjustGradientFactorHigh(
  setup: DiveSetup,
  deltaPercent: number,
): DiveSetup {
  const clamped = clampToStep(
    setup.gradientFactorHigh + deltaPercent,
    GRADIENT_FACTOR_RANGE.min,
    GRADIENT_FACTOR_RANGE.max,
    GRADIENT_FACTOR_STEP,
  );
  const next = Math.max(clamped, setup.gradientFactorLow);
  return next === setup.gradientFactorHigh
    ? setup
    : Object.freeze({ ...setup, gradientFactorHigh: next });
}

/**
 * src/state.js gsAddTank: refuses past MAX_TANKS and appends air at 200 bar,
 * `createTank(0.21, 0.0, 200)`, taking its volume from the current tankVolume.
 * The new tank's switch depth is a legacy planner field the pure model does
 * not carry, so it is not reproduced here — noted rather than silently
 * dropped.
 */
export function addTank(setup: DiveSetup): DiveSetup {
  if (setup.tanks.length >= MAX_TANKS) return setup;

  const tank: SetupTank = Object.freeze({
    gas: createGasMix(AIR_PRESET.oxygenFraction, AIR_PRESET.heliumFraction),
    volumeL: NEW_TANK_VOLUME_L,
    pressureBar: 200,
  });
  return Object.freeze({
    ...setup,
    tanks: Object.freeze([...setup.tanks, tank]),
    // Legacy leaves the tab where it was; only removal moves it.
    selectedTabIndex: setup.selectedTabIndex,
  });
}

/**
 * src/state.js gsRemoveTank: refuses below one tank, pops the last, and pulls
 * the tab and the active index back inside the list.
 */
export function removeTank(setup: DiveSetup): DiveSetup {
  if (setup.tanks.length <= 1) return setup;

  const tanks = Object.freeze(setup.tanks.slice(0, -1));
  const lastIndex = tanks.length - 1;
  return Object.freeze({
    ...setup,
    tanks,
    selectedTabIndex: Math.min(setup.selectedTabIndex, lastIndex),
    activeTankIndex: Math.min(setup.activeTankIndex, lastIndex),
  });
}

/**
 * src/game-loop.js exposes `selectedTankTab` with
 * `Math.max(0, Math.min(tankCount - 1, v | 0))`. Out-of-range values clamp
 * rather than wrap, matching that setter. Legacy also cycled the tab with
 * TAB; this screen leaves TAB to the browser, so the visible tank buttons are
 * the only way in and no cycle helper is needed.
 */
export function selectTankTab(setup: DiveSetup, index: number): DiveSetup {
  const next = Math.max(0, Math.min(setup.tanks.length - 1, Math.trunc(index)));
  return next === setup.selectedTabIndex
    ? setup
    : Object.freeze({ ...setup, selectedTabIndex: next });
}

function selectedTank(setup: DiveSetup): SetupTank {
  const tank = setup.tanks[setup.selectedTabIndex];
  if (!tank) throw new RangeError("selected tank tab is outside the tank list");
  return tank;
}

function withTank(setup: DiveSetup, tank: SetupTank): DiveSetup {
  return Object.freeze({
    ...setup,
    tanks: Object.freeze(
      setup.tanks.map((existing, at) =>
        at === setup.selectedTabIndex ? Object.freeze(tank) : existing,
      ),
    ),
  });
}

// Same grid-snapping rationale as dive-setup.ts: round in step units so
// repeated nudges from an off-grid value converge instead of carrying the
// offset forever.
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
