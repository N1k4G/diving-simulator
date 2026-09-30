import {
  createEmptyDiveLog,
  freezeDiveState,
  type DiveState,
} from "../core/dive-state";
import type {
  PlannerForecast,
  PlannerSettings,
} from "./dive-planner";

export interface PlannerForecastRequest {
  type: "forecast";
  requestId: number;
  state: DiveState;
  settings: PlannerSettings;
}

export interface PlannerForecastSuccess {
  type: "forecast-result";
  requestId: number;
  ok: true;
  forecast: PlannerForecast;
}

export interface PlannerForecastFailure {
  type: "forecast-result";
  requestId: number;
  ok: false;
  error: string;
}

export type PlannerForecastResponse =
  | PlannerForecastSuccess
  | PlannerForecastFailure;

export function createPlannerForecastRequest(
  requestId: number,
  state: DiveState,
  settings: Readonly<PlannerSettings>,
): PlannerForecastRequest {
  if (!Number.isSafeInteger(requestId) || requestId < 0) {
    throw new RangeError("planner request ID must be a non-negative integer");
  }

  return {
    type: "forecast",
    requestId,
    // The forecast reads nothing of the dive log, whose profile grows for the
    // whole dive; it is not cloned into the worker (#204 pre-review).
    state: freezeDiveState({ ...state, log: createEmptyDiveLog() }),
    settings: { ...settings },
  };
}

export function isPlannerForecastRequest(
  value: unknown,
): value is PlannerForecastRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const request = value as Partial<PlannerForecastRequest>;
  return (
    request.type === "forecast" &&
    Number.isSafeInteger(request.requestId) &&
    Boolean(request.state) &&
    Boolean(request.settings)
  );
}
