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
}

export interface CcrState {
  targetPo2Bar: Bars;
  actualPo2Bar: Bars;
  diluent: GasMix;
  oxygenCylinderVolumeL: Litres;
  oxygenCylinderPressureBar: Bars;
  diluentCylinderVolumeL: Litres;
  diluentCylinderPressureBar: Bars;
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
  | "ccr-hypoxia"
  | "ccr-hyperoxia"
  | "ccr-co2";

export interface FailureState {
  reason: DiveFailureReason | null;
  oxygenToxicityS: Seconds;
  hypoxiaS: Seconds;
  ccrHypoxiaS: Seconds;
  ccrHyperoxiaS: Seconds;
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
 */
export interface DiveLogEntry {
  kind: "fast-ascent" | "ceiling-violation";
  elapsedTimeS: Seconds;
  value: number;
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
  events: readonly DiveEvent[];
  log: DiveLog;
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

export function createCcrState(
  diluent: GasMix,
  overrides: Partial<
    Omit<CcrState, "diluent" | "onBailout" | "scrubberFailed">
  > = {},
): CcrState {
  const targetPo2Bar = overrides.targetPo2Bar ?? bars(0.7);
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
    oxygenCylinderPressureBar:
      overrides.oxygenCylinderPressureBar ?? bars(200),
    diluentCylinderVolumeL: overrides.diluentCylinderVolumeL ?? litres(3),
    diluentCylinderPressureBar:
      overrides.diluentCylinderPressureBar ?? bars(200),
    loopVolumeL: overrides.loopVolumeL ?? litres(6),
    scrubberRemainingS: overrides.scrubberRemainingS ?? seconds(180 * 60),
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
    failure: {
      reason: null,
      oxygenToxicityS: seconds(0),
      hypoxiaS: seconds(0),
      ccrHypoxiaS: seconds(0),
      ccrHyperoxiaS: seconds(0),
    },
    events: [],
    log: createEmptyDiveLog(),
  });
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
  const log = Object.freeze({
    ...state.log,
    entries: Object.freeze(
      state.log.entries.map((entry) => Object.freeze({ ...entry })),
    ),
    profile: Object.freeze(
      state.log.profile.map((sample) => Object.freeze({ ...sample })),
    ),
  });

  return Object.freeze({ ...state, tissues, tanks, ccr, failure, events, log });
}
