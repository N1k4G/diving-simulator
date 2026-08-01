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
  type DiveState,
  type GasMix,
} from "./dive-state";
import {
  bars,
  fraction,
  metres,
  seconds,
  secondsToMinutes,
  type Bars,
  type Metres,
  type Seconds,
} from "./units";

export const FIXED_STEP_SECONDS = seconds(1);

export interface DiveEnvironment {
  depthM: Metres;
  breathing: BreathingSource;
}

export class DiveModel {
  #state: DiveState;

  constructor(initialState: DiveState) {
    this.#state = freezeDiveState(initialState);
  }

  get snapshot(): DiveState {
    return this.#state;
  }

  advance(environment: DiveEnvironment, elapsedS: Seconds): DiveState {
    let remainingS = elapsedS;

    while (remainingS > 0) {
      const stepS = seconds(Math.min(remainingS, FIXED_STEP_SECONDS));
      this.#state = advanceTissues(this.#state, environment, stepS);
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
    environment.breathing,
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
