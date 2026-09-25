// The rebreather's warning thresholds, shared by the HUD rows and alert in
// wreck-app.ts and the gas-information page in gas-info.ts (#163), so the two
// cannot mark the same reading differently.
import type { PresentationState } from "../presentation/presentation-state";

// src/renderer.js TASK-032E, the CCR warning banner: LOW PO2 below 0.18 bar,
// HIGH PO2 above 1.5, CO2! once the scrubber has failed, SCR LOW under ten
// minutes. Tighter than the model's failure thresholds (0.16 / 1.6) on
// purpose — a warning that fires at the failure line is not a warning.
export const CCR_PO2_LOW_WARNING_BAR = 0.18;
export const CCR_PO2_HIGH_WARNING_BAR = 1.5;
export const SCRUBBER_LOW_WARNING_S = 10 * 60;
// src/renderer.js drawDiveComputer, CCR branch: the PO2 row turns danger
// above 1.6 (the banner already warns from 1.5), and each cylinder row
// under 30 bar.
export const CCR_PO2_ROW_DANGER_HIGH_BAR = 1.6;
export const CCR_CYLINDER_LOW_BAR = 30;

export interface LoopRowDanger {
  readonly loopPo2: boolean;
  readonly oxygenCylinder: boolean;
  readonly diluentCylinder: boolean;
  readonly scrubber: boolean;
}

/**
 * Which loop rows legacy marks as danger, by its own row thresholds, which
 * are not the banner's: PO2 outside 0.18..1.6 (the banner warns from 1.5),
 * either cylinder under 30 bar and the scrubber under 10 minutes, the last
 * three on the rounded value legacy displays.
 */
export function selectLoopRowDanger(
  ccr: NonNullable<PresentationState["ccr"]>,
): LoopRowDanger {
  return {
    loopPo2:
      ccr.actualPo2Bar < CCR_PO2_LOW_WARNING_BAR ||
      ccr.actualPo2Bar > CCR_PO2_ROW_DANGER_HIGH_BAR,
    oxygenCylinder: isCcrCylinderLow(ccr.oxygenCylinderPressureBar),
    diluentCylinder: isCcrCylinderLow(ccr.diluentCylinderPressureBar),
    scrubber: Math.round(ccr.scrubberRemainingS / 60) < 10,
  };
}

// src/renderer.js: `var o2Bar = Math.round(ccrState.o2CylPressure);
// o2IsDangerCCR = o2Bar < 30`, and the same for the diluent.
export function isCcrCylinderLow(pressureBar: number): boolean {
  return Math.round(pressureBar) < CCR_CYLINDER_LOW_BAR;
}
