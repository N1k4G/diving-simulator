import {
  freezeDiveState,
  type CcrState,
  type DiveEvent,
  type DiveFailureReason,
  type DiveState,
  type GasMix,
  type TankState,
} from "../core/dive-state";
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
export const CURRENT_SAVE_GAME_VERSION = 2;
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
}

export type SaveGameMigration = "legacy-v2" | "save-game-v1" | null;

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
): SaveGame {
  if (!isPositiveFinite(savedAtEpochMs)) {
    throw new RangeError("save timestamp must be a positive finite number");
  }

  const frozenState = freezeDiveState(state);
  if (!isDiveState(frozenState)) {
    throw new TypeError("cannot serialize an invalid DiveState");
  }
  if (!isSavedGradientFactors(gradientFactors)) {
    throw new RangeError(
      "gradient factors must be within 30-100 with low no greater than high",
    );
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
    const isFirst = candidate.version === FIRST_SAVE_GAME_VERSION;
    if (!Number.isInteger(candidate.version) || (!isCurrent && !isFirst)) {
      return { ok: false, reason: "unsupported-version" };
    }
    if (
      !isPositiveFinite(candidate.savedAtEpochMs) ||
      !isDiveState(candidate.state)
    ) {
      return { ok: false, reason: "invalid-data" };
    }
    // A v1 payload has no gradientFactors and is filled with the defaults; a
    // v2 payload must carry a valid pair rather than fall back to them, or a
    // corrupted field would silently re-plan the dive on 35/75 — the very
    // failure this version exists to stop.
    if (isCurrent && !isSavedGradientFactors(candidate.gradientFactors)) {
      return { ok: false, reason: "invalid-data" };
    }
    const gradientFactors = isCurrent
      ? (candidate.gradientFactors as SavedGradientFactors)
      : DEFAULT_SAVED_GRADIENT_FACTORS;

    return {
      ok: true,
      saveGame: createSaveGame(
        candidate.state,
        gradientFactors,
        candidate.savedAtEpochMs,
      ),
      migratedFrom: isCurrent ? null : "save-game-v1",
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
  };

  // The legacy save carries the pair too (src/game-loop.js writes `gfLow` and
  // `gfHigh`, restoreDiveState reads them back), so this migration is lossless
  // rather than a default. Saves written before the field existed, or with a
  // pair outside the bounds, fall back to the defaults instead of failing the
  // whole migration: losing a dive is worse than resuming it on 35/75.
  const gradientFactors = readLegacyGradientFactors(candidate);

  try {
    return createSaveGame(state, gradientFactors, candidate.savedAt);
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

function isDiveState(candidate: unknown): candidate is DiveState {
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
    (candidate.ccr === null || isCcrState(candidate.ccr)) &&
    isFailureState(candidate.failure) &&
    isEventHistory(
      candidate.events,
      (candidate.tanks as unknown[]).length,
      candidate.elapsedTimeS as number,
      (candidate.failure as Record<string, unknown>).reason as
        | DiveFailureReason
        | null,
    )
  );
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
