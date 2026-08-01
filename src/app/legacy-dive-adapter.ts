import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  freezeDiveState,
  type DiveState,
  type TissueState,
} from "../core/dive-state";
import { normalizeSeed } from "../core/rng";
import {
  bars,
  litres,
  litresPerMinute,
  metres,
  minutes,
  minutesToSeconds,
} from "../core/units";

export interface LegacyTissueCheckpoint {
  state: {
    depth_m: number;
    maxDepth_m: number;
    diveTime_min: number;
    diveMode?: string;
    activeTankIndex?: number;
  };
  configuration?: {
    amv_lpm?: number;
  };
  tissues: {
    n2_bar: readonly number[];
    he_bar: readonly number[];
  };
  tanks?: readonly {
    fO2: number;
    fHe: number;
    volume_l: number;
    pressure_bar: number;
    gasRemaining_l: number;
  }[];
  ccr?: {
    targetPO2_bar: number;
    actualPO2_bar: number;
    diluent: {
      fO2: number;
      fHe: number;
    };
    o2Pressure_bar: number;
    diluentPressure_bar: number;
    scrubberRemaining_min: number;
    onBailout: boolean;
  };
}

export function diveStateFromLegacyCheckpoint(
  checkpoint: LegacyTissueCheckpoint,
  seed = 0,
): DiveState {
  const tanks = checkpoint.tanks?.map((tank) => ({
    gas: createGasMix(tank.fO2, tank.fHe),
    volumeL: litres(tank.volume_l),
    gasRemainingL: litres(tank.gasRemaining_l),
  }));
  const legacyCcr = checkpoint.ccr;
  const ccr =
    checkpoint.state.diveMode === "ccr" && legacyCcr
      ? {
          ...createCcrState(
            createGasMix(legacyCcr.diluent.fO2, legacyCcr.diluent.fHe),
            {
              targetPo2Bar: bars(legacyCcr.targetPO2_bar),
              actualPo2Bar: bars(legacyCcr.actualPO2_bar),
              oxygenCylinderPressureBar: bars(legacyCcr.o2Pressure_bar),
              diluentCylinderPressureBar: bars(
                legacyCcr.diluentPressure_bar,
              ),
              scrubberRemainingS: minutesToSeconds(
                minutes(legacyCcr.scrubberRemaining_min),
              ),
            },
          ),
          onBailout: legacyCcr.onBailout,
        }
      : null;
  const initialState = createInitialDiveState(seed, {
    tanks,
    activeTankIndex: checkpoint.state.activeTankIndex,
    surfaceAirConsumptionLpm: checkpoint.configuration?.amv_lpm,
    ccr,
  });
  const tissues: TissueState = {
    nitrogenBar: checkpoint.tissues.n2_bar.map(bars),
    heliumBar: checkpoint.tissues.he_bar.map(bars),
  };

  return freezeDiveState({
    ...initialState,
    elapsedTimeS: minutesToSeconds(minutes(checkpoint.state.diveTime_min)),
    depthM: metres(checkpoint.state.depth_m),
    maxDepthM: metres(checkpoint.state.maxDepth_m),
    tissues,
    randomState: normalizeSeed(seed),
    surfaceAirConsumptionLpm: litresPerMinute(
      checkpoint.configuration?.amv_lpm ??
        initialState.surfaceAirConsumptionLpm,
    ),
  });
}
