import { describe, expect, it } from "vitest";

import { GameController, type GameFrame } from "../../src/app/game-controller";
import {
  CCR_SETPOINT_STEP_BAR,
  createCcrState,
  createGasMix,
  createInitialDiveState,
  freezeDiveState,
  type DiveState,
} from "../../src/core/dive-state";
import { bars, metres, minutes } from "../../src/core/units";
import type { PlannerForecast } from "../../src/planner/dive-planner";

// A forced forecast while one is in flight (#163 review round 1 on PR #182).
//
// A gas switch, a setpoint change or a bailout changes the gas the planner
// breathes, so each forces a fresh forecast. If a periodic request is still
// in flight at that moment, the old #requestForecast returned at its pending
// guard and the force was lost: the in-flight answer, computed for the gas
// the diver had just left, was published, and nothing replaced it until a
// later whole-second step happened to be due. These drive the worker client
// by hand — each forecast() call hands back a promise the test resolves — so
// the ordering is asserted rather than assumed.

function ccrState(): DiveState {
  const ccr = createCcrState(createGasMix(0.21, 0), {
    targetPo2Bar: bars(0.7),
    actualPo2Bar: bars(0.7),
  });
  return freezeDiveState({
    ...createInitialDiveState(61, { ccr }),
    depthM: metres(26),
    maxDepthM: metres(26),
  });
}

function forecastWithNdl(ndlMin: number): PlannerForecast {
  return Object.freeze({
    ceilingM: metres(0),
    ndlMin: minutes(ndlMin),
    schedule: null,
    ttsMin: minutes(3),
  });
}

function createHarness() {
  const frames: GameFrame[] = [];
  const requests: Array<{
    state: DiveState;
    resolve: (forecast: PlannerForecast) => void;
  }> = [];
  const controller = new GameController({
    renderer: {
      kind: "pixi",
      mount: () => Promise.resolve(),
      render: () => undefined,
      resize: () => undefined,
      destroy: () => undefined,
    },
    onFrame: (frame) => {
      frames.push(frame);
    },
    initialState: ccrState(),
    plannerClient: {
      forecast: (state: DiveState) =>
        new Promise<PlannerForecast>((resolve) => {
          requests.push({ state, resolve });
        }),
      dispose: () => undefined,
    } as unknown as ConstructorParameters<
      typeof GameController
    >[0]["plannerClient"],
  });
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return { controller, frames, requests, settle };
}

describe("a forced forecast while one is in flight", () => {
  it("is issued once the in-flight request settles, and the stale answer is dropped", async () => {
    const { controller, frames, requests, settle } = createHarness();

    // First discrete act: a request goes out for a 0.8 bar loop.
    controller.adjustSetpoint(CCR_SETPOINT_STEP_BAR);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.state.ccr?.targetPo2Bar).toBe(0.8);

    // Second act while the first is in flight: nothing can go out yet, but
    // the force must not be lost.
    controller.adjustSetpoint(CCR_SETPOINT_STEP_BAR);
    expect(requests).toHaveLength(1);

    // The first answer lands. It describes a 0.8 bar loop the diver has
    // left for 0.9, so it is not what the HUD shows — and a replacement is
    // requested at once, from the current state.
    requests[0]?.resolve(forecastWithNdl(80));
    await settle();
    expect(frames.at(-1)?.presentation.planner).toBeNull();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.state.ccr?.targetPo2Bar).toBe(0.9);

    // The replacement is what reaches the screen.
    requests[1]?.resolve(forecastWithNdl(90));
    await settle();
    expect(frames.at(-1)?.presentation.planner?.ndlMin).toBe(90);
  });

  it("publishes an unsuperseded answer as before", async () => {
    // The guard must not swallow the ordinary case: one request, one
    // answer, published.
    const { controller, frames, requests, settle } = createHarness();

    controller.adjustSetpoint(CCR_SETPOINT_STEP_BAR);
    requests[0]?.resolve(forecastWithNdl(80));
    await settle();

    expect(frames.at(-1)?.presentation.planner?.ndlMin).toBe(80);
    expect(requests).toHaveLength(1);
  });

  it("clears an answered forecast the moment the breathed gas changes", async () => {
    // #163 review round 2 on PR #182. The forecast on screen was computed
    // for the gas before the act; showing it beside the new breathing state
    // until the worker answers paired two different gases in one HUD.
    const { controller, frames, requests, settle } = createHarness();

    controller.adjustSetpoint(CCR_SETPOINT_STEP_BAR);
    requests[0]?.resolve(forecastWithNdl(80));
    await settle();
    expect(frames.at(-1)?.presentation.planner?.ndlMin).toBe(80);

    controller.bailOut();
    // The frame published by the bailout already carries no forecast.
    expect(frames.at(-1)?.presentation.ccr?.onBailout).toBe(true);
    expect(frames.at(-1)?.presentation.planner).toBeNull();

    requests[1]?.resolve(forecastWithNdl(40));
    await settle();
    expect(frames.at(-1)?.presentation.planner?.ndlMin).toBe(40);
  });

  it("collapses several forces during one flight into a single replacement", async () => {
    // Three presses while one request is pending: one replacement, computed
    // from the state after all three, not three requests.
    const { controller, requests, settle } = createHarness();

    controller.adjustSetpoint(CCR_SETPOINT_STEP_BAR);
    controller.adjustSetpoint(CCR_SETPOINT_STEP_BAR);
    controller.adjustSetpoint(CCR_SETPOINT_STEP_BAR);
    controller.bailOut();
    expect(requests).toHaveLength(1);

    requests[0]?.resolve(forecastWithNdl(80));
    await settle();

    expect(requests).toHaveLength(2);
    expect(requests[1]?.state.ccr?.onBailout).toBe(true);
    expect(requests[1]?.state.ccr?.targetPo2Bar).toBe(1);
  });
});
