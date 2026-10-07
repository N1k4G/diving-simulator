import { freezeDiveState, type DiveState } from "../core/dive-state";
import { seconds, type Seconds } from "../core/units";
import { decoStopDepth } from "../core/decompression";

export const DEFAULT_FORECAST_INTERVAL_SECONDS = seconds(2);

export class ForecastScheduler {
  readonly #minimumIntervalS: Seconds;
  #lastForecastAtS = Number.NEGATIVE_INFINITY;
  #lastSignature = "";

  constructor(minimumIntervalS: Seconds = DEFAULT_FORECAST_INTERVAL_SECONDS) {
    if (minimumIntervalS <= 0) {
      throw new RangeError("forecast interval must be positive");
    }
    this.#minimumIntervalS = minimumIntervalS;
  }

  takeSnapshotIfDue(
    state: DiveState,
    nowS: Seconds,
    force = false,
  ): DiveState | null {
    const signature = forecastInputSignature(state);
    const inputChanged = signature !== this.#lastSignature;
    const intervalElapsed = nowS - this.#lastForecastAtS >= this.#minimumIntervalS;

    if (!force && !inputChanged && !intervalElapsed) {
      return null;
    }

    this.#lastForecastAtS = nowS;
    this.#lastSignature = signature;
    return freezeDiveState(state);
  }

  reset(): void {
    this.#lastForecastAtS = Number.NEGATIVE_INFINITY;
    this.#lastSignature = "";
  }
}

function forecastInputSignature(state: DiveState): string {
  const depthBucketM = Math.floor(state.depthM);
  const tankAvailability = state.tanks
    .map((tank) => (tank.gasRemainingL > 0 ? "1" : "0"))
    .join("");
  const ccrSignature = state.ccr
    ? `${state.ccr.onBailout ? 1 : 0}:${state.ccr.targetPo2Bar}`
    : "oc";

  return [
    depthBucketM,
    // The stop the model's ceiling of this tick names (#226): when it moves
    // to the next one, the forecast on screen names the old stop and the
    // HUD shows the deco stop's title alone until a new one lands, so the
    // new one is asked for at once rather than after the interval.
    decoStopDepth(state.log.lastCeilingM),
    state.activeTankIndex,
    tankAvailability,
    ccrSignature,
    state.failure.reason ?? "active",
  ].join("|");
}
