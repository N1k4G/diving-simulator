// The HUD's one warning, and whether the alarm sounds: legacy's banner
// (src/renderer.js drawDiveComputer, the `highestWarn` chain), its CCR
// overlay and its beep (`hasWarning`), as the migration's chip and alert
// show them. Pure, so the order and the beep are tested without a page.
import { FAST_ASCENT_RATE_MPM } from "../core/dive-model";
import {
  LOW_NDL_WARNING_MIN,
  type PresentationState,
} from "../presentation/presentation-state";
import {
  CCR_PO2_HIGH_WARNING_BAR,
  CCR_PO2_LOW_WARNING_BAR,
  SCRUBBER_LOW_WARNING_S,
  isCcrCylinderLow,
} from "./loop-danger";

// The chip in the topbar and the alert paragraph describe the same state at
// two lengths, so both are derived from one severity rather than chosen
// separately (#138).
export type WarningSeverity =
  | "failure"
  | "scrubberLow"
  | "co2"
  | "ceiling"
  | "oxygen"
  | "narcosis"
  | "fastAscent"
  | "lowGas"
  | "reserve"
  | "lowNdl";

/** Legacy's critical narcosis banner: `narcosisIndex > 0.70`. */
export const NARCOSIS_CRITICAL_INDEX = 0.7;
/** Legacy's caution banner and beep term: `narcosisIndex > 0.20`. */
export const NARCOSIS_CAUTION_INDEX = 0.2;

/**
 * Open circuit: legacy's banner warns above PO2_HIGH; the low bound is the
 * migration's, unchanged here.
 */
const OC_PO2_LOW_WARNING_BAR = 0.16;
const OC_PO2_HIGH_WARNING_BAR = 1.6;
/**
 * Legacy's `tBar < 30` (warnLowGas, critical) and `tBar < 50` (warnReserve,
 * caution, and the beep term). tBar is tankBar(), the active cylinder's
 * gasRemaining / volume: the presentation's pressureBar of the active tank.
 */
export const LOW_GAS_BAR = 30;
export const RESERVE_BAR = 50;

/**
 * Every warning that holds, most urgent first.
 *
 * - The loop's own warnings come first: legacy draws them over the banner
 *   (TASK-032E), in its effective order SCR LOW > CO2! > PO2, the first two
 *   exclusive through scrubberFailed (#182 review).
 * - Then legacy's banner chain: above the ceiling, O₂, narcosis > 0.70,
 *   fast ascent, low gas, reserve, low NDL, narcosis > 0.20 (#228). The
 *   open-circuit oxygen warning is the banner's warnO2, under the ceiling.
 *   Low gas and reserve read the open-circuit cylinder only: on a
 *   rebreather legacy's tBar is tanks[activeTank], a cylinder the loop does
 *   not breathe, and the migration's tanks[0] there is the codec's
 *   placeholder.
 * - Low gas on a rebreather last: either of its own cylinders under
 *   legacy's 30 bar row threshold (#163 review round 2 on PR #182), the
 *   oxygen cylinder only while the loop is breathed. Legacy's banner does
 *   not carry it, so it speaks only when none of the banner's warnings does.
 */
export function activeWarnings(
  presentation: Readonly<PresentationState>,
): WarningSeverity[] {
  const warnings: WarningSeverity[] = [];
  if (presentation.failureReason) {
    warnings.push("failure");
  }
  const { ccr } = presentation;
  const loopBreathed = ccr !== null && !ccr.onBailout;
  if (
    loopBreathed &&
    !ccr.scrubberFailed &&
    ccr.scrubberRemainingS > 0 &&
    ccr.scrubberRemainingS < SCRUBBER_LOW_WARNING_S
  ) {
    warnings.push("scrubberLow");
  }
  if (loopBreathed && ccr.scrubberFailed) {
    warnings.push("co2");
  }
  if (
    loopBreathed &&
    (ccr.actualPo2Bar < CCR_PO2_LOW_WARNING_BAR ||
      ccr.actualPo2Bar > CCR_PO2_HIGH_WARNING_BAR)
  ) {
    warnings.push("oxygen");
  }
  // Legacy's `inDeco && depth < decoStopDepth`: inDeco is decoStopDepth > 0.
  if (
    presentation.decoStopDepthM > 0 &&
    presentation.depthM < presentation.decoStopDepthM
  ) {
    warnings.push("ceiling");
  }
  if (
    !loopBreathed &&
    (presentation.breathingPo2Bar < OC_PO2_LOW_WARNING_BAR ||
      presentation.breathingPo2Bar > OC_PO2_HIGH_WARNING_BAR)
  ) {
    warnings.push("oxygen");
  }
  // After the dive legacy draws no dive computer, so neither its banner nor
  // its beep. The ceiling, the NDL and the ascent rate are already cleared
  // by the presentation then; the index is not, as it only decays slowly.
  const narcosisIndex = presentation.completed ? 0 : presentation.narcosisIndex;
  if (narcosisIndex > NARCOSIS_CRITICAL_INDEX) {
    warnings.push("narcosis");
  }
  if (presentation.ascentRateMpm > FAST_ASCENT_RATE_MPM) {
    warnings.push("fastAscent");
  }
  const activeTank = ccr
    ? undefined
    : presentation.tanks[presentation.activeTankIndex];
  if (activeTank && activeTank.pressureBar < LOW_GAS_BAR) {
    warnings.push("lowGas");
  } else if (activeTank && activeTank.pressureBar < RESERVE_BAR) {
    warnings.push("reserve");
  }
  // Legacy's `!inDeco && ndl > 0 && ndl < 5`; nearNdlMin is null in deco.
  const ndl = presentation.nearNdlMin;
  if (ndl !== null && ndl > 0 && ndl < LOW_NDL_WARNING_MIN) {
    warnings.push("lowNdl");
  }
  if (
    narcosisIndex > NARCOSIS_CAUTION_INDEX &&
    !(narcosisIndex > NARCOSIS_CRITICAL_INDEX)
  ) {
    warnings.push("narcosis");
  }
  if (
    ccr &&
    ((!ccr.onBailout && isCcrCylinderLow(ccr.oxygenCylinderPressureBar)) ||
      isCcrCylinderLow(ccr.diluentCylinderPressureBar))
  ) {
    warnings.push("lowGas");
  }
  return warnings;
}

/**
 * The warning the chip and the alert show. A severity rather than a
 * message, so callers cannot pick one wording for the chip and a different
 * state for the styling.
 */
export function selectWarning(
  presentation: Readonly<PresentationState>,
): WarningSeverity | null {
  return activeWarnings(presentation)[0] ?? null;
}

/** Legacy's `warnCritical`: the danger tone, or the caution tone. */
export type WarningTier = "critical" | "caution";

/**
 * The tier of the warning selectWarning shows, as legacy marks it: the gas
 * reserve and narcosis over 0.20 but not over 0.70 are cautions
 * (`warnCritical = false`, src/renderer.js 8251-8256), and so is the loop's
 * SCR LOW (ccrWarnColor = hudColor('caution'), 8893). Every other banner,
 * the loop's other texts and the migration's own warnings are critical.
 */
export function selectWarningTier(
  presentation: Readonly<PresentationState>,
): WarningTier | null {
  const severity = selectWarning(presentation);
  if (severity === null) {
    return null;
  }
  if (severity === "reserve" || severity === "scrubberLow") {
    return "caution";
  }
  if (severity === "narcosis") {
    return presentation.narcosisIndex > NARCOSIS_CRITICAL_INDEX ? "critical" : "caution";
  }
  return "critical";
}

/**
 * Whether the alarm sounds: legacy's `hasWarning` beeps for every banner
 * term but the low NDL, whichever of them the banner shows, so a low NDL
 * over a narcosis caution still beeps. The warnings legacy's banner does not
 * carry keep sounding as they did (#197, #223).
 */
export function isWarningBeepActive(
  presentation: Readonly<PresentationState>,
): boolean {
  return activeWarnings(presentation).some((warning) => warning !== "lowNdl");
}
