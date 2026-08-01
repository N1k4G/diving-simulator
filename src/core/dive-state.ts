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

export interface DiveState {
  elapsedTimeS: Seconds;
  depthM: Metres;
  maxDepthM: Metres;
  tissues: TissueState;
  randomState: number;
  tanks: readonly TankState[];
  activeTankIndex: number;
  surfaceAirConsumptionLpm: LitresPerMinute;
  ccr: CcrState | null;
  failure: FailureState;
  events: readonly DiveEvent[];
}

export interface InitialDiveOptions {
  tanks?: readonly TankState[];
  activeTankIndex?: number;
  surfaceAirConsumptionLpm?: number;
  ccr?: CcrState | null;
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
    ccr: options.ccr ?? null,
    failure: {
      reason: null,
      oxygenToxicityS: seconds(0),
      hypoxiaS: seconds(0),
      ccrHypoxiaS: seconds(0),
      ccrHyperoxiaS: seconds(0),
    },
    events: [],
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

  return Object.freeze({ ...state, tissues, tanks, ccr, failure, events });
}
