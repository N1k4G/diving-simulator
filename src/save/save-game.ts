import {
  DEFAULT_SCRUBBER_DURATION_S,
  createEmptyDiveLog,
  createRuleOfThirdsState,
  createSafetyStopState,
  createSharkState,
  freezeDiveState,
  type DiveLog,
  type DiveLogEntry,
  type DiveProfileSample,
  type SafetyStopState,
  type CcrState,
  type DiveEvent,
  type DiveFailureReason,
  type DiveState,
  type GasMix,
  type TankState,
} from "../core/dive-state";
import { neutralBcdSurfaceLitres } from "../core/buoyancy";
import { NDL_UNLIMITED_MINUTES, ceilingDepthM, decoStopDepth } from "../core/decompression";
import {
  CEILING_VIOLATION_TOLERANCE_M,
  CEILING_VIOLATION_WINDOW_S,
  COMPLETION_MAX_CEILING_M,
  COMPLETION_MIN_ELAPSED_S,
  COMPLETION_MIN_MAX_DEPTH_M,
  DCS_VIOLATION_FAILURE_SECONDS,
  FAILURES_BEFORE_THE_LOG,
  FAST_ASCENT_RATE_MPM,
  FAST_ASCENT_WINDOW_S,
  PROFILE_SAMPLE_INTERVAL_S,
  SAFETY_STOP_LONG_BELOW_M,
  SAFETY_STOP_LONG_S,
  SAFETY_STOP_SHORT_S,
  SAFETY_STOP_NEEDED_BELOW_M,
  SUBMERGED_DEPTH_M,
  SURFACED_DEPTH_M,
  SURFACE_DCS_CEILING_M,
  SURFACE_DCS_DEPTH_M,
  isInSafetyStopBand,
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
//
// v9 adds state.safetyStop, the adaptive safety stop (#199). Older saves
// resume with the stop needed exactly when the dive has been deeper than
// 11 m, which is when the model latches it, and the countdown not started:
// a diver shallower than 6 m starts it on the next step, as after legacy's
// reset. Legacy saves carry their safetyStop* fields and keep them.
//
// v10 adds each cylinder's startGasL and the rebreather's start pressures
// and scrubber total (#199), for gas used. Older saves never recorded the
// fill, so they resume with the current contents as the start: gas used
// then counts from the resume. Legacy saves carry totalGas,
// o2CylPressureStart, dilCylPressureStart and scrubberTotal, and keep them.
//
// v11 adds state.failure.dcsViolationS, the decompression-sickness timer
// (#199). Older saves never ran it and resume at zero, which gives a diver
// above the stop the full 60 seconds again. Legacy saves carry
// dcsViolationTime and keep it.
//
// v12 adds state.completed, a dive ended at the surface (#199), and the
// log's safety-stop-skipped entry that can end one. Older saves were written
// by clients that could not end a dive that way and resume with it false.
// Legacy saves only diving states and resumes them the same way.
//
// v13 adds state.thirds, the rule of thirds (#199). Older saves never
// tracked it and resume outside any plan with the reserve never reached; a
// diver under an overhead plans afresh from the gas left on the next step.
// Legacy saves carry thirdsReserveHitThisDive and keep it; legacy does not
// save the plan itself and restores it empty, as this does.
//
// v14 adds state.failure.barotraumaS, the barotrauma timer (#189). Older
// saves never ran it and resume at zero, which gives a diver ascending fast
// the full 10 seconds again. Legacy saves carry barotraumaTime and keep it.
//
// v15 adds state.narcosisIndex and state.failure.narcosisKoS, nitrogen
// narcosis (#189). Older saves never tracked it and resume at zero: a diver
// at depth builds the index up again from nothing. Legacy saves carry
// narcosisIndex and narcosisKOTime and keep them.
//
// v16 adds state.shark, the shark encounter (#219): the roll timer and the
// shark while one swims. Older saves never rolled and resume as a new dive
// does, a full minute to the first roll and no shark. Legacy saves carry
// sharkTimer and keep it; legacy does not save the shark itself and
// resumes without one, as this does.
export const CURRENT_SAVE_GAME_VERSION = 16;
export const FIFTEENTH_SAVE_GAME_VERSION = 15;
export const FOURTEENTH_SAVE_GAME_VERSION = 14;
export const THIRTEENTH_SAVE_GAME_VERSION = 13;
export const TWELFTH_SAVE_GAME_VERSION = 12;
export const ELEVENTH_SAVE_GAME_VERSION = 11;
export const TENTH_SAVE_GAME_VERSION = 10;
export const NINTH_SAVE_GAME_VERSION = 9;
export const EIGHTH_SAVE_GAME_VERSION = 8;
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
  | "save-game-v8"
  | "save-game-v9"
  | "save-game-v10"
  | "save-game-v11"
  | "save-game-v12"
  | "save-game-v13"
  | "save-game-v14"
  | "save-game-v15"
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
    // Each version is migrated by what it lacks, so the rules below read as
    // "before vN". The supported versions are 1 to CURRENT_SAVE_GAME_VERSION.
    const version = candidate.version;
    if (
      !Number.isInteger(version) ||
      (version as number) < FIRST_SAVE_GAME_VERSION ||
      (version as number) > CURRENT_SAVE_GAME_VERSION
    ) {
      return { ok: false, reason: "unsupported-version" };
    }
    const v = version as number;
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
    // Before v9 there was no safety stop: resume with one derived from the
    // deepest point.
    if (v < SEVENTH_SAVE_GAME_VERSION && isRecord(candidate.state)) {
      candidate.state = { ...candidate.state, log: createEmptyDiveLog() };
    }
    if (
      v === SEVENTH_SAVE_GAME_VERSION &&
      isRecord(candidate.state) &&
      isRecord(candidate.state.log)
    ) {
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
    if (v < SIXTH_SAVE_GAME_VERSION && isRecord(candidate.state)) {
      const savedDepth = isNonNegativeFinite(candidate.state.depthM)
        ? (candidate.state.depthM as number)
        : 0;
      candidate.state = {
        ...candidate.state,
        verticalVelocityMpm: 0,
        bcdGasSurfaceLiters: neutralBcdSurfaceLitres(savedDepth),
      };
    }
    if (v < FOURTH_SAVE_GAME_VERSION && isRecord(candidate.state)) {
      candidate.state = { ...candidate.state, cnsPercent: 0 };
    }
    if (v < NINTH_SAVE_GAME_VERSION && isRecord(candidate.state)) {
      candidate.state = {
        ...candidate.state,
        safetyStop: derivedSafetyStop(candidate.state.maxDepthM),
      };
    }
    // Before v10 no fill was recorded: the current contents are the start.
    if (v < TENTH_SAVE_GAME_VERSION && isRecord(candidate.state)) {
      candidate.state = withCurrentContentsAsStart(candidate.state);
    }
    // Before v11 there was no DCS timer: it resumes at zero. Nor was there
    // decompression sickness, so no such save can have ended in it (#212
    // pre-review).
    if (
      v < ELEVENTH_SAVE_GAME_VERSION &&
      isRecord(candidate.state) &&
      isRecord(candidate.state.failure)
    ) {
      if (candidate.state.failure.reason === "decompression-sickness") {
        return { ok: false, reason: "invalid-data" };
      }
      candidate.state = {
        ...candidate.state,
        failure: { ...candidate.state.failure, dcsViolationS: 0 },
      };
    }
    // Before v12 no dive ended at the surface.
    if (v < TWELFTH_SAVE_GAME_VERSION && isRecord(candidate.state)) {
      candidate.state = { ...candidate.state, completed: false };
    }
    // Before v13 there was no rule of thirds.
    if (v < THIRTEENTH_SAVE_GAME_VERSION && isRecord(candidate.state)) {
      candidate.state = { ...candidate.state, thirds: createRuleOfThirdsState() };
    }
    // Before v14 there was no barotrauma timer: it resumes at zero.
    if (
      v < FOURTEENTH_SAVE_GAME_VERSION &&
      isRecord(candidate.state) &&
      isRecord(candidate.state.failure)
    ) {
      candidate.state = {
        ...candidate.state,
        failure: { ...candidate.state.failure, barotraumaS: 0 },
      };
    }
    // Before v15 there was no narcosis: index and KO timer resume at zero.
    if (
      v < FIFTEENTH_SAVE_GAME_VERSION &&
      isRecord(candidate.state) &&
      isRecord(candidate.state.failure)
    ) {
      candidate.state = {
        ...candidate.state,
        narcosisIndex: 0,
        failure: { ...candidate.state.failure, narcosisKoS: 0 },
      };
    }
    // Before v16 there was no shark: a minute to the first roll, none
    // swimming. Nor could a dive have ended in an attack.
    if (v < CURRENT_SAVE_GAME_VERSION && isRecord(candidate.state)) {
      if (isRecord(candidate.state.failure) && candidate.state.failure.reason === "shark-attack") {
        return { ok: false, reason: "invalid-data" };
      }
      candidate.state = { ...candidate.state, shark: createSharkState() };
    }
    // A v1 payload has no gradientFactors and is filled with the defaults; a
    // v2 payload must carry a valid pair rather than fall back to them, or a
    // corrupted field would silently re-plan the dive on 35/75 — the very
    // failure this version exists to stop. Read before the state, whose log
    // is checked against the GF high.
    if (v > FIRST_SAVE_GAME_VERSION && !isSavedGradientFactors(candidate.gradientFactors)) {
      return { ok: false, reason: "invalid-data" };
    }
    const savedFactors =
      v === FIRST_SAVE_GAME_VERSION
        ? DEFAULT_SAVED_GRADIENT_FACTORS
        : (candidate.gradientFactors as SavedGradientFactors);
    if (
      !isPositiveFinite(candidate.savedAtEpochMs) ||
      !isDiveState(candidate.state, savedFactors.highPercent)
    ) {
      return { ok: false, reason: "invalid-data" };
    }
    // Likewise a v3 or later payload must carry a mode consistent with its
    // state; only saves from before the field existed are inferred.
    const recordsMode = v >= THIRD_SAVE_GAME_VERSION;
    if (recordsMode && !isConsistentDiveMode(candidate.diveMode, candidate.state)) {
      return { ok: false, reason: "invalid-data" };
    }
    const diveMode = recordsMode
      ? (candidate.diveMode as SavedDiveMode)
      : inferDiveMode(candidate.state);

    return {
      ok: true,
      saveGame: createSaveGame(
        candidate.state,
        savedFactors,
        candidate.savedAtEpochMs,
        diveMode,
      ),
      migratedFrom:
        v === CURRENT_SAVE_GAME_VERSION
          ? null
          : (`save-game-v${v}` as Exclude<SaveGameMigration, "legacy-v2" | null>),
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
    ? migrateLegacyCcr(candidate.ccrState, (candidate.diveTime as number) * 60)
    : null;
  if (candidate.diveMode === "ccr" && ccr === null) {
    return null;
  }

  // The safety stop is checked against the log's below-five latch.
  const log = migrateLegacyLog(candidate);
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
    // Legacy saves both and refuses a restore without them (#189); a save
    // that lacks them anyway resumes at zero rather than being lost.
    narcosisIndex: isFraction(candidate.narcosisIndex)
      ? candidate.narcosisIndex
      : 0,
    // Legacy saves both since its save-state v2.
    verticalVelocityMpm: Number.isFinite(candidate.verticalVelocity)
      ? (candidate.verticalVelocity as number)
      : 0,
    bcdGasSurfaceLiters: isNonNegativeFinite(candidate.bcdGasSurfaceLiters)
      ? (candidate.bcdGasSurfaceLiters as number)
      : neutralBcdSurfaceLitres(candidate.depth as number),
    ccr,
    completed: false,
    thirds: {
      ...createRuleOfThirdsState(),
      reserveHit: candidate.thirdsReserveHitThisDive === true,
    },
    // Legacy saves its sharkTimer and refuses a restore without it (#219),
    // but not the shark: it resumes with none swimming.
    shark: {
      ...createSharkState(),
      ...(isPositiveFinite(candidate.sharkTimer)
        ? { timerS: candidate.sharkTimer as DiveState["shark"]["timerS"] }
        : {}),
    },
    failure: {
      reason: null,
      oxygenToxicityS:
        candidate.po2ViolationTime as DiveState["failure"]["oxygenToxicityS"],
      hypoxiaS: candidate.hypoxiaTime as DiveState["failure"]["hypoxiaS"],
      ccrHypoxiaS:
        candidate.ccrHypoxiaTime as DiveState["failure"]["ccrHypoxiaS"],
      ccrHyperoxiaS:
        candidate.ccrHyperoxiaTime as DiveState["failure"]["ccrHyperoxiaS"],
      // Legacy saves it and refuses a restore without it; a save that lacks
      // it anyway resumes at zero rather than being lost.
      dcsViolationS: (isNonNegativeFinite(candidate.dcsViolationTime)
        ? candidate.dcsViolationTime
        : 0) as DiveState["failure"]["dcsViolationS"],
      // Likewise barotraumaTime (#189).
      barotraumaS: (isNonNegativeFinite(candidate.barotraumaTime)
        ? candidate.barotraumaTime
        : 0) as DiveState["failure"]["barotraumaS"],
      narcosisKoS: (isNonNegativeFinite(candidate.narcosisKOTime)
        ? candidate.narcosisKOTime
        : 0) as DiveState["failure"]["narcosisKoS"],
    },
    events: [],
    log,
    safetyStop: migrateLegacySafetyStop(candidate, log.ndlDroppedBelowFiveMinutes),
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

  // Legacy's totalGas is the fill the dive started from; a save without a
  // usable one counts gas used from the resume.
  const startGasL =
    isPositiveFinite(candidate.totalGas) &&
    (candidate.totalGas as number) >= (candidate.gasRemaining as number)
      ? candidate.totalGas
      : candidate.gasRemaining;
  return {
    gas: {
      oxygenFraction: candidate.fO2,
      heliumFraction: candidate.fHe,
      nitrogenFraction: candidate.fN2,
    },
    volumeL: candidate.volume,
    gasRemainingL: candidate.gasRemaining,
    startGasL,
  } as TankState;
}

/** A legacy start value, or the current one when it is missing or below it. */
/**
 * Legacy's scrubberTotal, in seconds, when it is one the dive could have run
 * down to what is left: no more above it than the dive's time. Otherwise
 * what is left, as for any unusable start.
 */
function legacyScrubberTotalS(candidate: Record<string, unknown>, diveTimeS: number): number {
  const remainingS = (candidate.scrubberRemaining as number) * 60;
  const totalS = legacyStartOr(candidate.scrubberTotal, candidate.scrubberRemaining as number) * 60;
  return totalS - remainingS <= diveTimeS + SUM_ROUNDING_S ? totalS : remainingS;
}

function legacyStartOr(start: unknown, current: number): number {
  return isNonNegativeFinite(start) && (start as number) >= current
    ? (start as number)
    : current;
}

function migrateLegacyCcr(candidate: unknown, diveTimeS: number): CcrState | null {
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
    oxygenCylinderStartPressureBar: legacyStartOr(
      candidate.o2CylPressureStart,
      candidate.o2CylPressure as number,
    ),
    diluentCylinderStartPressureBar: legacyStartOr(
      candidate.dilCylPressureStart,
      candidate.dilCylPressure as number,
    ),
    loopVolumeL: candidate.loopVolume,
    scrubberRemainingS: (candidate.scrubberRemaining as number) * 60,
    scrubberTotalS: legacyScrubberTotalS(candidate, diveTimeS),
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
  const ceilingM = isRecord(candidate.tissues) &&
    isTissueArray(candidate.tissues.nitrogenBar) &&
    isTissueArray(candidate.tissues.heliumBar)
    ? ceilingDepthM(
        candidate.tissues as unknown as DiveState["tissues"],
        gradientFactorHighPercent / 100,
      )
    : Number.NaN;

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
    candidate.tanks.every((tank) => isTankState(tank, candidate.elapsedTimeS as number)) &&
    Number.isInteger(candidate.activeTankIndex) &&
    (candidate.activeTankIndex as number) >= 0 &&
    (candidate.activeTankIndex as number) < candidate.tanks.length &&
    isNonNegativeFinite(candidate.surfaceAirConsumptionLpm) &&
    isNonNegativeFinite(candidate.cnsPercent) &&
    isFraction(candidate.narcosisIndex) &&
    Number.isFinite(candidate.verticalVelocityMpm) &&
    isNonNegativeFinite(candidate.bcdGasSurfaceLiters) &&
    (candidate.ccr === null || isCcrState(candidate.ccr, candidate.elapsedTimeS as number)) &&
    isFailureState(candidate.failure, {
      elapsedTimeS: candidate.elapsedTimeS as number,
      depthM: candidate.depthM as number,
      ceilingM,
    }) &&
    isRuleOfThirds(candidate.thirds, candidate.tanks as unknown[]) &&
    isSharkState(candidate.shark) &&
    isEventHistory(
      candidate.events,
      (candidate.tanks as unknown[]).length,
      candidate.elapsedTimeS as number,
      (candidate.failure as Record<string, unknown>).reason as
        | DiveFailureReason
        | null,
    ) &&
    isSafetyStop(candidate.safetyStop, {
      depthM: candidate.depthM as number,
      maxDepthM: candidate.maxDepthM as number,
      ndlDroppedBelowFiveMinutes:
        isRecord(candidate.log) && candidate.log.ndlDroppedBelowFiveMinutes === true,
      failureReason: (candidate.failure as Record<string, unknown>).reason as
        | DiveFailureReason
        | null,
    }) &&
    isDiveLog(candidate.log, {
      elapsedTimeS: candidate.elapsedTimeS as number,
      depthM: candidate.depthM as number,
      maxDepthM: candidate.maxDepthM as number,
      ceilingM,
      failureReason: (candidate.failure as Record<string, unknown>).reason as
        | DiveFailureReason
        | null,
      completed: candidate.completed === true,
    }) &&
    isCompletion(candidate, ceilingM)
  );
}

/**
 * A completed dive the model could have ended (#199): not failed, at the
 * surface with the saved tissues' ceiling cleared, after more than 30 s of a
 * dive deeper than 2 m, and with a safety-stop-skipped entry exactly when
 * its stop was needed and not done. The entry itself is checked with the log.
 */
function isCompletion(candidate: Record<string, unknown>, ceilingM: number): boolean {
  if (typeof candidate.completed !== "boolean") {
    return false;
  }
  if (!candidate.completed) {
    return true;
  }
  const failure = candidate.failure as Record<string, unknown>;
  const stop = candidate.safetyStop as Record<string, unknown>;
  const entries = (candidate.log as Record<string, unknown>).entries as Record<string, unknown>[];
  const skipped = entries.at(-1)?.kind === "safety-stop-skipped";
  return (
    failure.reason === null &&
    (candidate.depthM as number) < SURFACED_DEPTH_M &&
    (candidate.elapsedTimeS as number) > COMPLETION_MIN_ELAPSED_S &&
    (candidate.maxDepthM as number) > COMPLETION_MIN_MAX_DEPTH_M &&
    ceilingM <= COMPLETION_MAX_CEILING_M &&
    skipped === (stop.needed === true && stop.complete !== true)
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
    // Every counted second is deeper than 0.5 m (#204 Codex round 1): no
    // sum without time, and at least half the time in metre-seconds.
    ((log.submergedS as number) === 0 && (log.depthTimeMS as number) !== 0) ||
    (log.depthTimeMS as number) <
      SUBMERGED_DEPTH_M * (log.submergedS as number) * (1 - 1e-9) - SUM_ROUNDING_S ||
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
  /** The dive ended at the surface, which a skipped safety stop needs. */
  readonly completed: boolean;
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
    // A skipped safety stop is logged once, as the dive ends at the surface:
    // the last entry of a completed dive, at its end, value 0.
    const last = entry === (candidate.entries as unknown[]).at(-1);
    if (entry.kind === "fast-ascent" ? value <= FAST_ASCENT_RATE_MPM
      : entry.kind === "ceiling-violation" ? value <= CEILING_VIOLATION_TOLERANCE_M
      : entry.kind === "safety-stop-skipped"
        ? value !== 0 || !context.completed || !last || entry.elapsedTimeS !== elapsedTimeS
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

/**
 * A pre-v10 state with its current contents as the start of the dive: each
 * cylinder's startGasL its gasRemainingL, and the rebreather's start
 * pressures and scrubber total its current ones. Anything malformed is left
 * for validation to reject.
 */
function withCurrentContentsAsStart(state: Record<string, unknown>): Record<string, unknown> {
  const tanks = Array.isArray(state.tanks)
    ? state.tanks.map((tank: unknown) =>
        isRecord(tank) ? { ...tank, startGasL: tank.gasRemainingL } : tank,
      )
    : state.tanks;
  // The scrubber's duration has no control on any setup screen that wrote
  // these saves, and both clients restart it at that duration each dive, so
  // every such dive started at the default (#211 pre-review). A save already
  // past it (none was written, but a corrupt one could be) keeps what is
  // left instead, which validation then holds to the dive's clock. The
  // cylinders fall back to the current contents: the oxygen fill is
  // configurable, and legacy does not refill the diluent between the dives
  // of one session, so an imported dive can start below 200 bar (#211
  // pre-review, pass 2).
  const ccr = isRecord(state.ccr)
    ? {
        ...state.ccr,
        oxygenCylinderStartPressureBar: state.ccr.oxygenCylinderPressureBar,
        diluentCylinderStartPressureBar: state.ccr.diluentCylinderPressureBar,
        scrubberTotalS: isNonNegativeFinite(state.ccr.scrubberRemainingS)
          ? Math.max(DEFAULT_SCRUBBER_DURATION_S, state.ccr.scrubberRemainingS as number)
          : state.ccr.scrubberRemainingS,
      }
    : state.ccr;
  return { ...state, tanks, ccr };
}

/**
 * The safety stop a save without one resumes with: needed exactly when the
 * dive has been deeper than 11 m, which is when the model latches it, and no
 * countdown under way.
 */
function derivedSafetyStop(maxDepthM: unknown): SafetyStopState {
  return {
    ...createSafetyStopState(),
    needed: isNonNegativeFinite(maxDepthM) && (maxDepthM as number) > SAFETY_STOP_NEEDED_BELOW_M,
  };
}

/**
 * A safety stop the model could have left (#199): needed only after the dive
 * has been deeper than 11 m (a dive that starts deeper, as the wreck slice
 * does, latches it on its first step, so a save before that step has it
 * unset); no countdown deeper than 11 m, where every
 * step resets it; an untouched countdown until it starts; a complete stop at
 * zero; no more time left than the long stop; and, while it runs, paused
 * exactly outside its band. The step a rebreather failure ends the dive on
 * does not update the stop, so a dive that ended so is checked for shape only.
 */
function isSafetyStop(
  candidate: unknown,
  context: {
    readonly depthM: number;
    readonly maxDepthM: number;
    /** The dive log's below-five latch, which with the depth sets the stop's length. */
    readonly ndlDroppedBelowFiveMinutes: boolean;
    readonly failureReason: DiveFailureReason | null;
  },
): candidate is SafetyStopState {
  if (
    !isRecord(candidate) ||
    typeof candidate.needed !== "boolean" ||
    typeof candidate.countdownStarted !== "boolean" ||
    typeof candidate.paused !== "boolean" ||
    typeof candidate.complete !== "boolean" ||
    !isNonNegativeFinite(candidate.remainingS) ||
    (candidate.remainingS as number) > SAFETY_STOP_LONG_S
  ) {
    return false;
  }
  // A rebreather failure returns before legacy's safety-stop block, so the
  // stop is the step before's while the depth has moved on: only the two
  // rules that tie the stop to the current depth do not hold there. The rest
  // does, since the deepest point only grows and the latch is the step
  // before's too.
  const followsDepth = !(
    context.failureReason !== null &&
    FAILURES_BEFORE_THE_LOG.has(context.failureReason)
  );
  const started = candidate.countdownStarted;
  const remainingS = candidate.remainingS as number;
  // The countdown starts at legacy's calculateSafetyStopDuration() and only
  // runs down. Its inputs, the deepest point and the below-five latch, only
  // ever grow, so the length they give now bounds what is left (#206 Codex
  // round 1).
  const longestS =
    context.maxDepthM > SAFETY_STOP_LONG_BELOW_M || context.ndlDroppedBelowFiveMinutes
      ? SAFETY_STOP_LONG_S
      : SAFETY_STOP_SHORT_S;
  return (
    remainingS <= longestS &&
    // A countdown that reaches zero completes on that step, unpaused.
    (!started || candidate.complete === (remainingS === 0)) &&
    (!candidate.complete || !candidate.paused) &&
    (!candidate.needed || context.maxDepthM > SAFETY_STOP_NEEDED_BELOW_M) &&
    (!started || candidate.needed) &&
    (started || (remainingS === 0 && !candidate.paused && !candidate.complete)) &&
    (!candidate.complete || remainingS === 0) &&
    (!followsDepth ||
      ((context.depthM <= SAFETY_STOP_NEEDED_BELOW_M || !started) &&
        (!started ||
          candidate.complete ||
          candidate.paused === !isInSafetyStopBand(context.depthM))))
  );
}

/**
 * The safety stop a legacy save carries: safetyStopNeeded,
 * safetyStopCountdownStarted, safetyStopRemaining (seconds), safetyStopPaused
 * and safetyStopComplete. A save whose fields do not make a stop the model
 * could have left resumes with one derived from the deepest point instead,
 * rather than losing the dive.
 */
function migrateLegacySafetyStop(
  candidate: Record<string, unknown>,
  ndlDroppedBelowFiveMinutes: boolean,
): SafetyStopState {
  // Carried only when all five fields are there with their types: a missing
  // or malformed one is not a record of the stop (#206 Codex round 2).
  if (
    typeof candidate.safetyStopNeeded !== "boolean" ||
    typeof candidate.safetyStopCountdownStarted !== "boolean" ||
    typeof candidate.safetyStopPaused !== "boolean" ||
    typeof candidate.safetyStopComplete !== "boolean" ||
    !isNonNegativeFinite(candidate.safetyStopRemaining)
  ) {
    return derivedSafetyStop(candidate.maxDepth);
  }
  // Legacy sets safetyStopNeeded on the tick that takes maxDepth past 11 m
  // and saves only between ticks, so a deeper dive without it contradicts
  // itself. The model's own pre-first-step exception, a dive that starts
  // deeper, does not apply to a saved legacy dive.
  if ((candidate.maxDepth as number) > SAFETY_STOP_NEEDED_BELOW_M && !candidate.safetyStopNeeded) {
    return derivedSafetyStop(candidate.maxDepth);
  }
  const carried = {
    needed: candidate.safetyStopNeeded,
    countdownStarted: candidate.safetyStopCountdownStarted,
    remainingS: candidate.safetyStopRemaining as SafetyStopState["remainingS"],
    paused: candidate.safetyStopPaused,
    complete: candidate.safetyStopComplete,
  };
  return isSafetyStop(carried, {
    depthM: candidate.depth as number,
    maxDepthM: candidate.maxDepth as number,
    ndlDroppedBelowFiveMinutes,
    failureReason: null,
  })
    ? carried
    : derivedSafetyStop(candidate.maxDepth);
}

function isTankState(candidate: unknown, elapsedTimeS: number): candidate is TankState {
  return (
    isRecord(candidate) &&
    isGasMix(candidate.gas) &&
    isPositiveFinite(candidate.volumeL) &&
    isNonNegativeFinite(candidate.gasRemainingL) &&
    // A cylinder is only ever drawn from during a dive (#199), and only by a
    // step that moves the dive's clock: none is drawn from before the first.
    isNonNegativeFinite(candidate.startGasL) &&
    (candidate.startGasL as number) >= (candidate.gasRemainingL as number) &&
    (elapsedTimeS > 0 || candidate.startGasL === candidate.gasRemainingL)
  );
}

function isCcrState(candidate: unknown, elapsedTimeS: number): candidate is CcrState {
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
    "oxygenCylinderStartPressureBar",
    "diluentCylinderStartPressureBar",
    "scrubberTotalS",
  ] as const;
  return (
    numericFields.every((field) => isNonNegativeFinite(candidate[field])) &&
    // The cylinders and the scrubber are only ever drawn down (#199).
    (candidate.oxygenCylinderStartPressureBar as number) >=
      (candidate.oxygenCylinderPressureBar as number) &&
    (candidate.diluentCylinderStartPressureBar as number) >=
      (candidate.diluentCylinderPressureBar as number) &&
    (candidate.scrubberTotalS as number) >= (candidate.scrubberRemainingS as number) &&
    // The scrubber runs down by each step's time, on a step that adds that
    // time to the dive's clock, so it has never been used for longer than
    // the dive; and before the first step nothing has been drawn at all.
    (candidate.scrubberTotalS as number) - (candidate.scrubberRemainingS as number) <=
      elapsedTimeS + SUM_ROUNDING_S &&
    (elapsedTimeS > 0 ||
      (candidate.oxygenCylinderStartPressureBar === candidate.oxygenCylinderPressureBar &&
        candidate.diluentCylinderStartPressureBar === candidate.diluentCylinderPressureBar)) &&
    isGasMix(candidate.diluent) &&
    typeof candidate.onBailout === "boolean" &&
    typeof candidate.scrubberFailed === "boolean"
  );
}

/**
 * A rule of thirds the model could have left (#199): a plan, if any, no
 * smaller than the gas carried now, since the dive only draws gas down, and
 * the turn latch only while a plan is open.
 */
function isRuleOfThirds(candidate: unknown, tanks: readonly unknown[]): boolean {
  if (
    !isRecord(candidate) ||
    !isNonNegativeFinite(candidate.startingGasL) ||
    typeof candidate.turnWarned !== "boolean" ||
    typeof candidate.reserveHit !== "boolean"
  ) {
    return false;
  }
  const gasL = tanks.reduce<number>(
    (sum, tank) => sum + ((tank as { gasRemainingL: number }).gasRemainingL),
    0,
  );
  const startingGasL = candidate.startingGasL as number;
  return startingGasL === 0 ? !candidate.turnWarned : startingGasL >= gasL;
}

/**
 * The failure timers, and a decompression-sickness timer the model could
 * have left (#212 pre-review). It counts at most one dive second per second,
 * so it never exceeds the dive's time. It reaches 60 s only on the step that
 * ends the dive, and the failures checked before it (out of gas, oxygen
 * toxicity) can end that step first; any other dive, going on or ended,
 * holds it below 60. That step counted it up, so the saved tissues give a
 * ceiling and the diver is shallower than its first stop. A dive that ended
 * in decompression sickness did so on the timer, or at the surface with a
 * ceiling deeper than 3 m; at the surface the diver is above any stop, so
 * that step counted the timer up too (#212 pre-review, pass 2).
 */
function isFailureState(
  candidate: unknown,
  context: { readonly elapsedTimeS: number; readonly depthM: number; readonly ceilingM: number },
): boolean {
  if (
    !isRecord(candidate) ||
    !(candidate.reason === null || isFailureReason(candidate.reason)) ||
    !isNonNegativeFinite(candidate.oxygenToxicityS) ||
    !isNonNegativeFinite(candidate.hypoxiaS) ||
    !isNonNegativeFinite(candidate.ccrHypoxiaS) ||
    !isNonNegativeFinite(candidate.ccrHyperoxiaS) ||
    !isNonNegativeFinite(candidate.dcsViolationS) ||
    !isNonNegativeFinite(candidate.barotraumaS) ||
    !isNonNegativeFinite(candidate.narcosisKoS)
  ) {
    return false;
  }
  const dcsS = candidate.dcsViolationS as number;
  if (dcsS > context.elapsedTimeS + SUM_ROUNDING_S) {
    return false;
  }
  const reason = candidate.reason as DiveFailureReason | null;
  if (
    dcsS >= DCS_VIOLATION_FAILURE_SECONDS &&
    !(context.ceilingM > 0 && context.depthM < decoStopDepth(context.ceilingM))
  ) {
    return false;
  }
  // A dive at the surface with a ceiling deeper than 3 m ends on that step,
  // so none goes on from one (#212 Codex round 1). No earlier version could
  // save one either: the client's route kept the diver between 18 and 34 m
  // from #192 until it opened to the surface (#199), where the step that
  // surfaces ends such a dive, and legacy ends one in the same tick, before
  // it saves.
  if (
    reason === null &&
    context.depthM < SURFACE_DCS_DEPTH_M &&
    context.ceilingM > SURFACE_DCS_CEILING_M
  ) {
    return false;
  }
  if (reason === "decompression-sickness") {
    return (
      dcsS >= DCS_VIOLATION_FAILURE_SECONDS ||
      (dcsS > 0 &&
        context.depthM < SURFACE_DCS_DEPTH_M &&
        context.ceilingM > SURFACE_DCS_CEILING_M)
    );
  }
  // Legacy checks the shark, out of gas and oxygen toxicity before the DCS
  // timer, so a dive they end can have run it to its limit on that step.
  return (
    reason === "shark-attack" ||
    reason === "out-of-gas" ||
    reason === "oxygen-toxicity" ||
    dcsS < DCS_VIOLATION_FAILURE_SECONDS
  );
}

/**
 * The shark encounter (#219): a positive timer, as every step leaves it,
 * and a shark, if one swims, heading left or right at a finite place, depth
 * and speed.
 */
function isSharkState(candidate: unknown): boolean {
  if (!isRecord(candidate) || !isPositiveFinite(candidate.timerS)) {
    return false;
  }
  const encounter = candidate.encounter;
  if (encounter === null) {
    return true;
  }
  return (
    isRecord(encounter) &&
    Number.isFinite(encounter.offsetM) &&
    isNonNegativeFinite(encounter.depthM) &&
    (encounter.direction === 1 || encounter.direction === -1) &&
    isPositiveFinite(encounter.speedMps) &&
    typeof encounter.passed === "boolean"
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
    "decompression-sickness",
    "pulmonary-barotrauma",
    "nitrogen-narcosis",
    "shark-attack",
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
