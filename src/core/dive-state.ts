import {
  SURFACE_N2_LOADING_BAR,
  TISSUE_COMPARTMENT_COUNT,
} from "./buhlmann-constants";
import { normalizeSeed } from "./rng";
import {
  bars,
  fraction,
  litres,
  litresPerMinute,
  metres,
  seconds,
  type Bars,
  type Fraction,
  type Litres,
  type LitresPerMinute,
  type Metres,
  type Seconds,
} from "./units";

export interface GasMix {
  oxygenFraction: Fraction;
  heliumFraction: Fraction;
  nitrogenFraction: Fraction;
}

export interface TissueState {
  nitrogenBar: readonly Bars[];
  heliumBar: readonly Bars[];
}

export interface CcrBreathingSource {
  kind: "ccr";
  actualPo2Bar: Bars;
  diluent: GasMix;
  onBailout: boolean;
}

export interface OpenCircuitBreathingSource {
  kind: "open-circuit";
  gas: GasMix;
}

export type BreathingSource = CcrBreathingSource | OpenCircuitBreathingSource;

export interface TankState {
  gas: GasMix;
  volumeL: Litres;
  gasRemainingL: Litres;
  /**
   * The fill the dive started with (#199), legacy's totalGas: volume times
   * the configured pressure. Gas used is this less gasRemainingL.
   */
  startGasL: Litres;
}

export interface CcrState {
  targetPo2Bar: Bars;
  actualPo2Bar: Bars;
  diluent: GasMix;
  oxygenCylinderVolumeL: Litres;
  oxygenCylinderPressureBar: Bars;
  diluentCylinderVolumeL: Litres;
  diluentCylinderPressureBar: Bars;
  /**
   * The start of the dive (#199), legacy's o2CylPressureStart,
   * dilCylPressureStart and scrubberTotal: O2, diluent and scrubber time
   * used are these less the current values.
   */
  oxygenCylinderStartPressureBar: Bars;
  diluentCylinderStartPressureBar: Bars;
  scrubberTotalS: Seconds;
  loopVolumeL: Litres;
  scrubberRemainingS: Seconds;
  metabolicOxygenLpm: LitresPerMinute;
  po2ResponseBarPerSecond: number;
  onBailout: boolean;
  scrubberFailed: boolean;
  co2BuildupS: Seconds;
}

export type DiveFailureReason =
  | "out-of-gas"
  | "oxygen-toxicity"
  | "hypoxia"
  | "decompression-sickness"
  | "ccr-hypoxia"
  | "ccr-hyperoxia"
  | "ccr-co2";

export interface FailureState {
  reason: DiveFailureReason | null;
  oxygenToxicityS: Seconds;
  hypoxiaS: Seconds;
  ccrHypoxiaS: Seconds;
  ccrHyperoxiaS: Seconds;
  /**
   * Legacy's dcsViolationTime (#199): dive seconds spent shallower than the
   * first stop while there is a ceiling, less the seconds since.
   */
  dcsViolationS: Seconds;
}

export interface DiveEvent {
  type: "bailout" | "gas-switch" | "failure";
  elapsedTimeS: Seconds;
  tankIndex?: number;
  failureReason?: DiveFailureReason;
}

/**
 * What the dive log records for the debriefing (#199), in legacy's own
 * vocabulary (src/state.js diveEvents): a fast ascent held past its window,
 * and a ceiling broken for longer than its window. `value` is legacy's:
 * the peak ascent rate in m/min, or how far above the ceiling in metres.
 * A dive that surfaces with its safety stop needed and not done ends with a
 * safety-stop-skipped entry, value 0.
 */
export interface DiveLogEntry {
  kind: "fast-ascent" | "ceiling-violation" | "safety-stop-skipped";
  elapsedTimeS: Seconds;
  value: number;
}

/**
 * The rule of thirds (#199), legacy's gas plan under an overhead (Issue #27):
 * the gas carried when the diver went under it, the turn third's latch (one
 * beep per penetration), and whether the reserve third was ever reached on
 * this dive, which gradeDive() reads. Leaving the overhead clears the first
 * two; the reserve latch stays for the dive.
 */
export interface RuleOfThirdsState {
  /** All cylinders' gas on entering the overhead; 0 outside one. */
  startingGasL: Litres;
  turnWarned: boolean;
  reserveHit: boolean;
}

export function createRuleOfThirdsState(): RuleOfThirdsState {
  return { startingGasL: litres(0), turnWarned: false, reserveHit: false };
}

/**
 * One point of the depth profile (#199), legacy's diveProfile entry: taken
 * every 2 dive seconds, with the ceiling of the step before it.
 */
export interface DiveProfileSample {
  elapsedTimeS: Seconds;
  depthM: Metres;
  ceilingM: Metres;
}

/**
 * The dive log (#199): what legacy's updateDiving() keeps every frame for
 * the post-dive debriefing and gradeDive(), beyond the dive state itself.
 */
export interface DiveLog {
  entries: readonly DiveLogEntry[];
  /** Legacy's ascentRate: the last step's depth change, m/min, positive up. */
  ascentRateMpm: number;
  /**
   * How long the current fast ascent has lasted, and its peak. Legacy latches
   * a fired window by setting the accumulator to -Infinity until the rate
   * drops back; `fastAscentLatched` says the same in a form a save can hold.
   */
  fastAscentS: Seconds;
  fastAscentPeakMpm: number;
  fastAscentLatched: boolean;
  ceilingViolationS: Seconds;
  ceilingViolationLatched: boolean;
  /** The lowest NDL seen while submerged, whole minutes; null before any. */
  minNdlMin: number | null;
  /** Legacy's ndlDroppedBelow5, latched for the dive. */
  ndlDroppedBelowFiveMinutes: boolean;
  /**
   * The time-weighted average depth's sums, legacy's avgDepthAccum (depth
   * times dive seconds) and avgDepthSamples (dive seconds), both counted
   * only deeper than 0.5 m. The average is their quotient.
   */
  depthTimeMS: number;
  submergedS: Seconds;
  /** The depth profile, and the dive time since its last sample. */
  profile: readonly DiveProfileSample[];
  profileTimerS: Seconds;
  /**
   * The ceiling of the last step, which the next profile sample records:
   * legacy samples before it refreshes frameCalc.
   */
  lastCeilingM: Metres;
}

export function createEmptyDiveLog(): DiveLog {
  return {
    entries: [],
    ascentRateMpm: 0,
    fastAscentS: seconds(0),
    fastAscentPeakMpm: 0,
    fastAscentLatched: false,
    ceilingViolationS: seconds(0),
    ceilingViolationLatched: false,
    minNdlMin: null,
    ndlDroppedBelowFiveMinutes: false,
    depthTimeMS: 0,
    submergedS: seconds(0),
    profile: [],
    profileTimerS: seconds(0),
    lastCeilingM: metres(0),
  };
}

/**
 * The adaptive safety stop (#199), legacy's safetyStop* globals: needed once
 * the dive has gone deeper than 11 m; a countdown that starts shallower than
 * 6 m, runs inside 2.4-8.3 m and pauses outside; complete when it reaches
 * zero; and reset whenever the diver goes back below 11 m.
 */
export interface SafetyStopState {
  needed: boolean;
  countdownStarted: boolean;
  remainingS: Seconds;
  paused: boolean;
  complete: boolean;
}

export function createSafetyStopState(): SafetyStopState {
  return {
    needed: false,
    countdownStarted: false,
    remainingS: seconds(0),
    paused: false,
    complete: false,
  };
}

export interface DiveState {
  elapsedTimeS: Seconds;
  depthM: Metres;
  maxDepthM: Metres;
  tissues: TissueState;
  randomState: number;
  tanks: readonly TankState[];
  activeTankIndex: number;
  surfaceAirConsumptionLpm: LitresPerMinute;
  /**
   * CNS oxygen exposure in percent of the NOAA single-exposure limit (#186),
   * accumulated per step as legacy's updateCNS() does. Unbounded: legacy
   * lets it exceed 100 and so does this.
   */
  cnsPercent: number;
  /**
   * Vertical motion (#192), as legacy integrates it: velocity in m/min,
   * positive downwards, and the BCD gas in surface-equivalent litres.
   */
  verticalVelocityMpm: number;
  bcdGasSurfaceLiters: number;
  ccr: CcrState | null;
  failure: FailureState;
  /**
   * The dive ended at the surface (#199): legacy's switch to its post-dive
   * screen. Like a failure, it ends the dive; the model moves no further.
   */
  completed: boolean;
  thirds: RuleOfThirdsState;
  events: readonly DiveEvent[];
  log: DiveLog;
  safetyStop: SafetyStopState;
}

export interface InitialDiveOptions {
  tanks?: readonly TankState[];
  activeTankIndex?: number;
  surfaceAirConsumptionLpm?: number;
  ccr?: CcrState | null;
  bcdGasSurfaceLiters?: number;
}

export function createGasMix(
  oxygenFraction: number,
  heliumFraction: number,
): GasMix {
  const nitrogenFraction = 1 - oxygenFraction - heliumFraction;

  if (nitrogenFraction < -1e-12) {
    throw new RangeError("oxygen and helium fractions must not exceed 1");
  }

  return Object.freeze({
    oxygenFraction: fraction(oxygenFraction),
    heliumFraction: fraction(heliumFraction),
    nitrogenFraction: fraction(Math.max(0, nitrogenFraction)),
  });
}

export function createTankState(
  gas: GasMix,
  volumeL = 12,
  pressureBar = 200,
): TankState {
  return Object.freeze({
    gas,
    volumeL: litres(volumeL),
    gasRemainingL: litres(volumeL * pressureBar),
    startGasL: litres(volumeL * pressureBar),
  });
}

/**
 * The bounds the loop setpoint may take, from src/constants.js CCR_SP_MIN,
 * CCR_SP_MAX and CCR_SP_STEP. They live in the core because the in-dive
 * adjustment (#163) is a model operation, and the setup screen's controls
 * read the same three numbers rather than carrying a second copy.
 */
export const CCR_SETPOINT_MIN_BAR = 0.5;
export const CCR_SETPOINT_MAX_BAR = 1.6;
export const CCR_SETPOINT_STEP_BAR = 0.1;

/**
 * Legacy's CCR_DEFAULTS for the two rebreather values no setup screen sets,
 * legacy's or this client's: the diluent cylinder's fill and the scrubber's
 * duration. Legacy restarts the scrubber at its duration every dive, but
 * not the diluent, which one session's dives share.
 */
export const DEFAULT_DILUENT_CYLINDER_PRESSURE_BAR = bars(200);
export const DEFAULT_SCRUBBER_DURATION_S = seconds(180 * 60);

export function createCcrState(
  diluent: GasMix,
  overrides: Partial<
    Omit<CcrState, "diluent" | "onBailout" | "scrubberFailed">
  > = {},
): CcrState {
  const targetPo2Bar = overrides.targetPo2Bar ?? bars(0.7);
  const oxygenCylinderPressureBar =
    overrides.oxygenCylinderPressureBar ?? bars(200);
  const diluentCylinderPressureBar =
    overrides.diluentCylinderPressureBar ?? DEFAULT_DILUENT_CYLINDER_PRESSURE_BAR;
  const scrubberRemainingS = overrides.scrubberRemainingS ?? DEFAULT_SCRUBBER_DURATION_S;
  const po2ResponseBarPerSecond = overrides.po2ResponseBarPerSecond ?? 0.05;

  if (
    !Number.isFinite(po2ResponseBarPerSecond) ||
    po2ResponseBarPerSecond < 0
  ) {
    throw new RangeError(
      "PO2 response must be a finite non-negative number",
    );
  }

  return Object.freeze({
    targetPo2Bar,
    actualPo2Bar:
      overrides.actualPo2Bar ??
      bars(targetPo2Bar < 1 ? targetPo2Bar : 0.21),
    diluent,
    oxygenCylinderVolumeL: overrides.oxygenCylinderVolumeL ?? litres(2),
    oxygenCylinderPressureBar,
    diluentCylinderVolumeL: overrides.diluentCylinderVolumeL ?? litres(3),
    diluentCylinderPressureBar,
    oxygenCylinderStartPressureBar:
      overrides.oxygenCylinderStartPressureBar ?? oxygenCylinderPressureBar,
    diluentCylinderStartPressureBar:
      overrides.diluentCylinderStartPressureBar ?? diluentCylinderPressureBar,
    loopVolumeL: overrides.loopVolumeL ?? litres(6),
    scrubberRemainingS,
    scrubberTotalS: overrides.scrubberTotalS ?? scrubberRemainingS,
    metabolicOxygenLpm:
      overrides.metabolicOxygenLpm ?? litresPerMinute(0.8),
    po2ResponseBarPerSecond,
    onBailout: false,
    scrubberFailed: false,
    co2BuildupS: overrides.co2BuildupS ?? seconds(0),
  });
}

export function createInitialDiveState(
  seed = 0,
  options: InitialDiveOptions = {},
): DiveState {
  const tanks = options.tanks ?? [createTankState(createGasMix(0.21, 0))];
  const activeTankIndex = options.activeTankIndex ?? 0;

  if (tanks.length === 0) {
    throw new RangeError("at least one open-circuit tank is required");
  }
  if (activeTankIndex < 0 || activeTankIndex >= tanks.length) {
    throw new RangeError("active tank index is outside the tank list");
  }

  return freezeDiveState({
    elapsedTimeS: seconds(0),
    depthM: metres(0),
    maxDepthM: metres(0),
    tissues: {
      nitrogenBar: Array.from(
        { length: TISSUE_COMPARTMENT_COUNT },
        () => SURFACE_N2_LOADING_BAR,
      ),
      heliumBar: Array.from(
        { length: TISSUE_COMPARTMENT_COUNT },
        () => bars(0),
      ),
    },
    randomState: normalizeSeed(seed),
    tanks,
    activeTankIndex,
    surfaceAirConsumptionLpm: litresPerMinute(
      options.surfaceAirConsumptionLpm ?? 15,
    ),
    cnsPercent: 0,
    verticalVelocityMpm: 0,
    // Legacy sets 2 L when a dive leaves the surface (updateSurface).
    bcdGasSurfaceLiters: options.bcdGasSurfaceLiters ?? 2,
    ccr: options.ccr ?? null,
    completed: false,
    thirds: createRuleOfThirdsState(),
    failure: {
      reason: null,
      oxygenToxicityS: seconds(0),
      hypoxiaS: seconds(0),
      ccrHypoxiaS: seconds(0),
      ccrHyperoxiaS: seconds(0),
      dcsViolationS: seconds(0),
    },
    events: [],
    log: createEmptyDiveLog(),
    safetyStop: createSafetyStopState(),
  });
}

/**
 * The log lists freezeDiveState() itself has built, each element frozen
 * with it. Only these are reused: a frozen array from elsewhere may still
 * hold mutable elements (#204 Codex round 1).
 */
const frozenLogLists = new WeakSet<readonly object[]>();

function freezeLogList<T extends object>(list: readonly T[]): readonly T[] {
  if (frozenLogLists.has(list)) {
    return list;
  }
  const frozen = Object.freeze(list.map((item) => Object.freeze({ ...item })));
  frozenLogLists.add(frozen);
  return frozen;
}

export function freezeDiveState(state: DiveState): DiveState {
  const tissues = Object.freeze({
    nitrogenBar: Object.freeze([...state.tissues.nitrogenBar]),
    heliumBar: Object.freeze([...state.tissues.heliumBar]),
  });

  const tanks = Object.freeze(
    state.tanks.map((tank) =>
      Object.freeze({
        ...tank,
        gas: Object.freeze({ ...tank.gas }),
      }),
    ),
  );
  const ccr = state.ccr
    ? Object.freeze({
        ...state.ccr,
        diluent: Object.freeze({ ...state.ccr.diluent }),
      })
    : null;
  const failure = Object.freeze({ ...state.failure });
  const events = Object.freeze(
    state.events.map((event) => Object.freeze({ ...event })),
  );
  // The log's lists grow for the whole dive, so a list this function has
  // already built is reused rather than copied: re-freezing the profile on
  // every call made a frame's cost grow with the dive's length (#204
  // pre-review). Any other list, a parsed save or a caller's own, is copied
  // with its elements frozen.
  const log = Object.freeze({
    ...state.log,
    entries: freezeLogList(state.log.entries),
    profile: freezeLogList(state.log.profile),
  });

  const safetyStop = Object.freeze({ ...state.safetyStop });
  const thirds = Object.freeze({ ...state.thirds });

  return Object.freeze({
    ...state,
    tissues,
    tanks,
    ccr,
    failure,
    events,
    log,
    safetyStop,
    thirds,
  });
}
