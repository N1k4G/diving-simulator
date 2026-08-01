import {
  SURFACE_N2_LOADING_BAR,
  TISSUE_COMPARTMENT_COUNT,
} from "./buhlmann-constants";
import { normalizeSeed } from "./rng";
import {
  bars,
  fraction,
  metres,
  seconds,
  type Bars,
  type Fraction,
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

export interface DiveState {
  elapsedTimeS: Seconds;
  depthM: Metres;
  maxDepthM: Metres;
  tissues: TissueState;
  randomState: number;
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

export function createInitialDiveState(seed = 0): DiveState {
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
  });
}

export function freezeDiveState(state: DiveState): DiveState {
  const tissues = Object.freeze({
    nitrogenBar: Object.freeze([...state.tissues.nitrogenBar]),
    heliumBar: Object.freeze([...state.tissues.heliumBar]),
  });

  return Object.freeze({ ...state, tissues });
}
