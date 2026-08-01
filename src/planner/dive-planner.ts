import {
  LN_2,
  WATER_VAPOR_PRESSURE_BAR,
  ZHL16C_HE,
  ZHL16C_N2,
} from "../core/buhlmann-constants";
import {
  freezeDiveState,
  type DiveState,
  type GasMix,
  type TissueState,
} from "../core/dive-state";
import {
  PO2_HIGH_BAR,
  PO2_HYPOXIA_BAR,
  resolveInspiredGas,
} from "../core/dive-model";
import {
  metres,
  minutes,
  type Metres,
  type Minutes,
} from "../core/units";

export const DEFAULT_GF_LOW_PERCENT = 35;
export const DEFAULT_GF_HIGH_PERCENT = 75;
export const DEFAULT_ASCENT_RATE_MPM = 9;

const NDL_STEP_MINUTES = 0.5;
const NDL_MAX_STEPS = 400;
const SCHEDULE_STEP_MINUTES = 0.1;
const SCHEDULE_MAX_STOPS = 500;
const SCHEDULE_MAX_STOP_STEPS = 3000;

export interface PlannerSettings {
  gfLowPercent: number;
  gfHighPercent: number;
  ascentRateMpm: number;
  safetyStopNeeded: boolean;
  ndlDroppedBelowFiveMinutes: boolean;
}

export interface DecoStop {
  depthM: Metres;
  durationMin: Minutes;
}

export interface DecoSchedule {
  stops: readonly DecoStop[];
  ttsMin: Minutes;
  outOfGas: boolean;
}

export interface PlannerForecast {
  ceilingM: Metres;
  ndlMin: Minutes;
  schedule: DecoSchedule | null;
  ttsMin: Minutes;
}

export const DEFAULT_PLANNER_SETTINGS: Readonly<PlannerSettings> =
  Object.freeze({
    gfLowPercent: DEFAULT_GF_LOW_PERCENT,
    gfHighPercent: DEFAULT_GF_HIGH_PERCENT,
    ascentRateMpm: DEFAULT_ASCENT_RATE_MPM,
    safetyStopNeeded: false,
    ndlDroppedBelowFiveMinutes: false,
  });

export class DivePlanner {
  forecast(
    authoritativeState: DiveState,
    settings: Readonly<PlannerSettings> = DEFAULT_PLANNER_SETTINGS,
  ): PlannerForecast {
    const state = freezeDiveState(authoritativeState);
    const validatedSettings = validateSettings(settings);
    const ceilingM = calculateCeiling(state.tissues, validatedSettings);
    const ndlMin = calculateNdl(state, validatedSettings);
    const schedule =
      decoStopDepth(ceilingM) > 0
        ? calculateDecoSchedule(state, validatedSettings, ceilingM)
        : null;
    const ttsMin = calculateTts(
      state,
      validatedSettings,
      ceilingM,
      schedule,
    );

    return freezeForecast({ ceilingM, ndlMin, schedule, ttsMin });
  }
}

export function calculateCeiling(
  tissues: TissueState,
  settings: Readonly<PlannerSettings> = DEFAULT_PLANNER_SETTINGS,
): Metres {
  assertTissueShape(tissues);
  const gfHigh = validateSettings(settings).gfHighPercent / 100;
  let maximumAmbientBar = 0;

  for (let index = 0; index < ZHL16C_N2.length; index += 1) {
    const totalLoadBar =
      (tissues.nitrogenBar[index] ?? 0) +
      (tissues.heliumBar[index] ?? 0);
    const coefficients = combinedCoefficients(
      tissues.nitrogenBar,
      tissues.heliumBar,
      index,
    );
    const ambientBar =
      (totalLoadBar - coefficients.a * gfHigh) /
      (gfHigh / coefficients.b + 1 - gfHigh);
    maximumAmbientBar = Math.max(maximumAmbientBar, ambientBar);
  }

  return metres(Math.max(0, (maximumAmbientBar - 1) * 10));
}

export function calculateNdl(
  authoritativeState: DiveState,
  settings: Readonly<PlannerSettings> = DEFAULT_PLANNER_SETTINGS,
): Minutes {
  const state = freezeDiveState(authoritativeState);
  const gfHigh = validateSettings(settings).gfHighPercent / 100;
  const nitrogenBar = [...state.tissues.nitrogenBar];
  const heliumBar = [...state.tissues.heliumBar];
  const gas = currentForecastGas(state);
  const ambientBar = ambientPressureBar(state.depthM);
  const inspiredN2Bar =
    (ambientBar - WATER_VAPOR_PRESSURE_BAR) * gas.nitrogenFraction;
  const inspiredHeBar =
    (ambientBar - WATER_VAPOR_PRESSURE_BAR) * gas.heliumFraction;
  let totalMinutes = 0;

  for (let step = 0; step < NDL_MAX_STEPS; step += 1) {
    updateTissueArrays(
      nitrogenBar,
      heliumBar,
      inspiredN2Bar,
      inspiredHeBar,
      NDL_STEP_MINUTES,
    );
    totalMinutes += NDL_STEP_MINUTES;

    for (let index = 0; index < ZHL16C_N2.length; index += 1) {
      const coefficients = combinedCoefficients(
        nitrogenBar,
        heliumBar,
        index,
      );
      const surfaceMValueBar = coefficients.a + 1 / coefficients.b;
      const allowedBar = gfHigh * (surfaceMValueBar - 1) + 1;
      const totalLoadBar =
        (nitrogenBar[index] ?? 0) + (heliumBar[index] ?? 0);

      if (totalLoadBar > allowedBar) {
        return minutes(Math.floor(totalMinutes));
      }
    }
  }

  return minutes(999);
}

export function calculateDecoSchedule(
  authoritativeState: DiveState,
  settings: Readonly<PlannerSettings> = DEFAULT_PLANNER_SETTINGS,
  cachedCeilingM?: Metres,
): DecoSchedule {
  const state = freezeDiveState(authoritativeState);
  const validatedSettings = validateSettings(settings);
  const ceilingM =
    cachedCeilingM ?? calculateCeiling(state.tissues, validatedSettings);

  if (ceilingM <= 0) {
    return freezeSchedule({ stops: [], ttsMin: minutes(0), outOfGas: false });
  }

  const nitrogenBar = [...state.tissues.nitrogenBar];
  const heliumBar = [...state.tissues.heliumBar];
  let simulatedDepthM = state.depthM;
  let gas = currentForecastGas(state);
  let totalMinutes = 0;
  const stops: DecoStop[] = [];
  const firstStopM = decoStopDepth(ceilingM);
  const gfLow = validatedSettings.gfLowPercent / 100;
  const gfHigh = validatedSettings.gfHighPercent / 100;
  let outOfGas = false;

  const gfAtDepth = (depthM: number): number => {
    if (firstStopM <= 0) {
      return gfHigh;
    }
    const fractionOfFirstStop = Math.max(
      0,
      Math.min(1, depthM / firstStopM),
    );
    return gfHigh + (gfLow - gfHigh) * fractionOfFirstStop;
  };

  const updateAtDepth = (depthM: number, durationMin: number): void => {
    const ambientBar = ambientPressureBar(depthM);
    updateTissueArrays(
      nitrogenBar,
      heliumBar,
      (ambientBar - WATER_VAPOR_PRESSURE_BAR) * gas.nitrogenFraction,
      (ambientBar - WATER_VAPOR_PRESSURE_BAR) * gas.heliumFraction,
      durationMin,
    );
  };

  const simulatedCeiling = (gradientFactor: number): number => {
    let maximumAmbientBar = 0;
    for (let index = 0; index < ZHL16C_N2.length; index += 1) {
      const coefficients = combinedCoefficients(
        nitrogenBar,
        heliumBar,
        index,
      );
      const totalLoadBar =
        (nitrogenBar[index] ?? 0) + (heliumBar[index] ?? 0);
      const ambientBar =
        (totalLoadBar - coefficients.a * gradientFactor) /
        (gradientFactor / coefficients.b + 1 - gradientFactor);
      maximumAmbientBar = Math.max(maximumAmbientBar, ambientBar);
    }
    return Math.max(0, (maximumAmbientBar - 1) * 10);
  };

  if (simulatedDepthM > firstStopM) {
    const ascentMinutes =
      (simulatedDepthM - firstStopM) / validatedSettings.ascentRateMpm;
    const steps = Math.ceil(ascentMinutes / SCHEDULE_STEP_MINUTES);
    const stepMinutes = ascentMinutes / steps;
    const stepDepthM = (simulatedDepthM - firstStopM) / steps;

    for (let step = 0; step < steps && !outOfGas; step += 1) {
      simulatedDepthM = metres(simulatedDepthM - stepDepthM);
      const selectedGas = bestForecastGas(state, simulatedDepthM);
      if (!selectedGas) {
        outOfGas = true;
        break;
      }
      gas = selectedGas;
      updateAtDepth(simulatedDepthM, stepMinutes);
      totalMinutes += stepMinutes;
    }
  }

  let stopDepthM = firstStopM;
  let stopCount = 0;
  while (!outOfGas && stopDepthM > 0 && stopCount < SCHEDULE_MAX_STOPS) {
    stopCount += 1;
    let stopMinutes = 0;
    const nextStopM = stopDepthM - 3;
    const selectedGas = bestForecastGas(state, stopDepthM);
    if (!selectedGas) {
      outOfGas = true;
      break;
    }
    gas = selectedGas;

    for (let iteration = 0; iteration < SCHEDULE_MAX_STOP_STEPS; iteration += 1) {
      updateAtDepth(stopDepthM, SCHEDULE_STEP_MINUTES);
      stopMinutes += SCHEDULE_STEP_MINUTES;
      totalMinutes += SCHEDULE_STEP_MINUTES;
      const nextCeilingM = simulatedCeiling(gfAtDepth(Math.max(0, nextStopM)));
      if (nextCeilingM <= Math.max(0, nextStopM)) {
        break;
      }
    }

    stops.push({
      depthM: metres(stopDepthM),
      durationMin: minutes(Math.ceil(stopMinutes)),
    });

    if (nextStopM > 0) {
      simulatedDepthM = metres(nextStopM);
      const nextGas = bestForecastGas(state, nextStopM);
      if (!nextGas) {
        outOfGas = true;
        break;
      }
      gas = nextGas;
      updateAtDepth(nextStopM, 1);
      totalMinutes += 1;
    } else {
      const surfaceGas = bestForecastGas(state, 0);
      if (!surfaceGas) {
        outOfGas = true;
        break;
      }
      gas = surfaceGas;
      const finalAscentMinutes =
        stopDepthM / validatedSettings.ascentRateMpm;
      updateAtDepth(0, finalAscentMinutes);
      totalMinutes += finalAscentMinutes;
      break;
    }
    stopDepthM = metres(nextStopM);
  }

  return freezeSchedule({
    stops,
    ttsMin: minutes(Math.ceil(totalMinutes)),
    outOfGas,
  });
}

export function decoStopDepth(ceilingM: Metres | number): Metres {
  return ceilingM <= 0 ? metres(0) : metres(Math.ceil(ceilingM / 3) * 3);
}

function calculateTts(
  state: DiveState,
  settings: PlannerSettings,
  ceilingM: Metres,
  schedule: DecoSchedule | null,
): Minutes {
  if (state.depthM < 0.5) {
    return minutes(0);
  }
  if (decoStopDepth(ceilingM) > 0 && schedule) {
    return schedule.ttsMin;
  }

  const ascentMinutes = state.depthM / settings.ascentRateMpm;
  let safetyStopMinutes = 0;
  if (settings.safetyStopNeeded || state.maxDepthM > 11) {
    safetyStopMinutes =
      state.maxDepthM > 30 || settings.ndlDroppedBelowFiveMinutes ? 5 : 3;
  }
  return minutes(Math.ceil(ascentMinutes + safetyStopMinutes));
}

function currentForecastGas(state: DiveState): GasMix {
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

function bestForecastGas(state: DiveState, depthM: number): GasMix | null {
  if (state.ccr && !state.ccr.onBailout) {
    return resolveInspiredGas(
      {
        kind: "ccr",
        actualPo2Bar: state.ccr.targetPo2Bar,
        diluent: state.ccr.diluent,
        onBailout: false,
      },
      metres(depthM),
    );
  }

  const ambientBar = ambientPressureBar(depthM);
  let bestGas: GasMix | null = null;
  let fallbackGas: GasMix | null = null;
  let bestOxygenFraction = -1;
  let fallbackOxygenFraction = -1;
  for (const tank of state.tanks) {
    if (tank.gasRemainingL <= 0) {
      continue;
    }
    if (tank.gas.oxygenFraction > fallbackOxygenFraction) {
      fallbackGas = tank.gas;
      fallbackOxygenFraction = tank.gas.oxygenFraction;
    }
    const po2Bar = tank.gas.oxygenFraction * ambientBar;
    if (po2Bar < PO2_HYPOXIA_BAR || po2Bar > PO2_HIGH_BAR) {
      continue;
    }
    if (tank.gas.oxygenFraction > bestOxygenFraction) {
      bestGas = tank.gas;
      bestOxygenFraction = tank.gas.oxygenFraction;
    }
  }
  return bestGas ?? fallbackGas;
}

function updateTissueArrays(
  nitrogenBar: number[],
  heliumBar: number[],
  inspiredN2Bar: number,
  inspiredHeBar: number,
  elapsedMinutes: number,
): void {
  for (let index = 0; index < ZHL16C_N2.length; index += 1) {
    const n2 = nitrogenBar[index];
    const he = heliumBar[index];
    const n2Compartment = ZHL16C_N2[index];
    const heCompartment = ZHL16C_HE[index];
    if (
      n2 === undefined ||
      he === undefined ||
      !n2Compartment ||
      !heCompartment
    ) {
      throw new RangeError("planner requires all 16 tissue compartments");
    }
    nitrogenBar[index] =
      inspiredN2Bar +
      (n2 - inspiredN2Bar) *
        Math.exp(-(LN_2 / n2Compartment.halfTimeMin) * elapsedMinutes);
    heliumBar[index] =
      inspiredHeBar +
      (he - inspiredHeBar) *
        Math.exp(-(LN_2 / heCompartment.halfTimeMin) * elapsedMinutes);
  }
}

function combinedCoefficients(
  nitrogenBar: readonly number[],
  heliumBar: readonly number[],
  index: number,
): { a: number; b: number } {
  const n2 = nitrogenBar[index] ?? 0;
  const he = heliumBar[index] ?? 0;
  const n2Compartment = ZHL16C_N2[index];
  const heCompartment = ZHL16C_HE[index];
  if (!n2Compartment || !heCompartment) {
    throw new RangeError("planner requires all 16 tissue compartments");
  }
  const total = n2 + he;
  if (total < 0.0001) {
    return { a: n2Compartment.a, b: n2Compartment.b };
  }
  return {
    a: (n2Compartment.a * n2 + heCompartment.a * he) / total,
    b: (n2Compartment.b * n2 + heCompartment.b * he) / total,
  };
}

function assertTissueShape(tissues: TissueState): void {
  if (
    tissues.nitrogenBar.length !== ZHL16C_N2.length ||
    tissues.heliumBar.length !== ZHL16C_HE.length
  ) {
    throw new RangeError("planner requires all 16 tissue compartments");
  }
}

function validateSettings(settings: Readonly<PlannerSettings>): PlannerSettings {
  const percentages = [settings.gfLowPercent, settings.gfHighPercent];
  if (
    percentages.some(
      (value) => !Number.isFinite(value) || value <= 0 || value > 100,
    )
  ) {
    throw new RangeError("gradient factors must be between 0 and 100 percent");
  }
  if (!Number.isFinite(settings.ascentRateMpm) || settings.ascentRateMpm <= 0) {
    throw new RangeError("ascent rate must be a finite positive number");
  }
  return { ...settings };
}

function ambientPressureBar(depthM: Metres | number): number {
  return 1 + depthM / 10;
}

function freezeSchedule(schedule: DecoSchedule): DecoSchedule {
  return Object.freeze({
    ...schedule,
    stops: Object.freeze(
      schedule.stops.map((stop) => Object.freeze({ ...stop })),
    ),
  });
}

function freezeForecast(forecast: PlannerForecast): PlannerForecast {
  return Object.freeze({
    ...forecast,
    schedule: forecast.schedule ? freezeSchedule(forecast.schedule) : null,
  });
}
