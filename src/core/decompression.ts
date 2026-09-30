// Bühlmann ZHL-16C decompression limits: the ceiling, the no-decompression
// limit and the stop depth (#199). Pure functions of the tissue loads, the
// breathed gas and the gradient factor, so the model can evaluate them every
// frame, as legacy's updateDiving() refreshes frameCalc, and the planner can
// build its forecast on the same arithmetic.
//
// Nothing here imports the model: the caller resolves the breathed gas.
import {
  LN_2,
  WATER_VAPOR_PRESSURE_BAR,
  ZHL16C_HE,
  ZHL16C_N2,
} from "./buhlmann-constants";
import type { GasMix, TissueState } from "./dive-state";
import { metres, minutes, type Metres, type Minutes } from "./units";

const NDL_STEP_MINUTES = 0.5;
const NDL_MAX_STEPS = 400;
/** What calculateNdl reports when no limit is reached: legacy's 999. */
export const NDL_UNLIMITED_MINUTES = minutes(999);

/**
 * The shallowest depth the tissues allow at the gradient factor, 0 when the
 * diver may surface: legacy's calculateCeiling() at GF high.
 */
export function ceilingDepthM(tissues: TissueState, gradientFactor: number): Metres {
  assertTissueShape(tissues);
  let maximumAmbientBar = 0;

  for (let index = 0; index < ZHL16C_N2.length; index += 1) {
    const totalLoadBar =
      (tissues.nitrogenBar[index] ?? 0) +
      (tissues.heliumBar[index] ?? 0);
    const coefficients = combinedCoefficients(
      tissues.nitrogenBar,
      tissues.heliumBar,
      index,
    );
    const ambientBar =
      (totalLoadBar - coefficients.a * gradientFactor) /
      (gradientFactor / coefficients.b + 1 - gradientFactor);
    maximumAmbientBar = Math.max(maximumAmbientBar, ambientBar);
  }

  return metres(Math.max(0, (maximumAmbientBar - 1) * 10));
}

/**
 * Whole minutes the diver can stay at the depth, breathing the gas, before a
 * compartment passes its surfacing limit at the gradient factor: legacy's
 * calculateNDL(), in 0.5 min steps, 999 when none is reached in 200 min.
 */
export function ndlMinutes(
  tissues: TissueState,
  depthM: Metres | number,
  gas: GasMix,
  gradientFactor: number,
): Minutes {
  const nitrogenBar = [...tissues.nitrogenBar];
  const heliumBar = [...tissues.heliumBar];
  const ambientBar = 1 + depthM / 10;
  const inspiredN2Bar =
    (ambientBar - WATER_VAPOR_PRESSURE_BAR) * gas.nitrogenFraction;
  const inspiredHeBar =
    (ambientBar - WATER_VAPOR_PRESSURE_BAR) * gas.heliumFraction;
  let totalMinutes = 0;

  for (let step = 0; step < NDL_MAX_STEPS; step += 1) {
    updateTissueArrays(
      nitrogenBar,
      heliumBar,
      inspiredN2Bar,
      inspiredHeBar,
      NDL_STEP_MINUTES,
    );
    totalMinutes += NDL_STEP_MINUTES;

    for (let index = 0; index < ZHL16C_N2.length; index += 1) {
      const coefficients = combinedCoefficients(
        nitrogenBar,
        heliumBar,
        index,
      );
      const surfaceMValueBar = coefficients.a + 1 / coefficients.b;
      const allowedBar = gradientFactor * (surfaceMValueBar - 1) + 1;
      const totalLoadBar =
        (nitrogenBar[index] ?? 0) + (heliumBar[index] ?? 0);

      if (totalLoadBar > allowedBar) {
        return minutes(Math.floor(totalMinutes));
      }
    }
  }

  return NDL_UNLIMITED_MINUTES;
}

/** The first stop for a ceiling, rounded up to 3 m: legacy's decoStop(). */
export function decoStopDepth(ceilingM: Metres | number): Metres {
  return ceilingM <= 0 ? metres(0) : metres(Math.ceil(ceilingM / 3) * 3);
}

/** One Haldane step of every compartment at constant inspired pressures. */
export function updateTissueArrays(
  nitrogenBar: number[],
  heliumBar: number[],
  inspiredN2Bar: number,
  inspiredHeBar: number,
  elapsedMinutes: number,
): void {
  for (let index = 0; index < ZHL16C_N2.length; index += 1) {
    const n2 = nitrogenBar[index];
    const he = heliumBar[index];
    const n2Compartment = ZHL16C_N2[index];
    const heCompartment = ZHL16C_HE[index];
    if (
      n2 === undefined ||
      he === undefined ||
      !n2Compartment ||
      !heCompartment
    ) {
      throw new RangeError("decompression requires all 16 tissue compartments");
    }
    nitrogenBar[index] =
      inspiredN2Bar +
      (n2 - inspiredN2Bar) *
        Math.exp(-(LN_2 / n2Compartment.halfTimeMin) * elapsedMinutes);
    heliumBar[index] =
      inspiredHeBar +
      (he - inspiredHeBar) *
        Math.exp(-(LN_2 / heCompartment.halfTimeMin) * elapsedMinutes);
  }
}

/** A compartment's a and b for its nitrogen and helium mix. */
export function combinedCoefficients(
  nitrogenBar: readonly number[],
  heliumBar: readonly number[],
  index: number,
): { a: number; b: number } {
  const n2 = nitrogenBar[index] ?? 0;
  const he = heliumBar[index] ?? 0;
  const n2Compartment = ZHL16C_N2[index];
  const heCompartment = ZHL16C_HE[index];
  if (!n2Compartment || !heCompartment) {
    throw new RangeError("decompression requires all 16 tissue compartments");
  }
  const total = n2 + he;
  if (total < 0.0001) {
    return { a: n2Compartment.a, b: n2Compartment.b };
  }
  return {
    a: (n2Compartment.a * n2 + heCompartment.a * he) / total,
    b: (n2Compartment.b * n2 + heCompartment.b * he) / total,
  };
}

export function assertTissueShape(tissues: TissueState): void {
  if (
    tissues.nitrogenBar.length !== ZHL16C_N2.length ||
    tissues.heliumBar.length !== ZHL16C_HE.length
  ) {
    throw new RangeError("decompression requires all 16 tissue compartments");
  }
}
