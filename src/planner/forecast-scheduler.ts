import { freezeDiveState, type DiveState } from "../core/dive-state";
import { seconds, type Seconds } from "../core/units";

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
    state.activeTankIndex,
    tankAvailability,
    ccrSignature,
    state.failure.reason ?? "active",
  ].join("|");
}
