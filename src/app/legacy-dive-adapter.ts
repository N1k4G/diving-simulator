import {
  freezeDiveState,
  type DiveState,
  type TissueState,
} from "../core/dive-state";
import { normalizeSeed } from "../core/rng";
import { bars, metres, minutes, minutesToSeconds } from "../core/units";

export interface LegacyTissueCheckpoint {
  state: {
    depth_m: number;
    maxDepth_m: number;
    diveTime_min: number;
  };
  tissues: {
    n2_bar: readonly number[];
    he_bar: readonly number[];
  };
}

export function diveStateFromLegacyCheckpoint(
  checkpoint: LegacyTissueCheckpoint,
  seed = 0,
): DiveState {
  const tissues: TissueState = {
    nitrogenBar: checkpoint.tissues.n2_bar.map(bars),
    heliumBar: checkpoint.tissues.he_bar.map(bars),
  };

  return freezeDiveState({
    elapsedTimeS: minutesToSeconds(minutes(checkpoint.state.diveTime_min)),
    depthM: metres(checkpoint.state.depth_m),
    maxDepthM: metres(checkpoint.state.maxDepth_m),
    tissues,
    randomState: normalizeSeed(seed),
  });
}
