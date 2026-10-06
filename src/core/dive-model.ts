import {
  LN_2,
  TISSUE_COMPARTMENT_COUNT,
  WATER_VAPOR_PRESSURE_BAR,
  ZHL16C_HE,
  ZHL16C_N2,
  asTissuePressure,
} from "./buhlmann-constants";
import {
  CCR_SETPOINT_MAX_BAR,
  CCR_SETPOINT_MIN_BAR,
  freezeDiveState,
  type BreathingSource,
  type CcrState,
  type DiveEvent,
  type DiveFailureReason,
  type DiveProfileSample,
  type RuleOfThirdsState,
  type SafetyStopState,
  type DiveState,
  type GasMix,
} from "./dive-state";
import { NO_INPUT, type InputIntent } from "./inputs";
import {
  applyBcdControls,
  integrateBuoyancy,
  type BuoyancyControls,
  type VerticalBounds,
} from "./buoyancy";
import {
  DEFAULT_GF_HIGH_PERCENT,
  ceilingDepthM,
  decoStopDepth,
  ndlMinutes,
} from "./decompression";
import {
  bars,
  fraction,
  litres,
  metres,
  seconds,
  secondsToMinutes,
  type Bars,
  type Metres,
  type Seconds,
} from "./units";

export const FIXED_STEP_SECONDS = seconds(1);
export const PO2_HYPOXIA_BAR = bars(0.16);
export const PO2_HIGH_BAR = bars(1.6);
export const OXYGEN_TOXICITY_FAILURE_SECONDS = seconds(30);
export const CCR_HYPOXIA_FAILURE_SECONDS = seconds(30);
export const CCR_HYPEROXIA_FAILURE_SECONDS = seconds(30);
export const CCR_CO2_FAILURE_SECONDS = seconds(180);
// Legacy's DCS_VIOLATION_TIME, and its surfacing check in updateDiving():
// shallower than 0.5 m with a ceiling deeper than 3 m (#199).
export const DCS_VIOLATION_FAILURE_SECONDS = seconds(60);
export const SURFACE_DCS_DEPTH_M = 0.5;
export const SURFACE_DCS_CEILING_M = 3;
// Legacy's BAROTRAUMA_RATE and BAROTRAUMA_TIME (#189): an ascent at 18 m/min
// or faster, held for 10 dive seconds, ends the dive.
export const BAROTRAUMA_ASCENT_RATE_MPM = 18;
export const BAROTRAUMA_FAILURE_SECONDS = seconds(10);
// Legacy's end of a dive at the surface: shallower than 0.3 m after more
// than half a dive minute, the ceiling cleared to 0.1 m, the dive deeper
// than 2 m (#199).
export const SURFACED_DEPTH_M = 0.3;
// src/constants.js THIRDS_TURN_FRACTION and THIRDS_RESERVE_FRACTION: more
// than two thirds left is outbound, more than one third the turn, the rest
// the reserve.
export const THIRDS_TURN_FRACTION = 2 / 3;
export const THIRDS_RESERVE_FRACTION = 1 / 3;
export const COMPLETION_MIN_ELAPSED_S = seconds(30);
export const COMPLETION_MAX_CEILING_M = 0.1;
export const COMPLETION_MIN_MAX_DEPTH_M = 2;

/** A failed or completed dive: nothing moves it any more. */
export function isDiveOver(state: DiveState): boolean {
  return state.failure.reason !== null || state.completed;
}

export interface DiveEnvironment {
  depthM: Metres;
  breathing?: BreathingSource;
  exertionMultiplier?: number;
  /**
   * The GF high the dive log's ceiling and NDL are evaluated at (#199), as
   * legacy's frameCalc uses gfHigh. DEFAULT_GF_HIGH_PERCENT when absent.
   */
  gradientFactorHighPercent?: number;
  /**
   * The diver is under an overhead (#199), legacy's inOverhead from
   * overheadAt(): no straight way up. The rule of thirds runs only here.
   * False when absent.
   */
  inOverhead?: boolean;
}

/** src/constants.js FAST_ASCENT_RATE and FAST_ASCENT_EVENT_SEC. */
export const FAST_ASCENT_RATE_MPM = 9;
export const FAST_ASCENT_WINDOW_S = seconds(2);
/** src/constants.js CEILING_VIOLATION_TOL_M and CEILING_VIOLATION_EVENT_SEC. */
export const CEILING_VIOLATION_TOLERANCE_M = 0.3;
export const CEILING_VIOLATION_WINDOW_S = seconds(2);
/** Legacy tracks the NDL and the average depth only deeper than 0.5 m. */
export const SUBMERGED_DEPTH_M = 0.5;
/** src/game-loop.js: one depth profile sample every 2 dive seconds. */
export const PROFILE_SAMPLE_INTERVAL_S = seconds(2);

/**
 * The adaptive safety stop's thresholds (#199): src/game-loop.js updateDiving,
 * src/physics.js calculateSafetyStopDuration and src/constants.js
 * SAFETY_STOP_ACTIVE_MIN_D / MAX_D.
 */
export const SAFETY_STOP_NEEDED_BELOW_M = 11;
export const SAFETY_STOP_STARTS_ABOVE_M = 6;
export const SAFETY_STOP_BAND_MIN_M = 2.4;
export const SAFETY_STOP_BAND_MAX_M = 8.3;
export const SAFETY_STOP_SHORT_S = seconds(3 * 60);
export const SAFETY_STOP_LONG_S = seconds(5 * 60);
/** A dive deeper than this, or one whose NDL fell below 5, gets the long stop. */
export const SAFETY_STOP_LONG_BELOW_M = 30;

/** legacy calculateSafetyStopDuration(), read when the countdown starts. */
export function safetyStopDurationS(state: DiveState): Seconds {
  return state.maxDepthM > SAFETY_STOP_LONG_BELOW_M ||
    state.log.ndlDroppedBelowFiveMinutes
    ? SAFETY_STOP_LONG_S
    : SAFETY_STOP_SHORT_S;
}

/** Whether a depth is inside the band the countdown runs in. */
export function isInSafetyStopBand(depthM: number): boolean {
  return depthM >= SAFETY_STOP_BAND_MIN_M && depthM <= SAFETY_STOP_BAND_MAX_M;
}

/**
 * Legacy's atSafetyStop, one half of canFastForward: a countdown under way,
 * not complete, with the diver inside its band.
 */
export function isAtSafetyStop(state: DiveState): boolean {
  const stop = state.safetyStop;
  return stop.countdownStarted && !stop.complete && isInSafetyStopBand(state.depthM);
}

export interface DiveModelOptions {
  /** The dive's GF high, for the log's ceiling and NDL (#199). */
  readonly gradientFactorHighPercent?: number;
}

export class DiveModel {
  #state: DiveState;

  readonly #gradientFactorHighPercent: number;

  constructor(initialState: DiveState, options: Readonly<DiveModelOptions> = {}) {
    this.#state = freezeDiveState(initialState);
    this.#gradientFactorHighPercent =
      options.gradientFactorHighPercent ?? DEFAULT_GF_HIGH_PERCENT;
  }

  get snapshot(): DiveState {
    return this.#state;
  }

  advance(
    environment: DiveEnvironment,
    elapsedS: Seconds,
    intent: Readonly<InputIntent> = NO_INPUT,
  ): DiveState {
    let remainingS = elapsedS;
    let pendingIntent = intent;

    while (remainingS > 0 && !isDiveOver(this.#state)) {
      const stepS = seconds(Math.min(remainingS, FIXED_STEP_SECONDS));
      this.#state = advanceDiveStep(
        this.#state,
        {
          gradientFactorHighPercent: this.#gradientFactorHighPercent,
          ...environment,
        },
        stepS,
        pendingIntent,
      );
      pendingIntent = NO_INPUT;
      remainingS = seconds(Math.max(0, remainingS - stepS));
    }

    return this.#state;
  }

  /**
   * Advances the dive by one display frame with the depth produced by
   * buoyancy (#192), instead of a depth the caller dictates.
   *
   * One call is one legacy frame, in legacy's order within updateDiving():
   * the BCD is inflated or vented for the whole frame at the current depth
   * (inflateBCD / ventBCD), the physics moves the diver within the bounds in
   * 0.1 s sub-steps, and the rest of the frame (tissues, CNS, gas, failures)
   * runs once at the depth the physics left, as legacy's updateTissues()
   * reads the depth after updateBuoyancyPhysics(). A failed dive does not
   * move.
   *
   * The frame boundaries are part of the behaviour: the controls are applied
   * once per frame, so a frame cannot be split or merged without changing
   * the result (#193 review). The caller passes each display frame's dive
   * time and caps it as legacy's gameLoop() does: 0.1 s real, times the
   * time acceleration.
   */
  advanceWithBuoyancy(
    bounds: Readonly<VerticalBounds>,
    frameS: Seconds,
    controls: Readonly<BuoyancyControls>,
    inOverhead = false,
  ): DiveState {
    if (frameS <= 0 || isDiveOver(this.#state)) {
      return this.#state;
    }
    const inflated = applyBcdControls(this.#state, controls, frameS);
    const moved = integrateBuoyancy(inflated, bounds, frameS);
    const withMotion = freezeDiveState({
      ...inflated,
      verticalVelocityMpm: moved.verticalVelocityMpm,
      bcdGasSurfaceLiters: moved.bcdGasSurfaceLiters,
    });
    this.#state = advanceDiveStep(
      withMotion,
      {
        depthM: metres(moved.depthM),
        gradientFactorHighPercent: this.#gradientFactorHighPercent,
        inOverhead,
      },
      frameS,
    );
    return this.#state;
  }

  /**
   * Switches the breathed cylinder now, outside the time step (#163 review).
   *
   * A gas switch is a discrete act, not a level to sample. Carrying it in the
   * intent meant holding it somewhere until the next whole-second step, and
   * the client held it in a single slot — so a second press before that step
   * overwrote the first, and pressing 2 and then an out-of-range 6 lost the
   * valid switch entirely. A queue would have kept both, but then two presses
   * inside one second would emit two gas-switch events where legacy produces
   * one transition.
   *
   * Legacy applies the switch in the frame the key is read
   * (src/game-loop.js TASK-019), so this does too and nothing is held
   * anywhere. The refusal rules are untouched: applyGasSwitchIntent still
   * decides, and a dive that has already failed does not switch at all, as
   * advanceDiveStep would also refuse.
   */
  switchGas(requestedIndex: number): DiveState {
    if (isDiveOver(this.#state)) {
      return this.#state;
    }
    this.#state = applyGasSwitchIntent(this.#state, requestedIndex);
    return this.#state;
  }

  /**
   * Moves the loop setpoint, now, outside the time step (#163).
   *
   * src/game-loop.js updateDiving: `ccrState.targetSP = Math.max(CCR_SP_MIN,
   * +(ccrState.targetSP - CCR_SP_STEP).toFixed(1))` and the mirror for `]`,
   * both only while `diveMode === 'ccr' && !ccrState.onBailout`. A discrete
   * act, applied when pressed for the same reason switchGas is. The setpoint
   * is not an event: legacy records none, and the parity trace compares the
   * ccr.targetPO2_bar field at checkpoints instead.
   */
  adjustSetpoint(deltaBar: number): DiveState {
    if (isDiveOver(this.#state)) {
      return this.#state;
    }
    this.#state = applySetpointAdjustment(this.#state, deltaBar);
    return this.#state;
  }

  /**
   * Bails out to open circuit, now, outside the time step (#163).
   *
   * src/game-loop.js TASK-032F: `if (keys['b']) { ccrState.onBailout = true }`
   * while `diveMode === 'ccr' && !ccrState.onBailout`. Irreversible by
   * construction — there is no operation that clears onBailout — and
   * confirmed by the state rather than by a dialog (#67). Same rules as the
   * intent path through advance(), which stays for traces that carry the
   * intent; a second call is a no-op and adds no second event.
   */
  bailOut(): DiveState {
    if (isDiveOver(this.#state)) {
      return this.#state;
    }
    this.#state = applyBailoutIntent(this.#state, true);
    return this.#state;
  }
}

export function advanceTissues(
  state: DiveState,
  environment: DiveEnvironment,
  elapsedS: Seconds,
): DiveState {
  const elapsedMin = secondsToMinutes(elapsedS);
  const ambientPressureBar = 1 + environment.depthM / 10;
  const inspiredGas = resolveInspiredGas(
    environment.breathing ?? breathingSourceForState(state),
    environment.depthM,
  );
  const inspiredN2Bar =
    (ambientPressureBar - WATER_VAPOR_PRESSURE_BAR) *
    inspiredGas.nitrogenFraction;
  const inspiredHeBar =
    (ambientPressureBar - WATER_VAPOR_PRESSURE_BAR) *
    inspiredGas.heliumFraction;
  const nitrogenBar: Bars[] = [];
  const heliumBar: Bars[] = [];

  for (let index = 0; index < TISSUE_COMPARTMENT_COUNT; index += 1) {
    const currentN2 = state.tissues.nitrogenBar[index];
    const currentHe = state.tissues.heliumBar[index];
    const n2Compartment = ZHL16C_N2[index];
    const heCompartment = ZHL16C_HE[index];

    if (
      currentN2 === undefined ||
      currentHe === undefined ||
      n2Compartment === undefined ||
      heCompartment === undefined
    ) {
      throw new RangeError("DiveState must contain all 16 tissue compartments");
    }

    const n2Decay = Math.exp(-(LN_2 / n2Compartment.halfTimeMin) * elapsedMin);
    const heDecay = Math.exp(-(LN_2 / heCompartment.halfTimeMin) * elapsedMin);
    nitrogenBar[index] = asTissuePressure(
      inspiredN2Bar + (currentN2 - inspiredN2Bar) * n2Decay,
    );
    heliumBar[index] = asTissuePressure(
      inspiredHeBar + (currentHe - inspiredHeBar) * heDecay,
    );
  }

  return freezeDiveState({
    ...state,
    elapsedTimeS: seconds(state.elapsedTimeS + elapsedS),
    depthM: environment.depthM,
    maxDepthM: metres(Math.max(state.maxDepthM, environment.depthM)),
    tissues: { nitrogenBar, heliumBar },
  });
}

export function advanceDiveStep(
  state: DiveState,
  environment: DiveEnvironment,
  elapsedS: Seconds,
  intent: Readonly<InputIntent> = NO_INPUT,
): DiveState {
  if (isDiveOver(state) || elapsedS === 0) {
    return state;
  }

  const previousDepthM = state.depthM;
  let nextState = applyGasSwitchIntent(state, intent.switchGasIndex);
  nextState = applyCcrDiluentOnDescent(
    nextState,
    previousDepthM,
    environment.depthM,
  );
  const breathing = environment.breathing ?? breathingSourceForState(nextState);

  nextState = advanceTissues(
    nextState,
    { ...environment, breathing },
    elapsedS,
  );
  // Legacy refreshes frameCalc right after updateTissues(), before the
  // frame's gas use, and its log reads that frameCalc.
  const limits = decompressionLimits(
    nextState,
    environment.gradientFactorHighPercent ?? DEFAULT_GF_HIGH_PERCENT,
  );
  nextState = accumulateCns(nextState, breathing, environment.depthM, elapsedS);
  // Legacy's rule of thirds runs after updateCNS(), before the tick's gas
  // use and before any check can end the dive.
  nextState = updateRuleOfThirds(nextState, environment.inOverhead ?? false);
  nextState = updateLifeSupport(
    nextState,
    environment,
    previousDepthM,
    elapsedS,
  );
  nextState = applyBailoutIntent(nextState, intent.bailout);

  const settled = updateFailureState(
    nextState,
    elapsedS,
    environment.breathing ?? breathingSourceForState(nextState),
    limits,
    stepAscentRateMpm(nextState, previousDepthM, elapsedS),
  );
  // Legacy's rebreather checks run in updateCCR() and return from
  // updateDiving() before the debriefing capture; its other dive-ending
  // checks come after it (#201 Codex round 1). The ascent rate is computed
  // with the physics, before either, so it still moves on that step. The log
  // reads nothing the failure update changes, so applying it afterwards is
  // the same step.
  const withMotion = recordMotion(settled, previousDepthM, elapsedS, limits);
  if (
    settled.failure.reason !== null &&
    FAILURES_BEFORE_THE_LOG.has(settled.failure.reason)
  ) {
    return withMotion;
  }
  const logged = updateSafetyStop(updateDiveLog(withMotion, elapsedS, limits), elapsedS);
  return settled.failure.reason === null ? updateCompletion(logged, limits) : logged;
}

/**
 * Legacy's last check in updateDiving(), after every failure: back at the
 * surface with the ceiling cleared, a real dive ends, and a safety stop that
 * was needed and not done is logged as skipped, once, at that moment.
 */
function updateCompletion(state: DiveState, limits: DecompressionLimits): DiveState {
  if (
    !(state.depthM < SURFACED_DEPTH_M) ||
    !(state.elapsedTimeS > COMPLETION_MIN_ELAPSED_S) ||
    !(limits.ceilingM <= COMPLETION_MAX_CEILING_M) ||
    !(state.maxDepthM > COMPLETION_MIN_MAX_DEPTH_M)
  ) {
    return state;
  }
  const skipped = state.safetyStop.needed && !state.safetyStop.complete;
  return freezeDiveState({
    ...state,
    completed: true,
    log: skipped
      ? {
          ...state.log,
          entries: [
            ...state.log.entries,
            { kind: "safety-stop-skipped", elapsedTimeS: state.elapsedTimeS, value: 0 },
          ],
        }
      : state.log,
  });
}

/**
 * Legacy's rule of thirds (#199, Issue #27 in src/game-loop.js): on going
 * under an overhead, all cylinders' gas is the plan's whole; each step the
 * gas left against it is outbound, turn (latching the beep) or reserve
 * (latching the reserve for the dive). Out from under it, the plan and the
 * turn latch clear, so the next penetration plans from the gas left then.
 */
function updateRuleOfThirds(state: DiveState, inOverhead: boolean): DiveState {
  const thirds = state.thirds;
  if (!inOverhead) {
    return thirds.startingGasL > 0
      ? freezeDiveState({
          ...state,
          thirds: { ...thirds, startingGasL: litres(0), turnWarned: false },
        })
      : state;
  }
  const gasL = state.tanks.reduce((sum, tank) => sum + tank.gasRemainingL, 0);
  const startingGasL = thirds.startingGasL > 0 ? thirds.startingGasL : gasL;
  const fraction = startingGasL > 0 ? Math.min(1, Math.max(0, gasL / startingGasL)) : 0;
  const next: RuleOfThirdsState =
    fraction > THIRDS_TURN_FRACTION
      ? { ...thirds, startingGasL: litres(startingGasL) }
      : fraction > THIRDS_RESERVE_FRACTION
        ? { ...thirds, startingGasL: litres(startingGasL), turnWarned: true }
        : { ...thirds, startingGasL: litres(startingGasL), reserveHit: true };
  return freezeDiveState({ ...state, thirds: next });
}

/**
 * Legacy's adaptive safety stop (#199), which updateDiving() runs right after
 * ndlDroppedBelow5, in the part a rebreather failure returns before. It reads
 * the step's depth, its deepest point and the below-five latch.
 */
function updateSafetyStop(state: DiveState, elapsedS: Seconds): DiveState {
  let stop: SafetyStopState = { ...state.safetyStop };
  if (state.maxDepthM > SAFETY_STOP_NEEDED_BELOW_M) {
    stop.needed = true;
  }
  // Back below 11 m, the stop starts over, even one already completed (#90).
  if (state.depthM > SAFETY_STOP_NEEDED_BELOW_M) {
    stop = {
      ...stop,
      countdownStarted: false,
      remainingS: seconds(0),
      paused: false,
      complete: false,
    };
  }
  if (stop.needed && !stop.complete) {
    if (
      !stop.countdownStarted &&
      state.depthM > 0 &&
      state.depthM < SAFETY_STOP_STARTS_ABOVE_M
    ) {
      stop = {
        ...stop,
        countdownStarted: true,
        remainingS: safetyStopDurationS(state),
        paused: false,
      };
    }
    if (stop.countdownStarted) {
      if (isInSafetyStopBand(state.depthM)) {
        const remainingS = stop.remainingS - elapsedS;
        stop =
          remainingS <= 0
            ? { ...stop, paused: false, remainingS: seconds(0), complete: true }
            : { ...stop, paused: false, remainingS: seconds(remainingS) };
      } else {
        stop = { ...stop, paused: true };
      }
    }
  }
  return freezeDiveState({ ...state, safetyStop: stop });
}

/**
 * What legacy records with the physics, before any check can end the dive:
 * the ascent rate, the time-weighted average depth, and a depth profile
 * sample for every 2 dive seconds the step crossed, each with the ceiling of
 * the step before. Then the step's own ceiling, which frameCalc holds after
 * updateTissues(), becomes the one the next sample records.
 */
function recordMotion(
  state: DiveState,
  previousDepthM: number,
  elapsedS: Seconds,
  limits: DecompressionLimits,
): DiveState {
  const log = state.log;
  const submerged = state.depthM > SUBMERGED_DEPTH_M;
  // Copied only on a step that samples, once per 2 dive seconds, not every
  // frame (#204 pre-review).
  let profile: readonly DiveProfileSample[] = log.profile;
  let profileTimerS: number = log.profileTimerS + elapsedS;
  while (profileTimerS >= PROFILE_SAMPLE_INTERVAL_S) {
    profileTimerS -= PROFILE_SAMPLE_INTERVAL_S;
    profile = [
      ...profile,
      {
        elapsedTimeS: seconds(state.elapsedTimeS - profileTimerS),
        depthM: state.depthM,
        ceilingM: log.lastCeilingM,
      },
    ];
  }
  return freezeDiveState({
    ...state,
    log: {
      ...log,
      ascentRateMpm: stepAscentRateMpm(state, previousDepthM, elapsedS),
      depthTimeMS: submerged ? log.depthTimeMS + state.depthM * elapsedS : log.depthTimeMS,
      submergedS: submerged ? seconds(log.submergedS + elapsedS) : log.submergedS,
      profile,
      profileTimerS: seconds(profileTimerS),
      lastCeilingM: metres(limits.ceilingM),
    },
  });
}

/** The failures legacy detects in updateCCR(), before the "Issue #44" capture. */
export const FAILURES_BEFORE_THE_LOG: ReadonlySet<DiveFailureReason> = new Set([
  "ccr-hypoxia",
  "ccr-hyperoxia",
  "ccr-co2",
]);

interface DecompressionLimits {
  readonly ceilingM: number;
  readonly ndlMin: number;
}

/**
 * The gas the decompression limits are evaluated on: legacy's calculateNDL()
 * breathes the loop at the target setpoint on a rebreather, the diluent after
 * a bailout, and the active cylinder on open circuit. The planner's forecast
 * starts from the same gas.
 */
export function decompressionGas(state: DiveState): GasMix {
  if (state.ccr && !state.ccr.onBailout) {
    return resolveInspiredGas(
      {
        kind: "ccr",
        actualPo2Bar: state.ccr.targetPo2Bar,
        diluent: state.ccr.diluent,
        onBailout: false,
      },
      state.depthM,
    );
  }
  if (state.ccr?.onBailout) {
    return state.ccr.diluent;
  }
  const tank = state.tanks[state.activeTankIndex];
  if (!tank) {
    throw new RangeError("active tank index is outside the tank list");
  }
  return tank.gas;
}

function decompressionLimits(
  state: DiveState,
  gradientFactorHighPercent: number,
): DecompressionLimits {
  const gradientFactor = gradientFactorHighPercent / 100;
  return {
    ceilingM: ceilingDepthM(state.tissues, gradientFactor),
    ndlMin: ndlMinutes(
      state.tissues,
      state.depthM,
      decompressionGas(state),
      gradientFactor,
    ),
  };
}

/** Legacy's ascentRate: the step's depth change in m/min, positive up. */
function stepAscentRateMpm(
  state: DiveState,
  previousDepthM: number,
  elapsedS: Seconds,
): number {
  return -(state.depthM - previousDepthM) / (elapsedS / 60);
}

/**
 * The debriefing capture of legacy's updateDiving() (#199, src/game-loop.js
 * "Issue #44"): the step's ascent rate, a fast ascent or a broken ceiling
 * held past its window, each logged once until it lapses, and the NDL
 * tracking the adaptive safety stop and the grading read.
 */
function updateDiveLog(
  state: DiveState,
  elapsedS: Seconds,
  limits: DecompressionLimits,
): DiveState {
  const log = state.log;
  const entries = [...log.entries];
  const ascentRateMpm = log.ascentRateMpm;

  let { fastAscentS, fastAscentPeakMpm, fastAscentLatched } = log;
  if (ascentRateMpm > FAST_ASCENT_RATE_MPM) {
    fastAscentPeakMpm = Math.max(fastAscentPeakMpm, ascentRateMpm);
    if (!fastAscentLatched) {
      fastAscentS = seconds(fastAscentS + elapsedS);
      if (fastAscentS >= FAST_ASCENT_WINDOW_S && fastAscentPeakMpm > 0) {
        entries.push({
          kind: "fast-ascent",
          elapsedTimeS: state.elapsedTimeS,
          value: fastAscentPeakMpm,
        });
        fastAscentLatched = true;
      }
    }
  } else {
    fastAscentS = seconds(0);
    fastAscentPeakMpm = 0;
    fastAscentLatched = false;
  }

  let { ceilingViolationS, ceilingViolationLatched } = log;
  if (
    limits.ceilingM > 0 &&
    state.depthM < limits.ceilingM - CEILING_VIOLATION_TOLERANCE_M
  ) {
    if (!ceilingViolationLatched) {
      ceilingViolationS = seconds(ceilingViolationS + elapsedS);
      if (ceilingViolationS >= CEILING_VIOLATION_WINDOW_S) {
        entries.push({
          kind: "ceiling-violation",
          elapsedTimeS: state.elapsedTimeS,
          value: limits.ceilingM - state.depthM,
        });
        ceilingViolationLatched = true;
      }
    }
  } else {
    ceilingViolationS = seconds(0);
    ceilingViolationLatched = false;
  }

  const submerged = state.depthM > SUBMERGED_DEPTH_M;
  const minNdlMin =
    submerged &&
    Number.isFinite(limits.ndlMin) &&
    (log.minNdlMin === null || limits.ndlMin < log.minNdlMin)
      ? limits.ndlMin
      : log.minNdlMin;

  return freezeDiveState({
    ...state,
    log: {
      ...log,
      entries,
      fastAscentS,
      fastAscentPeakMpm,
      fastAscentLatched,
      ceilingViolationS,
      ceilingViolationLatched,
      minNdlMin,
      ndlDroppedBelowFiveMinutes:
        log.ndlDroppedBelowFiveMinutes || (submerged && limits.ndlMin < 5),
    },
  });
}

export function breathingSourceForState(state: DiveState): BreathingSource {
  if (state.ccr && !state.ccr.onBailout) {
    return closedCircuit(state.ccr.actualPo2Bar, state.ccr.diluent);
  }
  if (state.ccr?.onBailout) {
    return openCircuit(state.ccr.diluent);
  }

  const tank = state.tanks[state.activeTankIndex];
  if (!tank) {
    throw new RangeError("active tank index is outside the tank list");
  }
  return openCircuit(tank.gas);
}

/**
 * NOAA CNS exposure rate in % per minute for an inspired PO2, from legacy's
 * updateCNS() (src/physics.js, WP-038). Each band's upper bound is
 * inclusive, as legacy's chain of `po2 <= x` comparisons.
 */
export function cnsRatePercentPerMinute(po2Bar: number): number {
  if (po2Bar <= 0.5) return 0;
  if (po2Bar <= 0.6) return 0.14;
  if (po2Bar <= 0.7) return 0.19;
  if (po2Bar <= 0.8) return 0.28;
  if (po2Bar <= 0.9) return 0.33;
  if (po2Bar <= 1.1) return 0.42;
  if (po2Bar <= 1.3) return 0.56;
  if (po2Bar <= 1.5) return 0.83;
  if (po2Bar <= 1.6) return 2.22;
  return 10;
}

/**
 * Adds one step's CNS exposure (#186).
 *
 * Legacy calls updateCNS() right after updateTissues() in the same tick,
 * on calculatePO2(): the loop PO2 on an active rebreather, otherwise the
 * breathed open-circuit gas at the tick's depth. That is the breathing
 * source this step integrated the tissues on, so the PO2 is read from it
 * here, at the step's depth, before the loop or the gas is updated.
 */
function accumulateCns(
  state: DiveState,
  breathing: BreathingSource,
  depthM: Metres,
  elapsedS: Seconds,
): DiveState {
  const po2Bar =
    breathing.kind === "ccr" && !breathing.onBailout
      ? breathing.actualPo2Bar
      : resolveInspiredGas(breathing, depthM).oxygenFraction *
        ambientPressureBar(depthM);
  const rate = cnsRatePercentPerMinute(po2Bar);
  if (rate === 0) {
    return state;
  }
  return freezeDiveState({
    ...state,
    cnsPercent: state.cnsPercent + rate * secondsToMinutes(elapsedS),
  });
}

function applyGasSwitchIntent(
  state: DiveState,
  requestedIndex: number | null,
): DiveState {
  if (state.ccr || requestedIndex === null || requestedIndex === state.activeTankIndex) {
    return state;
  }

  const requestedTank = state.tanks[requestedIndex];
  if (!requestedTank || requestedTank.gasRemainingL <= 0) {
    return state;
  }

  return withEvent(
    { ...state, activeTankIndex: requestedIndex },
    {
      type: "gas-switch",
      elapsedTimeS: state.elapsedTimeS,
      tankIndex: requestedIndex,
    },
  );
}

function applySetpointAdjustment(
  state: DiveState,
  deltaBar: number,
): DiveState {
  if (
    !state.ccr ||
    state.ccr.onBailout ||
    !Number.isFinite(deltaBar) ||
    deltaBar === 0
  ) {
    return state;
  }
  // Legacy's `+(x).toFixed(1)` snaps to a tenth so that 0.7 + 0.1 reads as
  // 0.8 and not 0.7999999999999999; rounding to a tenth does the same
  // without the string round trip.
  const requestedBar = Math.round((state.ccr.targetPo2Bar + deltaBar) * 10) / 10;
  const nextBar = Math.max(
    CCR_SETPOINT_MIN_BAR,
    Math.min(CCR_SETPOINT_MAX_BAR, requestedBar),
  );
  if (nextBar === state.ccr.targetPo2Bar) {
    return state;
  }
  return freezeDiveState({
    ...state,
    ccr: { ...state.ccr, targetPo2Bar: bars(nextBar) },
  });
}

function applyBailoutIntent(state: DiveState, bailout: boolean): DiveState {
  if (!bailout || !state.ccr || state.ccr.onBailout) {
    return state;
  }

  return withEvent(
    {
      ...state,
      ccr: {
        ...state.ccr,
        onBailout: true,
        co2BuildupS: seconds(0),
      },
    },
    { type: "bailout", elapsedTimeS: state.elapsedTimeS },
  );
}

function updateLifeSupport(
  state: DiveState,
  environment: DiveEnvironment,
  previousDepthM: Metres,
  elapsedS: Seconds,
): DiveState {
  if (environment.breathing) {
    return state;
  }
  if (state.ccr) {
    return state.ccr.onBailout
      ? consumeCcrBailoutGas(state, environment.depthM, elapsedS)
      : updateCcrLoop(state, previousDepthM, elapsedS);
  }
  return consumeOpenCircuitGas(state, environment, elapsedS);
}

function consumeOpenCircuitGas(
  state: DiveState,
  environment: DiveEnvironment,
  elapsedS: Seconds,
): DiveState {
  const exertionMultiplier = environment.exertionMultiplier ?? 1;
  if (!Number.isFinite(exertionMultiplier) || exertionMultiplier < 0) {
    throw new RangeError("exertion multiplier must be finite and non-negative");
  }

  const activeTank = state.tanks[state.activeTankIndex];
  if (!activeTank) {
    throw new RangeError("active tank index is outside the tank list");
  }
  const consumedL =
    state.surfaceAirConsumptionLpm *
    ambientPressureBar(environment.depthM) *
    secondsToMinutes(elapsedS) *
    exertionMultiplier;
  const tanks = state.tanks.map((tank, index) =>
    index === state.activeTankIndex
      ? { ...tank, gasRemainingL: litres(Math.max(0, tank.gasRemainingL - consumedL)) }
      : tank,
  );
  let nextState = freezeDiveState({ ...state, tanks });

  if ((nextState.tanks[nextState.activeTankIndex]?.gasRemainingL ?? 0) <= 0) {
    const recommendedIndex = recommendBestGasIndex(nextState, environment.depthM);
    if (recommendedIndex >= 0 && recommendedIndex !== nextState.activeTankIndex) {
      nextState = withEvent(
        { ...nextState, activeTankIndex: recommendedIndex },
        {
          type: "gas-switch",
          elapsedTimeS: nextState.elapsedTimeS,
          tankIndex: recommendedIndex,
        },
      );
    }
  }

  return nextState;
}

function consumeCcrBailoutGas(
  state: DiveState,
  depthM: Metres,
  elapsedS: Seconds,
): DiveState {
  const ccr = requireCcr(state);
  const consumedL =
    state.surfaceAirConsumptionLpm *
    ambientPressureBar(depthM) *
    secondsToMinutes(elapsedS);
  const availableL = ccr.diluentCylinderPressureBar * ccr.diluentCylinderVolumeL;
  const actualConsumedL = Math.min(consumedL, availableL);

  return freezeDiveState({
    ...state,
    ccr: {
      ...ccr,
      diluentCylinderPressureBar: bars(
        Math.max(
          0,
          ccr.diluentCylinderPressureBar -
            actualConsumedL / ccr.diluentCylinderVolumeL,
        ),
      ),
    },
  });
}

function applyCcrDiluentOnDescent(
  state: DiveState,
  previousDepthM: Metres,
  nextDepthM: Metres,
): DiveState {
  if (!state.ccr || state.ccr.onBailout || nextDepthM <= previousDepthM) {
    return state;
  }

  const ccr = state.ccr;
  const previousAmbientBar = ambientPressureBar(previousDepthM);
  const nextAmbientBar = ambientPressureBar(nextDepthM);
  const requiredL = ccr.loopVolumeL * (nextAmbientBar - previousAmbientBar);
  const availableL = ccr.diluentCylinderPressureBar * ccr.diluentCylinderVolumeL;
  const injectedL = Math.min(requiredL, availableL);
  const actualPo2Bar =
    (nextAmbientBar *
      (ccr.actualPo2Bar * ccr.loopVolumeL +
        ccr.diluent.oxygenFraction * injectedL)) /
    (previousAmbientBar * ccr.loopVolumeL + injectedL);

  return freezeDiveState({
    ...state,
    ccr: {
      ...ccr,
      actualPo2Bar: bars(actualPo2Bar),
      diluentCylinderPressureBar: bars(
        Math.max(
          0,
          ccr.diluentCylinderPressureBar - injectedL / ccr.diluentCylinderVolumeL,
        ),
      ),
    },
  });
}

function updateCcrLoop(
  state: DiveState,
  previousDepthM: Metres,
  elapsedS: Seconds,
): DiveState {
  const ccr = requireCcr(state);
  const elapsedMin = secondsToMinutes(elapsedS);
  const metabolicUsedL = Math.min(
    ccr.metabolicOxygenLpm * elapsedMin,
    ccr.oxygenCylinderPressureBar * ccr.oxygenCylinderVolumeL,
  );
  let oxygenPressureBar = Math.max(
    0,
    ccr.oxygenCylinderPressureBar - metabolicUsedL / ccr.oxygenCylinderVolumeL,
  );
  const ambientBar = ambientPressureBar(state.depthM);
  const previousAmbientBar = ambientPressureBar(previousDepthM);
  let actualPo2Bar: number = ccr.actualPo2Bar;

  if (state.depthM <= previousDepthM) {
    actualPo2Bar *= ambientBar / previousAmbientBar;
  }

  const oxygenAvailableL = oxygenPressureBar * ccr.oxygenCylinderVolumeL;
  if (oxygenAvailableL > 0 && actualPo2Bar < ccr.targetPo2Bar) {
    const desiredRiseBar = Math.min(
      ccr.po2ResponseBarPerSecond * elapsedS,
      ccr.targetPo2Bar - actualPo2Bar,
    );
    const desiredCostL = ccr.loopVolumeL * desiredRiseBar;
    const oxygenCostL = Math.min(desiredCostL, oxygenAvailableL);
    actualPo2Bar += oxygenCostL / ccr.loopVolumeL;
    oxygenPressureBar = Math.max(
      0,
      oxygenPressureBar - oxygenCostL / ccr.oxygenCylinderVolumeL,
    );
  } else if (oxygenPressureBar <= 0) {
    actualPo2Bar -=
      ((ccr.metabolicOxygenLpm / 60) * elapsedS * ambientBar) / ccr.loopVolumeL;
  }

  actualPo2Bar = Math.max(0, Math.min(actualPo2Bar, ambientBar));
  const scrubberRemainingS = seconds(
    Math.max(0, ccr.scrubberRemainingS - elapsedS),
  );

  return freezeDiveState({
    ...state,
    ccr: {
      ...ccr,
      actualPo2Bar: bars(actualPo2Bar),
      oxygenCylinderPressureBar: bars(oxygenPressureBar),
      scrubberRemainingS,
    },
  });
}

function updateFailureState(
  state: DiveState,
  elapsedS: Seconds,
  breathingSource: BreathingSource,
  limits: DecompressionLimits,
  ascentRateMpm: number,
): DiveState {
  const ccrActive = Boolean(state.ccr && !state.ccr.onBailout);
  const inspiredPo2Bar =
    breathingSource.kind === "ccr" && !breathingSource.onBailout
      ? breathingSource.actualPo2Bar
      : breathingSource.kind === "open-circuit"
        ? breathingSource.gas.oxygenFraction *
          ambientPressureBar(state.depthM)
        : breathingSource.diluent.oxygenFraction *
          ambientPressureBar(state.depthM);
  const oxygenToxicityS = updateThresholdTimer(
    state.failure.oxygenToxicityS,
    inspiredPo2Bar > PO2_HIGH_BAR,
    elapsedS,
  );
  const hypoxiaS = ccrActive
    ? seconds(0)
    : updateThresholdTimer(
        state.failure.hypoxiaS,
        inspiredPo2Bar < PO2_HYPOXIA_BAR,
        elapsedS,
      );
  const ccrHypoxiaS = ccrActive
    ? updateResettingTimer(
        state.failure.ccrHypoxiaS,
        inspiredPo2Bar < PO2_HYPOXIA_BAR,
        elapsedS,
      )
    : state.failure.ccrHypoxiaS;
  const ccrHyperoxiaS = ccrActive
    ? updateResettingTimer(
        state.failure.ccrHyperoxiaS,
        inspiredPo2Bar > PO2_HIGH_BAR,
        elapsedS,
      )
    : state.failure.ccrHyperoxiaS;
  let ccr = state.ccr;

  if (ccrActive && ccr) {
    const scrubberFailed = ccr.scrubberFailed || ccr.scrubberRemainingS <= 0;
    ccr = {
      ...ccr,
      scrubberFailed,
      co2BuildupS: scrubberFailed
        ? seconds(ccr.co2BuildupS + elapsedS)
        : ccr.co2BuildupS,
    };
  }

  // Legacy's DCS check: shallower than the first stop counts up, anything
  // else counts down to zero, both in dive seconds (#199).
  const dcsViolationS =
    limits.ceilingM > 0 && state.depthM < decoStopDepth(limits.ceilingM)
      ? seconds(state.failure.dcsViolationS + elapsedS)
      : seconds(Math.max(0, state.failure.dcsViolationS - elapsedS));
  // Legacy's barotrauma check (#189): the step's ascent at 18 m/min or faster
  // counts up, anything slower counts down twice as fast, to zero. Legacy
  // also counts any ascent while a drill's held breath lasts; the drills are
  // not migrated, so no breath is ever held here.
  const barotraumaS =
    ascentRateMpm >= BAROTRAUMA_ASCENT_RATE_MPM
      ? seconds(state.failure.barotraumaS + elapsedS)
      : seconds(Math.max(0, state.failure.barotraumaS - elapsedS * 2));

  const failure = {
    ...state.failure,
    oxygenToxicityS,
    hypoxiaS,
    ccrHypoxiaS,
    ccrHyperoxiaS,
    dcsViolationS,
    barotraumaS,
  };
  let nextState = freezeDiveState({ ...state, ccr, failure });
  const reason = detectFailure(nextState, limits);

  if (reason) {
    // A rebreather failure returns from legacy's updateDiving() before its
    // DCS and barotrauma checks run, so both timers stay where they were on
    // that step.
    const beforeTheChecks = FAILURES_BEFORE_THE_LOG.has(reason);
    nextState = withEvent(
      {
        ...nextState,
        failure: {
          ...nextState.failure,
          reason,
          dcsViolationS: beforeTheChecks ? state.failure.dcsViolationS : dcsViolationS,
          barotraumaS: beforeTheChecks ? state.failure.barotraumaS : barotraumaS,
        },
      },
      {
        type: "failure",
        elapsedTimeS: nextState.elapsedTimeS,
        failureReason: reason,
      },
    );
  }

  return nextState;
}

/**
 * Legacy's dive-ending checks in their order, those the model has: the
 * rebreather's in updateCCR(), then out of gas, oxygen toxicity, the DCS
 * timer, barotrauma, hypoxia and surfacing with a ceiling. Narcosis, which
 * legacy checks after hypoxia, is not modelled yet (#189).
 */
function detectFailure(
  state: DiveState,
  limits: DecompressionLimits,
): DiveFailureReason | null {
  if (state.ccr?.onBailout && state.ccr.diluentCylinderPressureBar <= 0) {
    return "out-of-gas";
  }
  if (!state.ccr) {
    const activeRemainingL = state.tanks[state.activeTankIndex]?.gasRemainingL ?? 0;
    if (activeRemainingL <= 0 && recommendBestGasIndex(state, state.depthM) < 0) {
      return "out-of-gas";
    }
  }
  if (state.ccr && !state.ccr.onBailout) {
    if (state.failure.ccrHypoxiaS >= CCR_HYPOXIA_FAILURE_SECONDS) {
      return "ccr-hypoxia";
    }
    if (state.failure.ccrHyperoxiaS >= CCR_HYPEROXIA_FAILURE_SECONDS) {
      return "ccr-hyperoxia";
    }
    if (state.ccr.co2BuildupS >= CCR_CO2_FAILURE_SECONDS) {
      return "ccr-co2";
    }
  }
  if (state.failure.oxygenToxicityS >= OXYGEN_TOXICITY_FAILURE_SECONDS) {
    return "oxygen-toxicity";
  }
  if (state.failure.dcsViolationS >= DCS_VIOLATION_FAILURE_SECONDS) {
    return "decompression-sickness";
  }
  if (state.failure.barotraumaS >= BAROTRAUMA_FAILURE_SECONDS) {
    return "pulmonary-barotrauma";
  }
  if (state.failure.hypoxiaS >= seconds(10)) {
    return "hypoxia";
  }
  if (state.depthM < SURFACE_DCS_DEPTH_M && limits.ceilingM > SURFACE_DCS_CEILING_M) {
    return "decompression-sickness";
  }
  return null;
}

export function recommendBestGasIndex(state: DiveState, depthM: Metres): number {
  const ambientBar = ambientPressureBar(depthM);
  let bestIndex = -1;
  let bestOxygenFraction = -1;

  for (let index = 0; index < state.tanks.length; index += 1) {
    const tank = state.tanks[index];
    if (!tank || tank.gasRemainingL <= 0) {
      continue;
    }
    const po2Bar = tank.gas.oxygenFraction * ambientBar;
    if (po2Bar < PO2_HYPOXIA_BAR || po2Bar > PO2_HIGH_BAR) {
      continue;
    }
    if (tank.gas.oxygenFraction > bestOxygenFraction) {
      bestOxygenFraction = tank.gas.oxygenFraction;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function updateThresholdTimer(
  currentS: Seconds,
  thresholdExceeded: boolean,
  elapsedS: Seconds,
): Seconds {
  return thresholdExceeded
    ? seconds(currentS + elapsedS)
    : seconds(Math.max(0, currentS - elapsedS * 0.5));
}

function updateResettingTimer(
  currentS: Seconds,
  thresholdExceeded: boolean,
  elapsedS: Seconds,
): Seconds {
  return thresholdExceeded ? seconds(currentS + elapsedS) : seconds(0);
}

function withEvent(state: DiveState, event: DiveEvent): DiveState {
  return freezeDiveState({ ...state, events: [...state.events, event] });
}

function requireCcr(state: DiveState): CcrState {
  if (!state.ccr) {
    throw new TypeError("CCR state is required for this transition");
  }
  return state.ccr;
}

function ambientPressureBar(depthM: Metres): number {
  return 1 + depthM / 10;
}

export function resolveInspiredGas(
  source: BreathingSource,
  depthM: Metres,
): GasMix {
  if (source.kind === "open-circuit" || source.onBailout) {
    return source.kind === "open-circuit" ? source.gas : source.diluent;
  }

  const ambientPressureBar = 1 + depthM / 10;
  const oxygenFraction = Math.min(source.actualPo2Bar / ambientPressureBar, 1);
  const inertFraction = Math.max(0, 1 - oxygenFraction);
  const diluentInertFraction =
    source.diluent.nitrogenFraction + source.diluent.heliumFraction;

  if (diluentInertFraction < 0.001) {
    return {
      oxygenFraction: fraction(oxygenFraction),
      nitrogenFraction: fraction(inertFraction),
      heliumFraction: fraction(0),
    };
  }

  return {
    oxygenFraction: fraction(oxygenFraction),
    nitrogenFraction: fraction(
      inertFraction *
        (source.diluent.nitrogenFraction / diluentInertFraction),
    ),
    heliumFraction: fraction(
      inertFraction * (source.diluent.heliumFraction / diluentInertFraction),
    ),
  };
}

export function openCircuit(gas: GasMix): BreathingSource {
  return { kind: "open-circuit", gas };
}

export function closedCircuit(
  actualPo2Bar: number,
  diluent: GasMix,
): BreathingSource {
  return {
    kind: "ccr",
    actualPo2Bar: bars(actualPo2Bar),
    diluent,
    onBailout: false,
  };
}
