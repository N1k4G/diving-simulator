// The post-dive grade (#199 slice 6b, for #159): legacy's gradeDive() in
// src/physics.js as a pure function of the dive state. Five equally weighted
// sub-scores, each with a note, an overall score and stars. The notes are
// keys with their numbers; the text is the app's (src/app/debrief-grade.ts),
// so this module holds no user-facing strings.
import type { DiveState } from "./dive-state";

/** src/constants.js GRADE_* */
export const GRADE_STAR_1_MIN = 50;
export const GRADE_STAR_2_MIN = 75;
export const GRADE_STAR_3_MIN = 92;
export const GRADE_FAST_ASCENT_PENALTY = 15;
export const GRADE_CEILING_PENALTY = 30;
export const GRADE_SAFETY_SKIPPED_SCORE = 30;
export const GRADE_GAS_RESERVE_FULL_BAR = 50;
export const GRADE_LOW_NDL_HINT_MIN = 3;
export const GRADE_TRIM_HOLD_WINDOW_S = 60;
export const GRADE_TRIM_HOLD_DELTA_M = 1;
export const GRADE_TRIM_STDDEV_FULL_M = 0.5;
export const GRADE_TRIM_STDDEV_ZERO_M = 3;
/** gradeDive()'s fixed gas-reserve score after a dive that hit the reserve third. */
export const GRADE_THIRDS_RESERVE_HIT_SCORE = 40;

export type GradeCategory = "ascent" | "safetyStop" | "gasReserve" | "deco" | "trim";

/** Legacy's gradeNotes keys, with the numbers its templates fill in. */
export type GradeNote =
  | { readonly key: "ascentClean" }
  | { readonly key: "ascentBad"; readonly count: number; readonly peakMpm: number }
  | { readonly key: "safetyDone" }
  | { readonly key: "safetyNotNeeded" }
  | { readonly key: "safetySkipped" }
  | { readonly key: "gasReserveHit" }
  | { readonly key: "gasThirdsClean" }
  | { readonly key: "gasEnd"; readonly bar: number }
  | { readonly key: "decoClean" }
  | { readonly key: "decoNdlClose"; readonly ndlMin: number }
  | { readonly key: "decoBad"; readonly count: number }
  | { readonly key: "trimNoHold" }
  | { readonly key: "trimReport"; readonly stddevM: number };

export interface GradeScore {
  readonly category: GradeCategory;
  /** 0 to 100, rounded as legacy rounds it. */
  readonly score: number;
  readonly note: GradeNote;
}

export interface DiveGrade {
  /** In legacy's order: ascent, safety stop, gas reserve, deco, trim. */
  readonly scores: readonly GradeScore[];
  readonly overall: number;
  readonly stars: 0 | 1 | 2 | 3;
}

export interface GradeContext {
  /**
   * The site has an overhead (legacy's activeSite().hasOverhead): the gas
   * reserve is graded by the rule of thirds instead of the gas left.
   */
  readonly overheadSite: boolean;
}

const clamp = (value: number) => Math.max(0, Math.min(100, value));

export function gradeDive(state: DiveState, context: Readonly<GradeContext>): DiveGrade {
  const entries = state.log.entries;

  // 1. Ascent discipline: points off per fast ascent, the note with the peak.
  const fastAscents = entries.filter((entry) => entry.kind === "fast-ascent");
  const peakMpm = fastAscents.reduce((peak, entry) => (entry.value > peak ? entry.value : peak), 0);
  const ascent: GradeScore = {
    category: "ascent",
    score: Math.round(Math.max(0, 100 - GRADE_FAST_ASCENT_PENALTY * fastAscents.length)),
    note: fastAscents.length === 0
      ? { key: "ascentClean" }
      : { key: "ascentBad", count: fastAscents.length, peakMpm },
  };

  // 2. Safety stop: full marks when done or not needed.
  const { needed, complete } = state.safetyStop;
  const safetyStop: GradeScore = !needed || complete
    ? { category: "safetyStop", score: 100, note: { key: needed ? "safetyDone" : "safetyNotNeeded" } }
    : { category: "safetyStop", score: GRADE_SAFETY_SKIPPED_SCORE, note: { key: "safetySkipped" } };

  // 3. Gas reserve: the rule of thirds in an overhead, else the gas left.
  let gasReserve: GradeScore;
  if (context.overheadSite) {
    gasReserve = state.thirds.reserveHit
      ? { category: "gasReserve", score: GRADE_THIRDS_RESERVE_HIT_SCORE, note: { key: "gasReserveHit" } }
      : { category: "gasReserve", score: 100, note: { key: "gasThirdsClean" } };
  } else {
    // A rebreather dive is graded on its diluent cylinder, bailed out or not;
    // an open-circuit dive on its emptiest cylinder.
    let endBar: number;
    if (state.ccr) {
      endBar = state.ccr.diluentCylinderPressureBar;
    } else {
      endBar = Infinity;
      for (const tank of state.tanks) {
        const tankEndBar = tank.gasRemainingL / tank.volumeL;
        if (tankEndBar < endBar) endBar = tankEndBar;
      }
      if (!Number.isFinite(endBar)) endBar = 0;
    }
    gasReserve = {
      category: "gasReserve",
      score: Math.round(clamp((endBar / GRADE_GAS_RESERVE_FULL_BAR) * 100)),
      note: { key: "gasEnd", bar: endBar },
    };
  }

  // 4. Deco discipline: points off per broken ceiling; a hint when the NDL
  // came close.
  const ceilingViolations = entries.filter((entry) => entry.kind === "ceiling-violation").length;
  const minNdlMin = state.log.minNdlMin;
  const deco: GradeScore = {
    category: "deco",
    score: Math.round(Math.max(0, 100 - GRADE_CEILING_PENALTY * ceilingViolations)),
    note: ceilingViolations > 0
      ? { key: "decoBad", count: ceilingViolations }
      : minNdlMin !== null && minNdlMin < GRADE_LOW_NDL_HINT_MIN
        ? { key: "decoNdlClose", ndlMin: minNdlMin }
        : { key: "decoClean" },
  };

  // 5. Trim: the standard deviation of depth from its rolling 60 s mean,
  // over the samples whose window held within 1 m. Times are compared in
  // minutes, as legacy's profile records them.
  const profile = state.log.profile;
  const windowMin = GRADE_TRIM_HOLD_WINDOW_S / 60;
  let residualSum = 0;
  let residualSumSq = 0;
  let residualCount = 0;
  if (profile.length >= 2) {
    let head = 0;
    for (let k = 0; k < profile.length; k++) {
      const tk = profile[k]!.elapsedTimeS / 60;
      while (head < k && tk - profile[head]!.elapsedTimeS / 60 > windowMin) head++;
      const count = k - head + 1;
      if (count < 2) continue;
      let sum = 0;
      let min = Infinity;
      let max = -Infinity;
      for (let w = head; w <= k; w++) {
        const depth = profile[w]!.depthM;
        sum += depth;
        if (depth < min) min = depth;
        if (depth > max) max = depth;
      }
      if (max - min < GRADE_TRIM_HOLD_DELTA_M) {
        const residual = profile[k]!.depthM - sum / count;
        residualSum += residual;
        residualSumSq += residual * residual;
        residualCount++;
      }
    }
  }
  let trim: GradeScore;
  if (residualCount < 3) {
    trim = { category: "trim", score: 100, note: { key: "trimNoHold" } };
  } else {
    const mean = residualSum / residualCount;
    const variance = Math.max(0, residualSumSq / residualCount - mean * mean);
    const stddevM = Math.sqrt(variance);
    const t = (stddevM - GRADE_TRIM_STDDEV_FULL_M) / (GRADE_TRIM_STDDEV_ZERO_M - GRADE_TRIM_STDDEV_FULL_M);
    trim = { category: "trim", score: Math.round(clamp(100 * (1 - t))), note: { key: "trimReport", stddevM } };
  }

  const scores = [ascent, safetyStop, gasReserve, deco, trim];
  const overall = Math.round(scores.reduce((sum, entry) => sum + entry.score, 0) / scores.length);
  const stars = overall >= GRADE_STAR_3_MIN ? 3 : overall >= GRADE_STAR_2_MIN ? 2 : overall >= GRADE_STAR_1_MIN ? 1 : 0;
  return { scores, overall, stars };
}
