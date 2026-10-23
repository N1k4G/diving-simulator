// The values of legacy's instructor panel (#46, src/renderer.js
// drawInstructorOverlay), a window onto the physics the model already keeps
// (#160). Read from the dive state and the core's own functions; nothing here
// runs the NDL, the ceiling or the decompression schedule.
//
// Legacy's third row, the expansion of the newest exhaled bubble, needs
// bubbles the model emits and tracks. This client's are drawn by the renderer
// alone, so the row waits for them (#162; docs/decisions.md).
import { BUOYANCY_PARAMS } from "../core/buoyancy";
import { ZHL16C_N2 } from "../core/buhlmann-constants";
import type { DiveState } from "../core/dive-state";
import {
  activeGas,
  ambientPressureBar,
  equivalentNarcoticDepthM,
  modAtInstructorPo2M,
} from "../core/gas-physics";
import { compartmentSaturation } from "../planner/dive-planner";

/** Legacy's INSTRUCTOR_TISSUE_MIN_LOAD: a compartment at about 0 bar is skipped. */
const TISSUE_MIN_LOAD_BAR = 0.001;
/** Legacy's INSTRUCTOR_TISSUE_WARN_PCT and INSTRUCTOR_TISSUE_CRIT_PCT. */
export const TISSUE_CAUTION_PERCENT = 80;
export const TISSUE_DANGER_PERCENT = 100;

export interface InstructorLeadingTissue {
  /** 1 to 16, as legacy labels it (`#` + index + 1). */
  readonly compartment: number;
  /** Its nitrogen half-time, as legacy shows it with helium aboard too. */
  readonly halfTimeMin: number;
  /** Its load as a share of the M-value at the surface, rounded, at least 0. */
  readonly percent: number;
  readonly severity: "normal" | "caution" | "danger";
}

export interface InstructorPhysics {
  /** P = 1 + depth / 10. */
  readonly ambientPressureBar: number;
  /** The BCD's gas in surface litres, the model's own, and at depth, / P. */
  readonly bcdSurfaceLitres: number;
  readonly bcdEffectiveLitres: number;
  /** Both as shares of legacy's bar, bcdMaxCapacity, within 0 to 1. */
  readonly bcdSurfaceShare: number;
  readonly bcdEffectiveShare: number;
  /** Null while no compartment is past legacy's -1 %: "still washing in". */
  readonly leadingTissue: InstructorLeadingTissue | null;
  /** AMV × P, in surface litres a minute. */
  readonly consumptionLpm: number;
  /** MOD at 1.4 bar of legacy's active gas, rounded; null for 0 % O2. */
  readonly modM: number | null;
  /** Legacy's warn tone: `depth >= mod`, on the unrounded MOD. */
  readonly beyondMod: boolean;
  readonly endM: number;
  /** Legacy's narcosis index as a whole percent. */
  readonly narcosisPercent: number;
}

const share = (litres: number) => Math.max(0, Math.min(1, litres / BUOYANCY_PARAMS.bcdMaxCapacity));

export function selectInstructorPhysics(state: DiveState): InstructorPhysics {
  const pressureBar = ambientPressureBar(state.depthM);
  const bcdSurfaceLitres = state.bcdGasSurfaceLiters;
  const bcdEffectiveLitres = pressureBar > 0 ? bcdSurfaceLitres / pressureBar : 0;
  const mod = modAtInstructorPo2M(activeGas(state).oxygenFraction);
  return Object.freeze({
    ambientPressureBar: pressureBar,
    bcdSurfaceLitres,
    bcdEffectiveLitres,
    bcdSurfaceShare: share(bcdSurfaceLitres),
    bcdEffectiveShare: share(bcdEffectiveLitres),
    leadingTissue: selectLeadingTissue(state),
    consumptionLpm: state.surfaceAirConsumptionLpm * pressureBar,
    modM: mod === null ? null : Math.round(mod),
    beyondMod: mod !== null && state.depthM >= mod,
    endM: Math.round(equivalentNarcoticDepthM(state)),
    narcosisPercent: Math.round(state.narcosisIndex * 100),
  });
}

/**
 * Legacy's _instructorLeadingTissue(): the compartment with the highest load
 * as a share of its M-value at 1 bar, the first of equals, over those loaded
 * past 0.001 bar. Its running best starts at -1 %, so a dive whose every
 * compartment is further below the surface's ambient pressure, as at the
 * start, has none. The share is the gas-information page's SrfGF arithmetic
 * (compartmentSaturation at 1 bar).
 */
export function selectLeadingTissue(state: DiveState): InstructorLeadingTissue | null {
  const { nitrogenBar, heliumBar } = state.tissues;
  const saturation = compartmentSaturation(state.tissues, 1);
  let lead = -1;
  let leadPercent = -1;
  saturation.forEach((compartment, index) => {
    const load = (nitrogenBar[index] ?? 0) + (heliumBar[index] ?? 0);
    if (load > TISSUE_MIN_LOAD_BAR && compartment.gradientFactorPercent > leadPercent) {
      lead = index;
      leadPercent = compartment.gradientFactorPercent;
    }
  });
  if (lead < 0) {
    return null;
  }
  return Object.freeze({
    compartment: lead + 1,
    halfTimeMin: ZHL16C_N2[lead]?.halfTimeMin ?? 0,
    percent: Math.max(0, Math.round(leadPercent)),
    severity:
      leadPercent >= TISSUE_DANGER_PERCENT ? "danger" : leadPercent >= TISSUE_CAUTION_PERCENT ? "caution" : "normal",
  });
}
