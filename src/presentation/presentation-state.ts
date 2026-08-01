import {
  type CcrState,
  type DiveEvent,
  type DiveFailureReason,
  type DiveState,
  type GasMix,
} from "../core/dive-state";
import { resolveInspiredGas } from "../core/dive-model";
import { bars, type Bars, type Litres } from "../core/units";
import type {
  PlannerForecast,
} from "../planner/dive-planner";

export type DiveStatus = "surface" | "diving" | "failed";

export interface PresentationTank {
  readonly index: number;
  readonly gas: Readonly<GasMix>;
  readonly volumeL: Litres;
  readonly gasRemainingL: Litres;
  readonly pressureBar: Bars;
  readonly active: boolean;
}

export interface PresentationDecoStop {
  readonly depthM: number;
  readonly durationMin: number;
}

export interface PresentationDecoSchedule {
  readonly stops: readonly PresentationDecoStop[];
  readonly ttsMin: number;
  readonly outOfGas: boolean;
}

export interface PresentationPlannerForecast {
  readonly ceilingM: number;
  readonly ndlMin: number;
  readonly schedule: PresentationDecoSchedule | null;
  readonly ttsMin: number;
}

export interface PresentationCcr {
  readonly targetPo2Bar: Bars;
  readonly actualPo2Bar: Bars;
  readonly oxygenCylinderPressureBar: Bars;
  readonly diluentCylinderPressureBar: Bars;
  readonly scrubberRemainingS: number;
  readonly onBailout: boolean;
  readonly scrubberFailed: boolean;
}

export interface PresentationState {
  readonly elapsedTimeS: number;
  readonly depthM: number;
  readonly maxDepthM: number;
  readonly status: DiveStatus;
  readonly activeTankIndex: number;
  readonly tanks: readonly PresentationTank[];
  readonly ccr: PresentationCcr | null;
  readonly breathingPo2Bar: Bars;
  readonly failureReason: DiveFailureReason | null;
  readonly events: readonly Readonly<DiveEvent>[];
  readonly planner: PresentationPlannerForecast | null;
}

export function createPresentationState(
  state: DiveState,
  planner: PlannerForecast | null,
): PresentationState {
  const tanks = Object.freeze(
    state.tanks.map((tank, index) =>
      Object.freeze({
        index,
        gas: Object.freeze({ ...tank.gas }),
        volumeL: tank.volumeL,
        gasRemainingL: tank.gasRemainingL,
        pressureBar: selectTankPressureBar(state, index),
        active: index === state.activeTankIndex,
      }),
    ),
  );
  const ccr = state.ccr ? freezePresentationCcr(state.ccr) : null;
  const events = Object.freeze(
    state.events.map((event) => Object.freeze({ ...event })),
  );

  return Object.freeze({
    elapsedTimeS: state.elapsedTimeS,
    depthM: state.depthM,
    maxDepthM: state.maxDepthM,
    status: selectDiveStatus(state),
    activeTankIndex: state.activeTankIndex,
    tanks,
    ccr,
    breathingPo2Bar: selectBreathingPo2Bar(state),
    failureReason: state.failure.reason,
    events,
    planner: planner ? freezePlannerForecast(planner) : null,
  });
}

export function selectDiveStatus(state: DiveState): DiveStatus {
  if (state.failure.reason !== null) {
    return "failed";
  }
  return state.depthM < 0.5 ? "surface" : "diving";
}

export function selectTankPressureBar(
  state: DiveState,
  tankIndex: number,
): Bars {
  const tank = state.tanks[tankIndex];
  if (!tank) {
    throw new RangeError("tank index is outside the tank list");
  }
  return bars(tank.gasRemainingL / tank.volumeL);
}

export function selectBreathingPo2Bar(state: DiveState): Bars {
  const inspiredGas = resolveInspiredGas(
    state.ccr && !state.ccr.onBailout
      ? {
          kind: "ccr",
          actualPo2Bar: state.ccr.actualPo2Bar,
          diluent: state.ccr.diluent,
          onBailout: false,
        }
      : {
          kind: "open-circuit",
          gas:
            state.ccr?.onBailout
              ? state.ccr.diluent
              : state.tanks[state.activeTankIndex]?.gas ??
                state.tanks[0]!.gas,
        },
    state.depthM,
  );
  return bars(inspiredGas.oxygenFraction * (1 + state.depthM / 10));
}

function freezePresentationCcr(ccr: CcrState): PresentationCcr {
  return Object.freeze({
    targetPo2Bar: ccr.targetPo2Bar,
    actualPo2Bar: ccr.actualPo2Bar,
    oxygenCylinderPressureBar: ccr.oxygenCylinderPressureBar,
    diluentCylinderPressureBar: ccr.diluentCylinderPressureBar,
    scrubberRemainingS: ccr.scrubberRemainingS,
    onBailout: ccr.onBailout,
    scrubberFailed: ccr.scrubberFailed,
  });
}

function freezePlannerForecast(
  forecast: PlannerForecast,
): PresentationPlannerForecast {
  const schedule = forecast.schedule
    ? freezeDecoSchedule(forecast.schedule)
    : null;
  return Object.freeze({ ...forecast, schedule });
}

function freezeDecoSchedule(
  schedule: NonNullable<PlannerForecast["schedule"]>,
): PresentationDecoSchedule {
  return Object.freeze({
    ...schedule,
    stops: Object.freeze(
      schedule.stops.map((stop) => Object.freeze({ ...stop })),
    ),
  });
}
