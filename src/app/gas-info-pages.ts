// Which gas-information pages exist for a dive, and the order `I` walks them
// in (#163). Pure, so the rules can be tested without a DOM.
//
// src/state.js keydown handler (WP-037 / BUG-CCR-3):
//
//   if ((e.key === 'i' || e.key === 'I') && gameState === 'diving' &&
//       (isAdvanced() || diveMode === 'ccr')) {
//     if (diveMode === 'ccr') {
//       infoPageMode = (infoPageMode === 5) ? 0 : 5;
//     } else {
//       infoPageMode++;
//       if (infoPageMode === 2 && tankCount <= 3) infoPageMode++;
//       if (infoPageMode > (tankCount > 3 ? 4 : 3)) infoPageMode = 0;
//     }
//   }
//
// with 1 = tanks 1-3, 2 = tanks 4-6, 3 = tissues, 4 = deco metrics,
// 5 = the CCR page, and 0 the normal dive computer (here: the overlay closed,
// null). Escape returns to 0.
import type { PresentationState } from "../presentation/presentation-state";
import type { DiveMode } from "./setup/dive-setup";

export type GasInfoPage =
  | "cylinders-1"
  | "cylinders-2"
  | "tissues"
  | "deco"
  | "loop";

/**
 * Whether `I` means anything on this dive.
 *
 * Legacy's gate is `isAdvanced() || diveMode === 'ccr'`: technical and
 * rebreather dives, never recreational, and only while `gameState ===
 * 'diving'` — a failed dive is legacy's game-over state. The mode is the one
 * the dive was set up with, carried in the save since v3; a first cut counted
 * cylinders instead, and a technical dive starts with one (#185 review).
 */
export function gasInfoAvailable(
  presentation: Readonly<PresentationState>,
  diveMode: DiveMode,
): boolean {
  // "diving" and nothing else: legacy's gate is gameState === 'diving', so
  // neither a failed dive nor one at the surface has the pages (#185 review).
  if (presentation.status !== "diving") {
    return false;
  }
  return diveMode === "tec" || diveMode === "ccr";
}

/**
 * Legacy's colour tiers on the gas-information pages (src/renderer.js,
 * hudColor 'caution' / 'warn' / 'danger'). Only danger carries legacy's ⚠
 * prefix, there and here; the lower tiers are a tint over a value that is
 * already legible as text, plus a hidden word for assistive technology.
 */
export type Severity = "normal" | "caution" | "warning" | "danger";

// src/constants.js PO2_HYPOXIA 0.16, PO2_SAFE 1.0, PO2_ELEVATED 1.4,
// PO2_HIGH 1.6; src/physics.js po2Color().
export function po2Severity(po2Bar: number): Severity {
  if (po2Bar < 0.16 || po2Bar > 1.6) return "danger";
  if (po2Bar > 1.4) return "warning";
  if (po2Bar > 1.0) return "caution";
  return "normal";
}

/** Cylinder page, on the rounded pressure: tkBar > 100 ok, >= 50 caution, else danger. */
export function cylinderSeverity(roundedBar: number): Severity {
  if (roundedBar < 50) return "danger";
  if (roundedBar <= 100) return "caution";
  return "normal";
}

/** Tissue bar: ratio >= 1.0 danger, >= 0.8 caution, else ok. */
export function mValueRatioSeverity(ratio: number): Severity {
  if (ratio >= 1) return "danger";
  if (ratio >= 0.8) return "caution";
  return "normal";
}

/** GF99 and SrfGF: danger at 100 or more, caution at 80 or more. */
export function gradientFactorSeverity(percent: number): Severity {
  if (percent >= 100) return "danger";
  if (percent >= 80) return "caution";
  return "normal";
}

/** NDL: danger under 5 minutes, caution under 15. */
export function ndlSeverity(ndlMin: number): Severity {
  if (ndlMin < 5) return "danger";
  if (ndlMin < 15) return "caution";
  return "normal";
}

/** Scrubber on the loop page, rounded minutes: danger under 10, caution under 30. */
export function scrubberSeverity(roundedMinutes: number): Severity {
  if (roundedMinutes < 10) return "danger";
  if (roundedMinutes < 30) return "caution";
  return "normal";
}

/**
 * The NDL the decompression page shows: none for the 999 "no limit"
 * sentinel, and at most 99 minutes otherwise, as legacy draws
 * `(ndl > 99 ? '99' : ndl) + ' min'` (#185 review).
 */
export function displayedNdlMinutes(ndlMin: number): number | null {
  if (ndlMin >= 999) return null;
  return Math.min(99, ndlMin);
}

/** The pages `I` cycles through on this dive, in order. */
export function gasInfoPages(
  presentation: Readonly<PresentationState>,
  diveMode: DiveMode,
): readonly GasInfoPage[] {
  if (!gasInfoAvailable(presentation, diveMode)) {
    return [];
  }
  if (presentation.ccr !== null) {
    return ["loop"];
  }
  return presentation.tanks.length > 3
    ? ["cylinders-1", "cylinders-2", "tissues", "deco"]
    : ["cylinders-1", "tissues", "deco"];
}

/**
 * The page after `current` — or null, the overlay closed, after the last
 * one. A page the dive no longer has (the dive failed, say) also closes
 * rather than jumping somewhere unexpected.
 */
export function nextGasInfoPage(
  current: GasInfoPage | null,
  presentation: Readonly<PresentationState>,
  diveMode: DiveMode,
): GasInfoPage | null {
  const pages = gasInfoPages(presentation, diveMode);
  if (pages.length === 0) {
    return null;
  }
  if (current === null) {
    return pages[0] ?? null;
  }
  const at = pages.indexOf(current);
  if (at < 0) {
    return null;
  }
  return pages[at + 1] ?? null;
}

/** Whether a page that is open may stay open on this frame. */
export function gasInfoPageStillValid(
  current: GasInfoPage | null,
  presentation: Readonly<PresentationState>,
  diveMode: DiveMode,
): boolean {
  return (
    current !== null && gasInfoPages(presentation, diveMode).includes(current)
  );
}

/** The cylinder indices a cylinders page shows: three per page, as legacy. */
export function cylinderIndicesForPage(
  page: GasInfoPage,
  cylinderCount: number,
): readonly number[] {
  const start = page === "cylinders-1" ? 0 : page === "cylinders-2" ? 3 : -1;
  if (start < 0) {
    return [];
  }
  const indices: number[] = [];
  for (let index = start; index < Math.min(start + 3, cylinderCount); index += 1) {
    indices.push(index);
  }
  return indices;
}
