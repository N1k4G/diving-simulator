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
  timer: ReturnType<typeof setTimeout>;
}

// A worker that dies, hangs, or drops a message produces no `message` event, so
// without a deadline the promise never settles. A caller that guards against
// overlapping requests would then stop forecasting permanently and keep
// presenting its last ceiling, NDL and TTS as if current. Failing loudly lets
// the caller retry on its next tick instead.
export const DEFAULT_PLANNER_FORECAST_TIMEOUT_MS = 5_000;

export function createPlannerWorker(): Worker {
  return new Worker(
    new URL("../planner/planner-worker.ts", import.meta.url),
    { type: "module", name: "dive-planner" },
  );
}

export class PlannerWorkerClient {
  readonly #worker: PlannerWorkerPort;
  readonly #pending = new Map<number, PendingForecast>();
  readonly #timeoutMs: number;
  #nextRequestId = 0;
  #disposed = false;

  constructor(
    worker: PlannerWorkerPort = createPlannerWorker(),
    timeoutMs: number = DEFAULT_PLANNER_FORECAST_TIMEOUT_MS,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("planner forecast timeout must be positive");
    }
    this.#worker = worker;
    this.#timeoutMs = timeoutMs;
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
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(
          new Error(
            `planner forecast ${requestId} timed out after ${this.#timeoutMs} ms`,
          ),
        );
      }, this.#timeoutMs);

      this.#pending.set(requestId, { resolve, reject, timer });
      try {
        this.#worker.postMessage(request);
      } catch (error) {
        this.#settle(requestId);
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
      clearTimeout(pending.timer);
      pending.reject(new Error("planner worker client was disposed"));
    }
    this.#pending.clear();
  }

  #settle(requestId: number): PendingForecast | undefined {
    const pending = this.#pending.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(requestId);
    }
    return pending;
  }

  readonly #handleMessage = (
    event: MessageEvent<PlannerForecastResponse>,
  ): void => {
    const response = event.data;
    // The port is shared with whatever else the host posts to it, so an
    // unrelated or malformed message must not throw inside the listener.
    if (!response || typeof response !== "object") {
      return;
    }
    const pending = this.#settle(response.requestId);
    if (!pending) {
      return;
    }
    if (response.ok) {
      pending.resolve(response.forecast);
    } else {
      pending.reject(new Error(response.error));
    }
  };
}
