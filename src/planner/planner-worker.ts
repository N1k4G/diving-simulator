import { DivePlanner } from "./dive-planner";
import {
  isPlannerForecastRequest,
  type PlannerForecastRequest,
  type PlannerForecastResponse,
} from "./worker-protocol";

export function handlePlannerWorkerRequest(
  request: PlannerForecastRequest,
): PlannerForecastResponse {
  try {
    return {
      type: "forecast-result",
      requestId: request.requestId,
      ok: true,
      forecast: new DivePlanner().forecast(request.state, request.settings),
    };
  } catch (error) {
    return {
      type: "forecast-result",
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

interface PlannerWorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  postMessage(response: PlannerForecastResponse): void;
}

const workerScope = globalThis as unknown as PlannerWorkerScope;
if (
  typeof workerScope.addEventListener === "function" &&
  typeof workerScope.postMessage === "function" &&
  typeof document === "undefined"
) {
  workerScope.addEventListener("message", (event) => {
    if (!isPlannerForecastRequest(event.data)) {
      return;
    }
    workerScope.postMessage(handlePlannerWorkerRequest(event.data));
  });
}
