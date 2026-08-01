import type { DiveState } from "../core/dive-state";
import type {
  PlannerForecast,
  PlannerSettings,
} from "../planner/dive-planner";
import {
  createPlannerForecastRequest,
  type PlannerForecastResponse,
} from "../planner/worker-protocol";

interface PlannerWorkerPort {
  postMessage(value: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<PlannerForecastResponse>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<PlannerForecastResponse>) => void,
  ): void;
  terminate(): void;
}

interface PendingForecast {
  resolve: (forecast: PlannerForecast) => void;
  reject: (reason: Error) => void;
}

export function createPlannerWorker(): Worker {
  return new Worker(
    new URL("../planner/planner-worker.ts", import.meta.url),
    { type: "module", name: "dive-planner" },
  );
}

export class PlannerWorkerClient {
  readonly #worker: PlannerWorkerPort;
  readonly #pending = new Map<number, PendingForecast>();
  #nextRequestId = 0;
  #disposed = false;

  constructor(worker: PlannerWorkerPort = createPlannerWorker()) {
    this.#worker = worker;
    this.#worker.addEventListener("message", this.#handleMessage);
  }

  forecast(
    state: DiveState,
    settings: Readonly<PlannerSettings>,
  ): Promise<PlannerForecast> {
    if (this.#disposed) {
      return Promise.reject(new Error("planner worker client is disposed"));
    }

    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;
    const request = createPlannerForecastRequest(requestId, state, settings);

    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      try {
        this.#worker.postMessage(request);
      } catch (error) {
        this.#pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#worker.removeEventListener("message", this.#handleMessage);
    this.#worker.terminate();
    for (const pending of this.#pending.values()) {
      pending.reject(new Error("planner worker client was disposed"));
    }
    this.#pending.clear();
  }

  readonly #handleMessage = (
    event: MessageEvent<PlannerForecastResponse>,
  ): void => {
    const response = event.data;
    const pending = this.#pending.get(response.requestId);
    if (!pending) {
      return;
    }
    this.#pending.delete(response.requestId);
    if (response.ok) {
      pending.resolve(response.forecast);
    } else {
      pending.reject(new Error(response.error));
    }
  };
}
