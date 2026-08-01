import { describe, expect, it } from "vitest";

import deployedHeaders from "../../src/_headers?raw";
import { PlannerWorkerClient } from "../../src/app/planner-worker-client";
import { createInitialDiveState } from "../../src/core/dive-state";
import {
  DEFAULT_PLANNER_SETTINGS,
  type PlannerForecast,
} from "../../src/planner/dive-planner";
import { handlePlannerWorkerRequest } from "../../src/planner/planner-worker";
import {
  createPlannerForecastRequest,
  type PlannerForecastRequest,
  type PlannerForecastResponse,
} from "../../src/planner/worker-protocol";

class FakePlannerWorker {
  readonly posted: PlannerForecastRequest[] = [];
  readonly #listeners = new Set<
    (event: MessageEvent<PlannerForecastResponse>) => void
  >();
  terminated = false;

  postMessage(value: unknown): void {
    const request = value as PlannerForecastRequest;
    this.posted.push(request);
    const response = handlePlannerWorkerRequest(request);
    queueMicrotask(() => {
      const event = { data: response } as MessageEvent<PlannerForecastResponse>;
      for (const listener of this.#listeners) {
        listener(event);
      }
    });
  }

  addEventListener(
    _type: "message",
    listener: (event: MessageEvent<PlannerForecastResponse>) => void,
  ): void {
    this.#listeners.add(listener);
  }

  removeEventListener(
    _type: "message",
    listener: (event: MessageEvent<PlannerForecastResponse>) => void,
  ): void {
    this.#listeners.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }
}

describe("planner Worker boundary", () => {
  it("creates a copied typed request and returns a pure forecast", () => {
    const state = createInitialDiveState(60);
    const request = createPlannerForecastRequest(
      7,
      state,
      DEFAULT_PLANNER_SETTINGS,
    );

    const response = handlePlannerWorkerRequest(request);

    expect(request.state).not.toBe(state);
    expect(request.state.tissues.nitrogenBar).not.toBe(
      state.tissues.nitrogenBar,
    );
    expect(response).toMatchObject({
      type: "forecast-result",
      requestId: 7,
      ok: true,
    });
  });

  it("resolves client requests and terminates cleanly", async () => {
    const worker = new FakePlannerWorker();
    const client = new PlannerWorkerClient(worker);

    const forecast: PlannerForecast = await client.forecast(
      createInitialDiveState(61),
      DEFAULT_PLANNER_SETTINGS,
    );
    client.dispose();

    expect(forecast.ceilingM).toBe(0);
    expect(worker.posted).toHaveLength(1);
    expect(worker.terminated).toBe(true);
  });

  it("rejects invalid planner settings across the Worker protocol", () => {
    const request = createPlannerForecastRequest(
      8,
      createInitialDiveState(62),
      { ...DEFAULT_PLANNER_SETTINGS, gfHighPercent: 0 },
    );

    expect(handlePlannerWorkerRequest(request)).toMatchObject({
      type: "forecast-result",
      requestId: 8,
      ok: false,
    });
  });

  it("allows only same-origin workers in the deployed CSP", () => {
    expect(deployedHeaders).toContain("worker-src 'self'");
    expect(deployedHeaders).not.toContain("worker-src blob:");
  });
});
