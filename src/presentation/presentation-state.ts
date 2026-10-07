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
import { decoStopDepth } from "../core/decompression";
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
 * band or paused outside it, and complete once done. Absent when no stop is
 * owed, while there is a ceiling, and once the dive has ended.
 */
export interface PresentationSafetyStop {
  readonly phase: "planned" | "running" | "paused" | "complete";
  /** The nominal stop depth, the middle of the band, rounded: 5 m. */
  readonly targetDepthM: number;
  /** What is left once started; the stop's length before that; 0 once complete. */
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

/**
 * Legacy's stop box while there is a ceiling (src/renderer.js
 * drawDiveComputer, `if (inDeco)`): the DECO STOP title, and the first stop
 * of the schedule when there is one.
 */
export interface PresentationDecoStopBox {
  /**
   * The forecast's first stop, its minutes rounded up as legacy's
   * calculateDecoSchedule() rounds them. Null while no forecast with stops
   * is in hand, where legacy draws the title alone.
   */
  readonly firstStop: PresentationDecoStop | null;
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
   * src/game-loop.js `-(depth - prevDepth) / dtDiveMinutes`. 0 once the dive
   * is completed: nothing moves it any more, and legacy's post-dive state
   * draws neither the rate nor its SLOW DOWN banner.
   */
  readonly ascentRateMpm: number;
  /** The stop box while there is a ceiling; the safety stop gives way to it. */
  readonly decoStop: PresentationDecoStopBox | null;
  readonly safetyStop: PresentationSafetyStop | null;
  readonly ruleOfThirds: PresentationRuleOfThirds | null;
}

/**
 * What a forecast was computed from, and how far the dive may have moved on
 * since before it no longer describes it (#226 Codex round 2). The worker
 * answers asynchronously; legacy reads frameCalc.schedule of the same frame.
 */
export interface PlannerForecastFreshness {
  /** The dive time of the state the forecast was requested for. */
  readonly sourceElapsedTimeS: number;
  /** The depth of that state. */
  readonly sourceDepthM: number;
  /** Dive seconds the forecast may lag the state it is shown with. */
  readonly maxAgeS: number;
}

/**
 * How far the diver may have moved from the forecast's depth: the
 * scheduler asks again as the depth crosses a whole metre
 * (src/planner/forecast-scheduler.ts), so a current forecast is at most a
 * metre behind, plus what the diver moves while the worker answers.
 */
export const FORECAST_MAX_DEPTH_DRIFT_M = 1.5;

/**
 * Whether a forecast still describes the state (#226 Codex round 2): it was
 * computed from a state at most `maxAgeS` dive seconds earlier, and at most
 * FORECAST_MAX_DEPTH_DRIFT_M away. A breathed-gas change needs no check
 * here: the controller drops the forecast on it, and the answer to a request
 * made before it.
 */
export function isForecastCurrent(
  state: DiveState,
  freshness: Readonly<PlannerForecastFreshness>,
): boolean {
  const ageS = state.elapsedTimeS - freshness.sourceElapsedTimeS;
  return (
    ageS >= 0 &&
    ageS <= freshness.maxAgeS &&
    Math.abs(state.depthM - freshness.sourceDepthM) <= FORECAST_MAX_DEPTH_DRIFT_M
  );
}

export function createPresentationState(
  state: DiveState,
  planner: PlannerForecast | null,
  plannerFreshness: Readonly<PlannerForecastFreshness> | null = null,
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
    ascentRateMpm: state.completed ? 0 : state.log.ascentRateMpm,
    decoStop: selectDecoStop(state, planner, plannerFreshness),
    safetyStop: selectSafetyStop(state),
    ruleOfThirds: selectRuleOfThirds(state),
  });
}

/**
 * The stop box's decompression half (src/renderer.js drawDiveComputer):
 * shown while there is a ceiling, legacy's `inDeco = decoStop(ceiling) > 0`.
 *
 * - The ceiling is the model's log.lastCeilingM, legacy's frameCalc.ceiling
 *   of the same tick at the dive's GF high, as selectSafetyStop reads it.
 * - The first stop's depth and minutes are the forecast's: legacy's
 *   frameCalc.schedule, which the worker computes here, asynchronously.
 *   They are shown only while the forecast is current (isForecastCurrent):
 *   with no forecast with stops in hand, or one that no longer describes
 *   the dive (a request pending past its budget, or a dropped answer), the
 *   box shows its title alone, as legacy's does without a schedule.
 * - Not once the dive is completed: legacy's post-dive state draws no box.
 */
export function selectDecoStop(
  state: DiveState,
  planner: PlannerForecast | null,
  freshness: Readonly<PlannerForecastFreshness> | null = null,
): PresentationDecoStopBox | null {
  if (state.completed || !(state.log.lastCeilingM > 0)) {
    return null;
  }
  const current = freshness !== null && isForecastCurrent(state, freshness);
  const scheduled = current ? planner?.schedule?.stops[0] : undefined;
  // The schedule's first stop is decoStop() of the GF-high ceiling it was
  // computed from: legacy's `firstStop = decoStop(ceilDepth)` with
  // frameCalc.ceiling (src/physics.js calculateDecoSchedule, 350-366), and
  // the planner's `decoStopDepth(ceilingM)` (src/planner/dive-planner.ts
  // 175). The model's lastCeilingM is the same ceilingDepthM at the same GF
  // high, rounded by the same decoStopDepth, so a forecast that names
  // another stop than this tick's describes a state the dive has left.
  const first =
    scheduled !== undefined &&
    scheduled.depthM === decoStopDepth(state.log.lastCeilingM)
      ? scheduled
      : undefined;
  return Object.freeze({
    firstStop: first
      ? Object.freeze({ depthM: first.depthM, durationMin: first.durationMin })
      : null,
  });
}

/** legacy's ssTargetD: the middle of the band the countdown runs in, rounded. */
export const SAFETY_STOP_TARGET_DEPTH_M = Math.round(
  (SAFETY_STOP_BAND_MIN_M + SAFETY_STOP_BAND_MAX_M) / 2,
);

/**
 * The stop box's safety-stop half (src/renderer.js drawDiveComputer):
 * shown while a stop is owed and not done, with what is left once the
 * countdown has started and the planned length before; then legacy's
 * "SAFETY STOP / Complete" until the diver goes back below 11 m, which
 * starts the stop over.
 *
 * - While there is a ceiling the box shows the decompression stop instead.
 *   Legacy decides that from frameCalc.ceiling, refreshed on the same tick,
 *   which is the model's log.lastCeilingM at the dive's GF high: not the
 *   worker's forecast, which is pending after every gas switch, setpoint
 *   change or bailout, and on a resumed dive until its first answer.
 * - Not once the dive is completed: a stop not made is logged as skipped as
 *   the dive ends (updateCompletion), and legacy's post-dive state draws no
 *   stop box.
 */
export function selectSafetyStop(state: DiveState): PresentationSafetyStop | null {
  const stop = state.safetyStop;
  if (state.completed || state.log.lastCeilingM > 0 || !stop.needed) {
    return null;
  }
  if (stop.complete) {
    return Object.freeze({
      phase: "complete",
      targetDepthM: SAFETY_STOP_TARGET_DEPTH_M,
      remainingS: 0,
    });
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
