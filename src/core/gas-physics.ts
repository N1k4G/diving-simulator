// The small gas arithmetic legacy's physics.js keeps beside the model and its
// instructor panel (#46) reads every frame (#160): the ambient pressure, the
// gas legacy calls active, the gas narcosis is reckoned on, the END and the
// MOD at 1.4 bar. Pure functions of the dive state.
import { breathingSourceForState, resolveInspiredGas } from "./dive-model";
import type { DiveState, GasMix } from "./dive-state";

/** src/physics.js ambientPressure(): `1 + depth / 10` bar. */
export function ambientPressureBar(depthM: number): number {
  return 1 + depthM / 10;
}

/**
 * src/state.js activeGas(): the diluent once bailed out, otherwise the active
 * cylinder, also on the loop, where legacy keeps `tanks[0]` as this client
 * does (toInitialDiveOptions).
 */
export function activeGas(state: DiveState): GasMix {
  if (state.ccr?.onBailout) {
    return state.ccr.diluent;
  }
  const tank = state.tanks[state.activeTankIndex];
  if (!tank) {
    throw new RangeError("active tank index is outside the tank list");
  }
  return tank.gas;
}

/**
 * src/physics.js narcosisGas(): the loop's inspired gas at its actual PO2 on a
 * rebreather, the breathed gas otherwise. The model's narcosis reads the same.
 */
export function narcosisGas(state: DiveState): GasMix {
  return resolveInspiredGas(breathingSourceForState(state), state.depthM);
}

/** src/physics.js calculateEND(): `max(0, (depth + 10) * (1 - fHe) - 10)`. */
export function equivalentNarcoticDepthM(state: DiveState): number {
  return Math.max(0, (state.depthM + 10) * (1 - narcosisGas(state).heliumFraction) - 10);
}

/** The PO2 legacy's calculateMOD() reckons with, 1.4 bar. */
export const INSTRUCTOR_MOD_PO2_BAR = 1.4;

/**
 * src/physics.js calculateMOD(): `((1.4 / fO2) - 1) * 10`, unrounded. Null for
 * a mix without oxygen, which never reaches the limit (legacy's #61 case,
 * where it divides by zero).
 */
export function modAtInstructorPo2M(oxygenFraction: number): number | null {
  return oxygenFraction > 0 ? (INSTRUCTOR_MOD_PO2_BAR / oxygenFraction - 1) * 10 : null;
}
