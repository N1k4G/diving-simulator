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

  emit(data: PlannerForecastResponse): void {
    const event = { data } as MessageEvent<PlannerForecastResponse>;
    for (const listener of this.#listeners) {
      listener(event);
    }
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

describe("PlannerWorkerClient liveness", () => {
  // A worker that dies or hangs emits no message event. Without a deadline the
  // promise never settles, and a caller that guards against overlapping
  // requests stops forecasting for good while still presenting its last
  // ceiling, NDL and TTS as current.
  class SilentWorker {
    terminated = false;
    postMessage(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
    terminate(): void {
      this.terminated = true;
    }
  }

  it("rejects a forecast the worker never answers", async () => {
    const client = new PlannerWorkerClient(new SilentWorker(), 20);

    await expect(
      client.forecast(createInitialDiveState(0), DEFAULT_PLANNER_SETTINGS),
    ).rejects.toThrow(/timed out after 20 ms/);

    client.dispose();
  });

  it("accepts a later forecast after one times out", async () => {
    const worker = new SilentWorker();
    const client = new PlannerWorkerClient(worker, 20);

    await expect(
      client.forecast(createInitialDiveState(0), DEFAULT_PLANNER_SETTINGS),
    ).rejects.toThrow(/timed out/);

    // The client must not latch into a failed state: the caller retries on its
    // next tick and needs the request to be accepted and to settle again.
    await expect(
      client.forecast(createInitialDiveState(0), DEFAULT_PLANNER_SETTINGS),
    ).rejects.toThrow(/timed out/);

    client.dispose();
  });

  it("rejects an invalid timeout rather than disabling the deadline", () => {
    expect(() => new PlannerWorkerClient(new SilentWorker(), 0)).toThrow(
      RangeError,
    );
    expect(() => new PlannerWorkerClient(new SilentWorker(), Number.NaN)).toThrow(
      RangeError,
    );
  });

  it("ignores a malformed message instead of throwing in the listener", async () => {
    const worker = new FakePlannerWorker();
    const client = new PlannerWorkerClient(worker, 500);
    const forecast = client.forecast(
      createInitialDiveState(0),
      DEFAULT_PLANNER_SETTINGS,
    );

    worker.emit(undefined as unknown as PlannerForecastResponse);

    await expect(forecast).resolves.toBeDefined();
    client.dispose();
  });
});
