import {
  createEmptyDiveLog,
  freezeDiveState,
  type DiveLog,
  type DiveLogEntry,
  type DiveProfileSample,
  type CcrState,
  type DiveEvent,
  type DiveFailureReason,
  type DiveState,
  type GasMix,
  type TankState,
} from "../core/dive-state";
import { neutralBcdSurfaceLitres } from "../core/buoyancy";
import { NDL_UNLIMITED_MINUTES, ceilingDepthM } from "../core/decompression";
import {
  CEILING_VIOLATION_TOLERANCE_M,
  CEILING_VIOLATION_WINDOW_S,
  FAILURES_BEFORE_THE_LOG,
  FAST_ASCENT_RATE_MPM,
  FAST_ASCENT_WINDOW_S,
  PROFILE_SAMPLE_INTERVAL_S,
} from "../core/dive-model";
import {
  DEFAULT_GF_HIGH_PERCENT,
  DEFAULT_GF_LOW_PERCENT,
  GRADIENT_FACTOR_PERCENT_RANGE,
} from "../planner/dive-planner";

export const SAVE_GAME_SCHEMA = "diving-simulator/save-game";
// These counters are unrelated despite the overlapping numbers.
// CURRENT_SAVE_GAME_VERSION is the new format's own sequence;
// LEGACY_SAVE_STATE_VERSION is the last version the pre-migration client wrote
// under its own scheme, so the 2 below is not the 2 above.
//
// v2 adds gradientFactors. A v1 save is migrated rather than rejected: it was
// written before the configured factors reached the planner at all, so its
// dive really was planned on the defaults and filling them in is exact, not a
// guess.
//
// v3 adds diveMode (#163). v1 and v2 saves are migrated with the mode read
// off the dive (see inferDiveMode), which is exact for rebreather and
// multi-cylinder dives and reads a single-cylinder technical dive as
// recreational: the best a save that never recorded the mode allows.
//
// v4 adds state.cnsPercent (#186). v1 to v3 saves were written by a client
// that did not track CNS, so they resume at 0: an underestimate of the real
// exposure, and the only value such a save can support. Legacy saves carry
// cnsPercent (since #10) and keep it.
//
// v5 adds state.verticalVelocityMpm and state.bcdGasSurfaceLiters (#192).
// Older saves resume at rest, velocity 0, with the BCD neutral at the saved
// depth (legacy's neutralizeAt), so a resumed dive neither sinks nor rises
// on its own. Legacy saves carry both (verticalVelocity,
// bcdGasSurfaceLiters) and keep them.
//
// v6 changes no field: it marks saves whose motion is live (#192 PR 2). The
// client that wrote v5 still moved the diver at a fixed speed, so a v5 save
// holds the model's untouched defaults, 2 L of BCD gas at any depth, which
// would sink a resumed diver to the floor. v5 saves resume at rest and
// neutral, as older ones do.
//
// v7 adds state.log, the dive log (#199). Older saves never recorded one and
// resume with an empty log: no entries, no NDL seen yet. Legacy saves carry
// diveEvents, minNdlSeen, ndlDroppedBelow5 and ascentRate, and keep them.
//
// v8 adds the average depth's sums, the depth profile, its sampler's timer
// and the last step's ceiling to state.log (#199). A v7 save keeps its log
// and resumes these at zero with an empty profile, as does every older one.
// Legacy saves carry avgDepthAccum, avgDepthSamples and diveProfile, and
// keep them; legacy does not save the sampler's timer or frameCalc, which it
// restores at zero, and so does this.
export const CURRENT_SAVE_GAME_VERSION = 8;
export const SEVENTH_SAVE_GAME_VERSION = 7;
export const SIXTH_SAVE_GAME_VERSION = 6;
export const FIFTH_SAVE_GAME_VERSION = 5;
export const FOURTH_SAVE_GAME_VERSION = 4;
export const THIRD_SAVE_GAME_VERSION = 3;
export const SECOND_SAVE_GAME_VERSION = 2;
export const FIRST_SAVE_GAME_VERSION = 1;
export const LEGACY_SAVE_STATE_VERSION = 2;

const TISSUE_COMPARTMENT_COUNT = 16;
const MAX_RANDOM_STATE = 0xffff_ffff;

/**
 * The decompression configuration a dive was started with.
 *
 * Only the two gradient factors, not the whole PlannerSettings. The other
 * fields there are not the diver's to set: ascentRateMpm is a constant, and
 * safetyStopNeeded and ndlDroppedBelowFiveMinutes are advisory flags derived
 * each forecast. Persisting them would pin a constant against future tuning
 * and restore a stale flag. The legacy client saves exactly these two as well
 * (src/game-loop.js, `gfLow: gfLow, gfHigh: gfHigh`).
 */
export interface SavedGradientFactors {
  readonly lowPercent: number;
  readonly highPercent: number;
}

/**
 * The dive mode chosen on the setup screen, as legacy saves it
 * ("diveMode: diveMode" in src/game-loop.js). Needed after a resume because
 * the mode decides what the diver is offered: legacy's gas information is
 * gated on isAdvanced() or CCR, and a technical dive starts with a single
 * cylinder, so its state alone looks recreational (#185 review).
 */
export type SavedDiveMode = "rec" | "tec" | "ccr";

export interface SaveGame {
  readonly schema: typeof SAVE_GAME_SCHEMA;
  readonly version: typeof CURRENT_SAVE_GAME_VERSION;
  readonly savedAtEpochMs: number;
  readonly state: DiveState;
  /**
   * Without this a dive begun on 50/80 resumed on 35/75: the state came back
   * from the save while the factors came from the setup screen the reload had
   * just rendered. Tissues, gas and time continued; ceiling, NDL and TTS
   * jumped (#158 review).
   */
  readonly gradientFactors: SavedGradientFactors;
  readonly diveMode: SavedDiveMode;
}

export type SaveGameMigration =
  | "legacy-v2"
  | "save-game-v1"
  | "save-game-v2"
  | "save-game-v3"
  | "save-game-v4"
  | "save-game-v5"
  | "save-game-v6"
  | "save-game-v7"
  | null;

/**
 * The mode a dive that never recorded one most likely had: a loop is CCR,
 * more than one cylinder is technical (recreational has exactly one), and a
 * single open-circuit cylinder is recreational.
 */
export function inferDiveMode(state: DiveState): SavedDiveMode {
  if (state.ccr !== null) {
    return "ccr";
  }
  return state.tanks.length > 1 ? "tec" : "rec";
}

/** A known mode that names a loop exactly when the state has one. */
function isConsistentDiveMode(
  candidate: unknown,
  state: DiveState,
): candidate is SavedDiveMode {
  if (candidate !== "rec" && candidate !== "tec" && candidate !== "ccr") {
    return false;
  }
  return (candidate === "ccr") === (state.ccr !== null);
}

export type SaveGameDecodeResult =
  | {
      readonly ok: true;
      readonly saveGame: SaveGame;
      readonly migratedFrom: SaveGameMigration;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "empty"
        | "invalid-json"
        | "invalid-data"
        | "unsupported-version";
    };

export function createSaveGame(
  state: DiveState,
  gradientFactors: SavedGradientFactors,
  savedAtEpochMs = Date.now(),
  diveMode: SavedDiveMode = inferDiveMode(state),
): SaveGame {
  if (!isPositiveFinite(savedAtEpochMs)) {
    throw new RangeError("save timestamp must be a positive finite number");
  }

  const frozenState = freezeDiveState(state);
  if (!isSavedGradientFactors(gradientFactors)) {
    throw new RangeError(
      "gradient factors must be within 30-100 with low no greater than high",
    );
  }
  if (!isDiveState(frozenState, gradientFactors.highPercent)) {
    throw new TypeError("cannot serialize an invalid DiveState");
  }
  if (!isConsistentDiveMode(diveMode, frozenState)) {
    throw new RangeError("dive mode must be ccr exactly when the dive has a loop");
  }

  return Object.freeze({
    schema: SAVE_GAME_SCHEMA,
    version: CURRENT_SAVE_GAME_VERSION,
    savedAtEpochMs,
    state: frozenState,
    gradientFactors: Object.freeze({
      lowPercent: gradientFactors.lowPercent,
      highPercent: gradientFactors.highPercent,
    }),
    diveMode,
  });
}

/** The pair a v1 save is migrated with — see CURRENT_SAVE_GAME_VERSION. */
export const DEFAULT_SAVED_GRADIENT_FACTORS: SavedGradientFactors =
  Object.freeze({
    lowPercent: DEFAULT_GF_LOW_PERCENT,
    highPercent: DEFAULT_GF_HIGH_PERCENT,
  });

export function encodeSaveGame(saveGame: SaveGame): string {
  return JSON.stringify(saveGame);
}

export function decodeSaveGame(raw: string | null): SaveGameDecodeResult {
  if (raw === null || raw.trim() === "") {
    return { ok: false, reason: "empty" };
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid-json" };
  }

  if (!isRecord(candidate)) {
    return { ok: false, reason: "invalid-data" };
  }

  if (candidate.schema === SAVE_GAME_SCHEMA) {
    const isCurrent = candidate.version === CURRENT_SAVE_GAME_VERSION;
    const isSeventh = candidate.version === SEVENTH_SAVE_GAME_VERSION;
    const isSixth = candidate.version === SIXTH_SAVE_GAME_VERSION;
    const isFifth = candidate.version === FIFTH_SAVE_GAME_VERSION;
    const isFourth = candidate.version === FOURTH_SAVE_GAME_VERSION;
    const isThird = candidate.version === THIRD_SAVE_GAME_VERSION;
    const isSecond = candidate.version === SECOND_SAVE_GAME_VERSION;
    const isFirst = candidate.version === FIRST_SAVE_GAME_VERSION;
    if (
      !Number.isInteger(candidate.version) ||
      (!isCurrent &&
        !isSeventh &&
        !isSixth &&
        !isFifth &&
        !isFourth &&
        !isThird &&
        !isSecond &&
        !isFirst)
    ) {
      return { ok: false, reason: "unsupported-version" };
    }
    // A save from before v4 resumes at CNS 0, the value the client that wrote
    // it was tracking (none). Unconditionally: a pre-v4 payload carrying some
    // cnsPercent anyway is not a record of CNS, so it is neither kept nor a
    // reason to reject the save (#188 Codex round 1). A v4 save must carry a
    // valid one, which isDiveState checks.
    // Before v6 the state's vertical motion was not live (none before v5,
    // untouched defaults in v5): resume at rest, BCD neutral at the saved
    // depth. Unconditionally, like the CNS reset.
    // Before v7 there was no dive log: resume with an empty one. A v7 log
    // resumes the fields v8 added at zero, with an empty profile.
    if (!isCurrent && !isSeventh && isRecord(candidate.state)) {
      candidate.state = { ...candidate.state, log: createEmptyDiveLog() };
    }
    if (isSeventh && isRecord(candidate.state) && isRecord(candidate.state.log)) {
      const empty = createEmptyDiveLog();
      candidate.state = {
        ...candidate.state,
        log: {
          ...candidate.state.log,
          depthTimeMS: empty.depthTimeMS,
          submergedS: empty.submergedS,
          profile: empty.profile,
          profileTimerS: empty.profileTimerS,
          lastCeilingM: empty.lastCeilingM,
        },
      };
    }
    if (!isCurrent && !isSeventh && !isSixth && isRecord(candidate.state)) {
      const savedDepth = isNonNegativeFinite(candidate.state.depthM)
        ? (candidate.state.depthM as number)
        : 0;
      candidate.state = {
        ...candidate.state,
        verticalVelocityMpm: 0,
        bcdGasSurfaceLiters: neutralBcdSurfaceLitres(savedDepth),
      };
    }
    if (
      !isCurrent &&
      !isSeventh &&
      !isSixth &&
      !isFifth &&
      !isFourth &&
      isRecord(candidate.state)
    ) {
      candidate.state = { ...candidate.state, cnsPercent: 0 };
    }
    // A v1 payload has no gradientFactors and is filled with the defaults; a
    // v2 payload must carry a valid pair rather than fall back to them, or a
    // corrupted field would silently re-plan the dive on 35/75 — the very
    // failure this version exists to stop. Read before the state, whose log
    // is checked against the GF high.
    if (!isFirst && !isSavedGradientFactors(candidate.gradientFactors)) {
      return { ok: false, reason: "invalid-data" };
    }
    const savedFactors = isFirst
      ? DEFAULT_SAVED_GRADIENT_FACTORS
      : (candidate.gradientFactors as SavedGradientFactors);
    if (
      !isPositiveFinite(candidate.savedAtEpochMs) ||
      !isDiveState(candidate.state, savedFactors.highPercent)
    ) {
      return { ok: false, reason: "invalid-data" };
    }
    // Likewise a v3 to v8 payload must carry a mode consistent with its
    // state; only saves from before the field existed are inferred.
    if (
      (isCurrent || isSeventh || isSixth || isFifth || isFourth || isThird) &&
      !isConsistentDiveMode(candidate.diveMode, candidate.state)
    ) {
      return { ok: false, reason: "invalid-data" };
    }
    const gradientFactors = savedFactors;
    const diveMode =
      isCurrent || isSeventh || isSixth || isFifth || isFourth || isThird
      ? (candidate.diveMode as SavedDiveMode)
      : inferDiveMode(candidate.state);

    return {
      ok: true,
      saveGame: createSaveGame(
        candidate.state,
        gradientFactors,
        candidate.savedAtEpochMs,
        diveMode,
      ),
      migratedFrom: isCurrent
        ? null
        : isSeventh
          ? "save-game-v7"
          : isSixth
          ? "save-game-v6"
          : isFifth
          ? "save-game-v5"
          : isFourth
          ? "save-game-v4"
          : isThird
          ? "save-game-v3"
          : isSecond
            ? "save-game-v2"
            : "save-game-v1",
    };
  }

  if (candidate.saveVersion === LEGACY_SAVE_STATE_VERSION) {
    const migrated = migrateLegacyV2(candidate);
    return migrated
      ? { ok: true, saveGame: migrated, migratedFrom: "legacy-v2" }
      : { ok: false, reason: "invalid-data" };
  }

  if ("version" in candidate || "saveVersion" in candidate) {
    return { ok: false, reason: "unsupported-version" };
  }

  return { ok: false, reason: "invalid-data" };
}

function migrateLegacyV2(candidate: Record<string, unknown>): SaveGame | null {
  if (
    !isPositiveFinite(candidate.savedAt) ||
    !isNonNegativeFinite(candidate.depth) ||
    !isNonNegativeFinite(candidate.maxDepth) ||
    !isNonNegativeFinite(candidate.diveTime) ||
    !isNonNegativeFinite(candidate.amvRate) ||
    !isNonNegativeFinite(candidate.po2ViolationTime) ||
    !isNonNegativeFinite(candidate.hypoxiaTime) ||
    !isNonNegativeFinite(candidate.ccrHypoxiaTime) ||
    !isNonNegativeFinite(candidate.ccrHyperoxiaTime) ||
    !["rec", "tec", "ccr"].includes(candidate.diveMode as string) ||
    !["diving", "surface", "drill"].includes(candidate.gameState as string) ||
    !isTissueArray(candidate.tissues) ||
    !isTissueArray(candidate.tissuesHe) ||
    !Array.isArray(candidate.tanks) ||
    candidate.tanks.length === 0 ||
    !Number.isInteger(candidate.tankCount) ||
    candidate.tankCount !== candidate.tanks.length ||
    !Number.isInteger(candidate.activeTank) ||
    (candidate.activeTank as number) < 0 ||
    (candidate.activeTank as number) >= candidate.tanks.length
  ) {
    return null;
  }

  const tanks = candidate.tanks.map(migrateLegacyTank);
  if (tanks.some((tank) => tank === null)) {
    return null;
  }

  const ccr = candidate.diveMode === "ccr"
    ? migrateLegacyCcr(candidate.ccrState)
    : null;
  if (candidate.diveMode === "ccr" && ccr === null) {
    return null;
  }

  const state: DiveState = {
    elapsedTimeS:
      ((candidate.diveTime as number) * 60) as DiveState["elapsedTimeS"],
    depthM: candidate.depth as DiveState["depthM"],
    maxDepthM: candidate.maxDepth as DiveState["maxDepthM"],
    tissues: {
      nitrogenBar: candidate.tissues as DiveState["tissues"]["nitrogenBar"],
      heliumBar: candidate.tissuesHe as DiveState["tissues"]["heliumBar"],
    },
    randomState: 0,
    tanks: tanks as readonly TankState[],
    activeTankIndex: candidate.activeTank as number,
    surfaceAirConsumptionLpm:
      candidate.amvRate as DiveState["surfaceAirConsumptionLpm"],
    // Legacy saves it since #10 (restoreDiveState reads `state.cnsPercent || 0`).
    cnsPercent: isNonNegativeFinite(candidate.cnsPercent)
      ? (candidate.cnsPercent as number)
      : 0,
    // Legacy saves both since its save-state v2.
    verticalVelocityMpm: Number.isFinite(candidate.verticalVelocity)
      ? (candidate.verticalVelocity as number)
      : 0,
    bcdGasSurfaceLiters: isNonNegativeFinite(candidate.bcdGasSurfaceLiters)
      ? (candidate.bcdGasSurfaceLiters as number)
      : neutralBcdSurfaceLitres(candidate.depth as number),
    ccr,
    failure: {
      reason: null,
      oxygenToxicityS:
        candidate.po2ViolationTime as DiveState["failure"]["oxygenToxicityS"],
      hypoxiaS: candidate.hypoxiaTime as DiveState["failure"]["hypoxiaS"],
      ccrHypoxiaS:
        candidate.ccrHypoxiaTime as DiveState["failure"]["ccrHypoxiaS"],
      ccrHyperoxiaS:
        candidate.ccrHyperoxiaTime as DiveState["failure"]["ccrHyperoxiaS"],
    },
    events: [],
    log: migrateLegacyLog(candidate),
  };

  // The legacy save carries the pair too (src/game-loop.js writes `gfLow` and
  // `gfHigh`, restoreDiveState reads them back), so this migration is lossless
  // rather than a default. Saves written before the field existed, or with a
  // pair outside the bounds, fall back to the defaults instead of failing the
  // whole migration: losing a dive is worse than resuming it on 35/75.
  const gradientFactors = readLegacyGradientFactors(candidate);

  try {
    // The legacy save records its mode, so it is carried over, not inferred.
    return createSaveGame(
      state,
      gradientFactors,
      candidate.savedAt,
      candidate.diveMode as SavedDiveMode,
    );
  } catch {
    return null;
  }
}

function readLegacyGradientFactors(
  candidate: Record<string, unknown>,
): SavedGradientFactors {
  const pair = { lowPercent: candidate.gfLow, highPercent: candidate.gfHigh };
  return isSavedGradientFactors(pair) ? pair : DEFAULT_SAVED_GRADIENT_FACTORS;
}

function isSavedGradientFactors(
  candidate: unknown,
): candidate is SavedGradientFactors {
  if (!isRecord(candidate)) {
    return false;
  }
  const { lowPercent, highPercent } = candidate;
  return (
    isWithinGradientFactorRange(lowPercent) &&
    isWithinGradientFactorRange(highPercent) &&
    (lowPercent as number) <= (highPercent as number)
  );
}

function isWithinGradientFactorRange(candidate: unknown): boolean {
  return (
    typeof candidate === "number" &&
    Number.isFinite(candidate) &&
    candidate >= GRADIENT_FACTOR_PERCENT_RANGE.min &&
    candidate <= GRADIENT_FACTOR_PERCENT_RANGE.max
  );
}

function migrateLegacyTank(candidate: unknown): TankState | null {
  if (
    !isRecord(candidate) ||
    !isGasFractions(candidate.fO2, candidate.fHe, candidate.fN2) ||
    !isPositiveFinite(candidate.volume) ||
    !isNonNegativeFinite(candidate.gasRemaining)
  ) {
    return null;
  }

  return {
    gas: {
      oxygenFraction: candidate.fO2,
      heliumFraction: candidate.fHe,
      nitrogenFraction: candidate.fN2,
    },
    volumeL: candidate.volume,
    gasRemainingL: candidate.gasRemaining,
  } as TankState;
}

function migrateLegacyCcr(candidate: unknown): CcrState | null {
  if (!isRecord(candidate)) {
    return null;
  }

  const numericFields = [
    "targetSP",
    "actualPO2",
    "o2CylVolume",
    "o2CylPressure",
    "dilCylVolume",
    "dilCylPressure",
    "loopVolume",
    "scrubberRemaining",
    "metabolicO2Rate",
    "po2ResponseRate",
    "co2BuildupTime",
  ] as const;
  if (
    numericFields.some((field) => !isNonNegativeFinite(candidate[field])) ||
    !isGasFractions(candidate.dilFO2, candidate.dilFHe, candidate.dilFN2) ||
    typeof candidate.onBailout !== "boolean" ||
    typeof candidate.scrubberFailed !== "boolean"
  ) {
    return null;
  }

  return {
    targetPo2Bar: candidate.targetSP,
    actualPo2Bar: candidate.actualPO2,
    diluent: {
      oxygenFraction: candidate.dilFO2,
      heliumFraction: candidate.dilFHe,
      nitrogenFraction: candidate.dilFN2,
    } as GasMix,
    oxygenCylinderVolumeL: candidate.o2CylVolume,
    oxygenCylinderPressureBar: candidate.o2CylPressure,
    diluentCylinderVolumeL: candidate.dilCylVolume,
    diluentCylinderPressureBar: candidate.dilCylPressure,
    loopVolumeL: candidate.loopVolume,
    scrubberRemainingS: (candidate.scrubberRemaining as number) * 60,
    metabolicOxygenLpm: candidate.metabolicO2Rate,
    po2ResponseBarPerSecond: candidate.po2ResponseRate,
    onBailout: candidate.onBailout,
    scrubberFailed: candidate.scrubberFailed,
    co2BuildupS: candidate.co2BuildupTime,
  } as CcrState;
}

function isDiveState(
  candidate: unknown,
  gradientFactorHighPercent: number,
): candidate is DiveState {
  if (!isRecord(candidate)) {
    return false;
  }

  return (
    isNonNegativeFinite(candidate.elapsedTimeS) &&
    isNonNegativeFinite(candidate.depthM) &&
    isNonNegativeFinite(candidate.maxDepthM) &&
    candidate.maxDepthM >= candidate.depthM &&
    isRecord(candidate.tissues) &&
    isTissueArray(candidate.tissues.nitrogenBar) &&
    isTissueArray(candidate.tissues.heliumBar) &&
    Number.isInteger(candidate.randomState) &&
    (candidate.randomState as number) >= 0 &&
    (candidate.randomState as number) <= MAX_RANDOM_STATE &&
    Array.isArray(candidate.tanks) &&
    candidate.tanks.length > 0 &&
    candidate.tanks.every(isTankState) &&
    Number.isInteger(candidate.activeTankIndex) &&
    (candidate.activeTankIndex as number) >= 0 &&
    (candidate.activeTankIndex as number) < candidate.tanks.length &&
    isNonNegativeFinite(candidate.surfaceAirConsumptionLpm) &&
    isNonNegativeFinite(candidate.cnsPercent) &&
    Number.isFinite(candidate.verticalVelocityMpm) &&
    isNonNegativeFinite(candidate.bcdGasSurfaceLiters) &&
    (candidate.ccr === null || isCcrState(candidate.ccr)) &&
    isFailureState(candidate.failure) &&
    isEventHistory(
      candidate.events,
      (candidate.tanks as unknown[]).length,
      candidate.elapsedTimeS as number,
      (candidate.failure as Record<string, unknown>).reason as
        | DiveFailureReason
        | null,
    ) &&
    isDiveLog(candidate.log, {
      elapsedTimeS: candidate.elapsedTimeS as number,
      depthM: candidate.depthM as number,
      maxDepthM: candidate.maxDepthM as number,
      ceilingM: ceilingDepthM(
        candidate.tissues as unknown as DiveState["tissues"],
        gradientFactorHighPercent / 100,
      ),
      failureReason: (candidate.failure as Record<string, unknown>).reason as
        | DiveFailureReason
        | null,
    })
  );
}

/**
 * A dive log the model could have produced (#201 Codex round 1), not only one
 * of the right shape: entries in order and past their thresholds, each window
 * consistent with its latch (the model latches the moment a window reaches
 * its length), a peak exactly when a fast ascent is under way, a whole-minute
 * NDL, and the below-five latch set whenever the lowest NDL is below five,
 * since the model sets both on the same step.
 */
/**
 * Two sums the model and legacy accumulate differently may disagree by
 * rounding: legacy counts the dive clock in minutes and the average depth's
 * time in seconds.
 */
const SUM_ROUNDING_S = 1e-6;

/**
 * The log's motion record (#199 slice 2b): average-depth sums a dive of this
 * length and depth can reach, profile samples in order within the dive and
 * its deepest point, a sampler timer short of the next sample, and a
 * non-negative last ceiling. The sampler is not required to account for the
 * whole dive: saves from before v8 and legacy saves resume it at zero with
 * the profile they had, as legacy does.
 */
function isMotionRecord(log: Record<string, unknown>, context: DiveLogContext): boolean {
  if (
    !isNonNegativeFinite(log.depthTimeMS) ||
    !isNonNegativeFinite(log.submergedS) ||
    (log.submergedS as number) > context.elapsedTimeS + SUM_ROUNDING_S ||
    (log.depthTimeMS as number) >
      context.maxDepthM * (log.submergedS as number) * (1 + 1e-9) + SUM_ROUNDING_S ||
    !isNonNegativeFinite(log.profileTimerS) ||
    (log.profileTimerS as number) >= PROFILE_SAMPLE_INTERVAL_S ||
    !isNonNegativeFinite(log.lastCeilingM) ||
    !Array.isArray(log.profile)
  ) {
    return false;
  }
  let previousS = 0;
  for (const sample of log.profile as unknown[]) {
    if (
      !isRecord(sample) ||
      !isNonNegativeFinite(sample.elapsedTimeS) ||
      (sample.elapsedTimeS as number) < previousS ||
      (sample.elapsedTimeS as number) > context.elapsedTimeS ||
      !isNonNegativeFinite(sample.depthM) ||
      (sample.depthM as number) > context.maxDepthM ||
      !isNonNegativeFinite(sample.ceilingM)
    ) {
      return false;
    }
    previousS = sample.elapsedTimeS as number;
  }
  return true;
}

/** What a saved log is checked against, from the rest of the saved state. */
interface DiveLogContext {
  readonly elapsedTimeS: number;
  readonly depthM: number;
  readonly maxDepthM: number;
  /** The ceiling the saved tissues give at the save's GF high. */
  readonly ceilingM: number;
  readonly failureReason: DiveFailureReason | null;
}

function isDiveLog(candidate: unknown, context: DiveLogContext): candidate is DiveLog {
  const { elapsedTimeS, failureReason } = context;
  if (
    !isRecord(candidate) ||
    !Array.isArray(candidate.entries) ||
    !Number.isFinite(candidate.ascentRateMpm) ||
    !isNonNegativeFinite(candidate.fastAscentS) ||
    !isNonNegativeFinite(candidate.fastAscentPeakMpm) ||
    typeof candidate.fastAscentLatched !== "boolean" ||
    !isNonNegativeFinite(candidate.ceilingViolationS) ||
    typeof candidate.ceilingViolationLatched !== "boolean" ||
    typeof candidate.ndlDroppedBelowFiveMinutes !== "boolean" ||
    !isMotionRecord(candidate, context)
  ) {
    return false;
  }
  let previousS = 0;
  for (const entry of candidate.entries as unknown[]) {
    if (
      !isRecord(entry) ||
      !isNonNegativeFinite(entry.elapsedTimeS) ||
      (entry.elapsedTimeS as number) < previousS ||
      (entry.elapsedTimeS as number) > elapsedTimeS ||
      !Number.isFinite(entry.value)
    ) {
      return false;
    }
    const value = entry.value as number;
    if (entry.kind === "fast-ascent" ? value <= FAST_ASCENT_RATE_MPM
      : entry.kind === "ceiling-violation" ? value <= CEILING_VIOLATION_TOLERANCE_M
      : true) {
      return false;
    }
    previousS = entry.elapsedTimeS as number;
  }
  const fastAscentS = candidate.fastAscentS as number;
  const peakMpm = candidate.fastAscentPeakMpm as number;
  const underWay = fastAscentS > 0 || candidate.fastAscentLatched;
  // A window stays open only while the step's rate is fast, and its peak
  // includes that rate: the model resets both on the first slower step, as
  // legacy does (#201 pre-review). The step a rebreather failure ends the
  // dive on moves the rate and nothing else, so a failed CCR dive is exempt.
  const rateMpm = candidate.ascentRateMpm as number;
  const rateMovedAlone =
    failureReason !== null && FAILURES_BEFORE_THE_LOG.has(failureReason);
  if (
    underWay &&
    !rateMovedAlone &&
    (rateMpm <= FAST_ASCENT_RATE_MPM || peakMpm < rateMpm)
  ) {
    return false;
  }
  // Likewise a ceiling window is open only while the diver is above the
  // ceiling less the tolerance, which the saved tissues and depth say.
  const ceilingWindowOpen =
    (candidate.ceilingViolationS as number) > 0 ||
    candidate.ceilingViolationLatched === true;
  if (
    ceilingWindowOpen &&
    !rateMovedAlone &&
    !(
      context.ceilingM > 0 &&
      context.depthM < context.ceilingM - CEILING_VIOLATION_TOLERANCE_M
    )
  ) {
    return false;
  }
  // A window latches on the step its entry is logged, and the latest fast
  // ascent's peak never exceeds the window's, which keeps rising. The reverse
  // is not required: legacy does not save the windows, so a resumed legacy
  // dive restarts them over a fast rate or a broken ceiling, and so may this.
  const entries = candidate.entries as { kind: string; value: number }[];
  const lastFastAscent = entries.filter((entry) => entry.kind === "fast-ascent").at(-1);
  if (
    (candidate.fastAscentLatched === true &&
      (lastFastAscent === undefined || lastFastAscent.value > peakMpm)) ||
    (candidate.ceilingViolationLatched === true &&
      !entries.some((entry) => entry.kind === "ceiling-violation"))
  ) {
    return false;
  }
  if (
    candidate.fastAscentLatched !== fastAscentS >= FAST_ASCENT_WINDOW_S ||
    (underWay ? peakMpm <= FAST_ASCENT_RATE_MPM : peakMpm !== 0) ||
    candidate.ceilingViolationLatched !==
      (candidate.ceilingViolationS as number) >= CEILING_VIOLATION_WINDOW_S
  ) {
    return false;
  }
  // The model sets the below-five latch on the step it records a lowest NDL
  // below five, and the lowest NDL never rises again: the two agree exactly
  // (#201 Codex round 2).
  const minNdlMin = candidate.minNdlMin;
  if (minNdlMin === null) {
    return candidate.ndlDroppedBelowFiveMinutes === false;
  }
  return (
    Number.isInteger(minNdlMin) &&
    (minNdlMin as number) >= 0 &&
    (minNdlMin as number) <= NDL_UNLIMITED_MINUTES &&
    candidate.ndlDroppedBelowFiveMinutes === (minNdlMin as number) < 5
  );
}

/**
 * The log a legacy save carries (src/game-loop.js saveDiveState): its
 * diveEvents in minutes, minNdlSeen (null for none), ndlDroppedBelow5 and
 * ascentRate. Of the event kinds, the two this log records are kept;
 * safetyStopSkipped is only ever pushed at the surface, after legacy has
 * stopped saving, and drillOutcome belongs to drills, which the migration
 * client does not have. The debounce accumulators are not saved by legacy
 * either, so a resumed window starts over, as it does there.
 */
/** The lowest NDL a legacy ndlDroppedBelow5 without minNdlSeen implies. */
const LEGACY_FLAG_ONLY_MIN_NDL = 4;

function migrateLegacyLog(candidate: Record<string, unknown>): DiveLog {
  const events = Array.isArray(candidate.diveEvents) ? candidate.diveEvents : [];
  const entries: DiveLogEntry[] = [];
  for (const event of events as unknown[]) {
    if (
      isRecord(event) &&
      (event.kind === "fastAscent" || event.kind === "ceilingViolation") &&
      isNonNegativeFinite(event.t) &&
      Number.isFinite(event.value)
    ) {
      entries.push({
        kind: event.kind === "fastAscent" ? "fast-ascent" : "ceiling-violation",
        elapsedTimeS: ((event.t as number) * 60) as DiveLogEntry["elapsedTimeS"],
        value: event.value as number,
      });
    }
  }
  // Legacy sets minNdlSeen and ndlDroppedBelow5 on the same frame, so the
  // pair agrees in any save that has both. A save from before minNdlSeen was
  // added carries only the flag; it keeps it, since the flag picks the long
  // safety stop, with the highest lowest-NDL it implies, 4 minutes.
  const savedMinimum =
    Number.isInteger(candidate.minNdlSeen) &&
    (candidate.minNdlSeen as number) >= 0 &&
    (candidate.minNdlSeen as number) <= NDL_UNLIMITED_MINUTES
      ? (candidate.minNdlSeen as number)
      : null;
  const minNdlMin =
    candidate.ndlDroppedBelow5 === true && (savedMinimum === null || savedMinimum >= 5)
      ? LEGACY_FLAG_ONLY_MIN_NDL
      : savedMinimum;
  const profile: DiveProfileSample[] = [];
  for (const sample of Array.isArray(candidate.diveProfile) ? (candidate.diveProfile as unknown[]) : []) {
    if (
      isRecord(sample) &&
      isNonNegativeFinite(sample.t) &&
      isNonNegativeFinite(sample.depth) &&
      isNonNegativeFinite(sample.ceiling)
    ) {
      profile.push({
        elapsedTimeS: ((sample.t as number) * 60) as DiveProfileSample["elapsedTimeS"],
        depthM: sample.depth as DiveProfileSample["depthM"],
        ceilingM: sample.ceiling as DiveProfileSample["ceilingM"],
      });
    }
  }
  return {
    ...createEmptyDiveLog(),
    entries,
    ascentRateMpm: Number.isFinite(candidate.ascentRate)
      ? (candidate.ascentRate as number)
      : 0,
    minNdlMin,
    ndlDroppedBelowFiveMinutes: minNdlMin !== null && minNdlMin < 5,
    depthTimeMS: isNonNegativeFinite(candidate.avgDepthAccum)
      ? (candidate.avgDepthAccum as number)
      : 0,
    submergedS: (isNonNegativeFinite(candidate.avgDepthSamples)
      ? (candidate.avgDepthSamples as number)
      : 0) as DiveLog["submergedS"],
    profile,
  };
}

function isTankState(candidate: unknown): candidate is TankState {
  return (
    isRecord(candidate) &&
    isGasMix(candidate.gas) &&
    isPositiveFinite(candidate.volumeL) &&
    isNonNegativeFinite(candidate.gasRemainingL)
  );
}

function isCcrState(candidate: unknown): candidate is CcrState {
  if (!isRecord(candidate)) {
    return false;
  }
  const numericFields = [
    "targetPo2Bar",
    "actualPo2Bar",
    "oxygenCylinderVolumeL",
    "oxygenCylinderPressureBar",
    "diluentCylinderVolumeL",
    "diluentCylinderPressureBar",
    "loopVolumeL",
    "scrubberRemainingS",
    "metabolicOxygenLpm",
    "po2ResponseBarPerSecond",
    "co2BuildupS",
  ] as const;
  return (
    numericFields.every((field) => isNonNegativeFinite(candidate[field])) &&
    isGasMix(candidate.diluent) &&
    typeof candidate.onBailout === "boolean" &&
    typeof candidate.scrubberFailed === "boolean"
  );
}

function isFailureState(candidate: unknown): boolean {
  if (!isRecord(candidate)) {
    return false;
  }
  return (
    (candidate.reason === null || isFailureReason(candidate.reason)) &&
    isNonNegativeFinite(candidate.oxygenToxicityS) &&
    isNonNegativeFinite(candidate.hypoxiaS) &&
    isNonNegativeFinite(candidate.ccrHypoxiaS) &&
    isNonNegativeFinite(candidate.ccrHyperoxiaS)
  );
}

function isDiveEvent(
  candidate: unknown,
  tankCount: number,
  elapsedTimeS: number,
): candidate is DiveEvent {
  if (
    !isRecord(candidate) ||
    !["bailout", "gas-switch", "failure"].includes(candidate.type as string) ||
    !isNonNegativeFinite(candidate.elapsedTimeS) ||
    candidate.elapsedTimeS > elapsedTimeS
  ) {
    return false;
  }
  if (
    candidate.tankIndex !== undefined &&
    (!Number.isInteger(candidate.tankIndex) || (candidate.tankIndex as number) < 0)
  ) {
    return false;
  }
  if (candidate.type === "gas-switch") {
    return (
      Number.isInteger(candidate.tankIndex) &&
      (candidate.tankIndex as number) < tankCount &&
      candidate.failureReason === undefined
    );
  }
  if (candidate.type === "failure") {
    return (
      candidate.tankIndex === undefined &&
      isFailureReason(candidate.failureReason)
    );
  }
  return candidate.tankIndex === undefined && candidate.failureReason === undefined;
}

function isEventHistory(
  candidate: unknown,
  tankCount: number,
  elapsedTimeS: number,
  failureReason: DiveFailureReason | null,
): candidate is readonly DiveEvent[] {
  if (!Array.isArray(candidate)) {
    return false;
  }
  let previousTimeS = 0;
  for (const event of candidate) {
    if (!isDiveEvent(event, tankCount, elapsedTimeS)) {
      return false;
    }
    if (event.elapsedTimeS < previousTimeS) {
      return false;
    }
    previousTimeS = event.elapsedTimeS;
  }

  const failureEvents = candidate.filter(
    (event): event is DiveEvent => isRecord(event) && event.type === "failure",
  );
  if (failureReason === null) {
    return failureEvents.length === 0;
  }
  const finalEvent = candidate.at(-1) as DiveEvent | undefined;
  return (
    failureEvents.length === 1 &&
    finalEvent?.type === "failure" &&
    finalEvent.failureReason === failureReason
  );
}

function isFailureReason(candidate: unknown): candidate is DiveFailureReason {
  const validReasons: readonly DiveFailureReason[] = [
    "out-of-gas",
    "oxygen-toxicity",
    "hypoxia",
    "ccr-hypoxia",
    "ccr-hyperoxia",
    "ccr-co2",
  ];
  return validReasons.includes(candidate as DiveFailureReason);
}

function isGasMix(candidate: unknown): candidate is GasMix {
  return (
    isRecord(candidate) &&
    isGasFractions(
      candidate.oxygenFraction,
      candidate.heliumFraction,
      candidate.nitrogenFraction,
    )
  );
}

function isGasFractions(
  oxygen: unknown,
  helium: unknown,
  nitrogen: unknown,
): oxygen is GasMix["oxygenFraction"] {
  return (
    isFraction(oxygen) &&
    isFraction(helium) &&
    isFraction(nitrogen) &&
    Math.abs(oxygen + helium + nitrogen - 1) <= 1e-9
  );
}

function isTissueArray(candidate: unknown): candidate is readonly number[] {
  return (
    Array.isArray(candidate) &&
    candidate.length === TISSUE_COMPARTMENT_COUNT &&
    candidate.every(isNonNegativeFinite)
  );
}

function isFraction(candidate: unknown): candidate is number {
  return (
    typeof candidate === "number" &&
    Number.isFinite(candidate) &&
    candidate >= 0 &&
    candidate <= 1
  );
}

function isPositiveFinite(candidate: unknown): candidate is number {
  return isNonNegativeFinite(candidate) && candidate > 0;
}

function isNonNegativeFinite(candidate: unknown): candidate is number {
  return (
    typeof candidate === "number" &&
    Number.isFinite(candidate) &&
    candidate >= 0
  );
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}
