import {
  type CcrState,
  type DiveEvent,
  type DiveFailureReason,
  type DiveState,
  type GasMix,
} from "../core/dive-state";
import {
  SAFETY_STOP_BAND_MAX_M,
  SAFETY_STOP_BAND_MIN_M,
  THIRDS_RESERVE_FRACTION,
  THIRDS_TURN_FRACTION,
  resolveInspiredGas,
  safetyStopDurationS,
} from "../core/dive-model";
import { bars, type Bars, type Litres } from "../core/units";
import {
  compartmentSaturation,
  leadingGradientFactorPercent,
  maximumOperatingDepthM,
  type PlannerForecast,
} from "../planner/dive-planner";

export type DiveStatus = "surface" | "diving" | "failed";

export interface PresentationTank {
  readonly index: number;
  readonly gas: Readonly<GasMix>;
  readonly volumeL: Litres;
  readonly gasRemainingL: Litres;
  readonly pressureBar: Bars;
  readonly active: boolean;
  /**
   * Maximum operating depth at 1.6 bar, computed on demand (#163). Null for
   * a mix without oxygen, which has none.
   */
  readonly modM: number | null;
}

/**
 * The tissue figures legacy's gas-info pages draw (#163): each
 * compartment's loading as a fraction of its M-value at the current depth,
 * the leading gradient factor there (GF99), and at the surface (SrfGF).
 */
export interface PresentationSaturation {
  readonly mValueRatios: readonly number[];
  readonly gf99Percent: number;
  readonly surfaceGfPercent: number;
}

/**
 * The safety stop as legacy's stop box draws it (#199, src/renderer.js
 * drawDiveComputer): planned until the countdown starts, then running in its
 * band or paused outside it. Absent when no stop is owed.
 */
export interface PresentationSafetyStop {
  readonly phase: "planned" | "running" | "paused";
  /** The nominal stop depth, the middle of the band, rounded: 5 m. */
  readonly targetDepthM: number;
  /** What is left once started; the stop's length before that. */
  readonly remainingS: number;
}

export type RuleOfThirdsPhase = "outbound" | "turn" | "reserve";

/**
 * Legacy's rule-of-thirds gauge (#199, Issue #27, hud-thirds): the phase and
 * the gas left against the plan made on entering the overhead. Absent
 * outside one.
 */
export interface PresentationRuleOfThirds {
  readonly phase: RuleOfThirdsPhase;
  readonly percent: number;
  /** Latched on reaching the turn; legacy beeps once as it latches. */
  readonly turnWarned: boolean;
}

export interface PresentationDecoStop {
  readonly depthM: number;
  readonly durationMin: number;
}

export interface PresentationDecoSchedule {
  readonly stops: readonly PresentationDecoStop[];
  readonly ttsMin: number;
  readonly outOfGas: boolean;
}

export interface PresentationPlannerForecast {
  readonly ceilingM: number;
  readonly ndlMin: number;
  readonly schedule: PresentationDecoSchedule | null;
  readonly ttsMin: number;
}

export interface PresentationCcr {
  readonly diluent: Readonly<GasMix>;
  readonly oxygenCylinderVolumeL: Litres;
  readonly diluentCylinderVolumeL: Litres;
  readonly targetPo2Bar: Bars;
  readonly actualPo2Bar: Bars;
  readonly oxygenCylinderPressureBar: Bars;
  readonly diluentCylinderPressureBar: Bars;
  readonly scrubberRemainingS: number;
  readonly onBailout: boolean;
  readonly scrubberFailed: boolean;
}

export interface PresentationState {
  readonly elapsedTimeS: number;
  readonly depthM: number;
  readonly maxDepthM: number;
  readonly status: DiveStatus;
  readonly activeTankIndex: number;
  readonly tanks: readonly PresentationTank[];
  readonly ccr: PresentationCcr | null;
  readonly breathingPo2Bar: Bars;
  readonly failureReason: DiveFailureReason | null;
  /** The dive ended at the surface (#199): the post-dive screen follows (#159). */
  readonly completed: boolean;
  readonly events: readonly Readonly<DiveEvent>[];
  readonly planner: PresentationPlannerForecast | null;
  readonly saturation: PresentationSaturation;
  /** CNS oxygen exposure in percent (#186). */
  readonly cnsPercent: number;
  /**
   * Legacy's ascentRate over the last frame, in m/min, positive up (#197):
   * src/game-loop.js `-(depth - prevDepth) / dtDiveMinutes`.
   */
  readonly ascentRateMpm: number;
  readonly safetyStop: PresentationSafetyStop | null;
  readonly ruleOfThirds: PresentationRuleOfThirds | null;
}

export function createPresentationState(
  state: DiveState,
  planner: PlannerForecast | null,
): PresentationState {
  const tanks = Object.freeze(
    state.tanks.map((tank, index) =>
      Object.freeze({
        index,
        gas: Object.freeze({ ...tank.gas }),
        volumeL: tank.volumeL,
        gasRemainingL: tank.gasRemainingL,
        pressureBar: selectTankPressureBar(state, index),
        active: index === state.activeTankIndex,
        modM: maximumOperatingDepthM(tank.gas.oxygenFraction),
      }),
    ),
  );
  const ccr = state.ccr ? freezePresentationCcr(state.ccr) : null;
  const events = Object.freeze(
    state.events.map((event) => Object.freeze({ ...event })),
  );

  return Object.freeze({
    elapsedTimeS: state.elapsedTimeS,
    depthM: state.depthM,
    maxDepthM: state.maxDepthM,
    status: selectDiveStatus(state),
    activeTankIndex: state.activeTankIndex,
    tanks,
    ccr,
    breathingPo2Bar: selectBreathingPo2Bar(state),
    failureReason: state.failure.reason,
    completed: state.completed,
    events,
    planner: planner ? freezePlannerForecast(planner) : null,
    saturation: selectSaturation(state),
    cnsPercent: state.cnsPercent,
    ascentRateMpm: state.log.ascentRateMpm,
    safetyStop: selectSafetyStop(state),
    ruleOfThirds: selectRuleOfThirds(state),
  });
}

/** legacy's ssTargetD: the middle of the band the countdown runs in, rounded. */
export const SAFETY_STOP_TARGET_DEPTH_M = Math.round(
  (SAFETY_STOP_BAND_MIN_M + SAFETY_STOP_BAND_MAX_M) / 2,
);

/**
 * The stop box's safety-stop half (src/renderer.js drawDiveComputer):
 * shown while a stop is owed and not done, with what is left once the
 * countdown has started and the planned length before.
 */
export function selectSafetyStop(state: DiveState): PresentationSafetyStop | null {
  const stop = state.safetyStop;
  if (!stop.needed || stop.complete) {
    return null;
  }
  return Object.freeze({
    phase: !stop.countdownStarted ? "planned" : stop.paused ? "paused" : "running",
    targetDepthM: SAFETY_STOP_TARGET_DEPTH_M,
    remainingS: stop.countdownStarted ? stop.remainingS : safetyStopDurationS(state),
  });
}

/**
 * Legacy's thirdsCurrentPhase and thirdsPct (src/game-loop.js, Issue #27):
 * all cylinders' gas against the plan made on entering the overhead. The
 * model keeps the plan only while the diver is under one.
 */
export function selectRuleOfThirds(state: DiveState): PresentationRuleOfThirds | null {
  const { startingGasL, turnWarned } = state.thirds;
  if (!(startingGasL > 0)) {
    return null;
  }
  const gasL = state.tanks.reduce((sum, tank) => sum + tank.gasRemainingL, 0);
  const fraction = Math.min(1, Math.max(0, gasL / startingGasL));
  return Object.freeze({
    phase:
      fraction > THIRDS_TURN_FRACTION
        ? "outbound"
        : fraction > THIRDS_RESERVE_FRACTION
          ? "turn"
          : "reserve",
    percent: Math.round(fraction * 100),
    turnWarned,
  });
}

export function selectSaturation(state: DiveState): PresentationSaturation {
  const ambientBar = 1 + state.depthM / 10;
  return Object.freeze({
    mValueRatios: Object.freeze(
      compartmentSaturation(state.tissues, ambientBar).map(
        (compartment) => compartment.mValueRatio,
      ),
    ),
    gf99Percent: leadingGradientFactorPercent(state.tissues, ambientBar),
    surfaceGfPercent: leadingGradientFactorPercent(state.tissues, 1),
  });
}

export function selectDiveStatus(state: DiveState): DiveStatus {
  if (state.failure.reason !== null) {
    return "failed";
  }
  return state.depthM < 0.5 ? "surface" : "diving";
}

export function selectTankPressureBar(
  state: DiveState,
  tankIndex: number,
): Bars {
  const tank = state.tanks[tankIndex];
  if (!tank) {
    throw new RangeError("tank index is outside the tank list");
  }
  return bars(tank.gasRemainingL / tank.volumeL);
}

export function selectBreathingPo2Bar(state: DiveState): Bars {
  const inspiredGas = resolveInspiredGas(
    state.ccr && !state.ccr.onBailout
      ? {
          kind: "ccr",
          actualPo2Bar: state.ccr.actualPo2Bar,
          diluent: state.ccr.diluent,
          onBailout: false,
        }
      : {
          kind: "open-circuit",
          gas:
            state.ccr?.onBailout
              ? state.ccr.diluent
              : state.tanks[state.activeTankIndex]?.gas ??
                state.tanks[0]!.gas,
        },
    state.depthM,
  );
  return bars(inspiredGas.oxygenFraction * (1 + state.depthM / 10));
}

function freezePresentationCcr(ccr: CcrState): PresentationCcr {
  return Object.freeze({
    diluent: Object.freeze({ ...ccr.diluent }),
    oxygenCylinderVolumeL: ccr.oxygenCylinderVolumeL,
    diluentCylinderVolumeL: ccr.diluentCylinderVolumeL,
    targetPo2Bar: ccr.targetPo2Bar,
    actualPo2Bar: ccr.actualPo2Bar,
    oxygenCylinderPressureBar: ccr.oxygenCylinderPressureBar,
    diluentCylinderPressureBar: ccr.diluentCylinderPressureBar,
    scrubberRemainingS: ccr.scrubberRemainingS,
    onBailout: ccr.onBailout,
    scrubberFailed: ccr.scrubberFailed,
  });
}

function freezePlannerForecast(
  forecast: PlannerForecast,
): PresentationPlannerForecast {
  const schedule = forecast.schedule
    ? freezeDecoSchedule(forecast.schedule)
    : null;
  return Object.freeze({ ...forecast, schedule });
}

function freezeDecoSchedule(
  schedule: NonNullable<PlannerForecast["schedule"]>,
): PresentationDecoSchedule {
  return Object.freeze({
    ...schedule,
    stops: Object.freeze(
      schedule.stops.map((stop) => Object.freeze({ ...stop })),
    ),
  });
}
