import {
  LN_2,
  TISSUE_COMPARTMENT_COUNT,
  WATER_VAPOR_PRESSURE_BAR,
  ZHL16C_HE,
  ZHL16C_N2,
  asTissuePressure,
} from "./buhlmann-constants";
import {
  freezeDiveState,
  type BreathingSource,
  type CcrState,
  type DiveEvent,
  type DiveFailureReason,
  type DiveState,
  type GasMix,
} from "./dive-state";
import { NO_INPUT, type InputIntent } from "./inputs";
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

export interface DiveEnvironment {
  depthM: Metres;
  breathing?: BreathingSource;
  exertionMultiplier?: number;
}

export class DiveModel {
  #state: DiveState;

  constructor(initialState: DiveState) {
    this.#state = freezeDiveState(initialState);
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

    while (remainingS > 0 && this.#state.failure.reason === null) {
      const stepS = seconds(Math.min(remainingS, FIXED_STEP_SECONDS));
      this.#state = advanceDiveStep(
        this.#state,
        environment,
        stepS,
        pendingIntent,
      );
      pendingIntent = NO_INPUT;
      remainingS = seconds(Math.max(0, remainingS - stepS));
    }

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
  if (state.failure.reason !== null || elapsedS === 0) {
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
  nextState = updateLifeSupport(
    nextState,
    environment,
    previousDepthM,
    elapsedS,
  );
  nextState = applyBailoutIntent(nextState, intent.bailout);

  return updateFailureState(
    nextState,
    elapsedS,
    environment.breathing ?? breathingSourceForState(nextState),
  );
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

  const failure = {
    ...state.failure,
    oxygenToxicityS,
    hypoxiaS,
    ccrHypoxiaS,
    ccrHyperoxiaS,
  };
  let nextState = freezeDiveState({ ...state, ccr, failure });
  const reason = detectFailure(nextState);

  if (reason) {
    nextState = withEvent(
      {
        ...nextState,
        failure: { ...nextState.failure, reason },
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

function detectFailure(state: DiveState): DiveFailureReason | null {
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
  if (state.failure.hypoxiaS >= seconds(10)) {
    return "hypoxia";
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
