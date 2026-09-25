import { describe, expect, it } from "vitest";

import { GameController, type GameFrame } from "../../src/app/game-controller";
import {
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
  type DiveState,
} from "../../src/core/dive-state";
import { bars, metres } from "../../src/core/units";
import {
  DEFAULT_PLANNER_SETTINGS,
  DivePlanner,
  decoStopDepth,
} from "../../src/planner/dive-planner";

// Fast-forward (#163) at the controller, without a DOM or an animation
// frame. The controller publishes a frame on every discrete act — a gas
// switch, the torch, the fast-forward toggle — so the rule can be read from
// the last frame it handed to onFrame. What needs a running frame loop (the
// clock actually running faster, the auto-cancel on leaving the band) is
// covered in tests/in-dive-controls.spec.js.

/**
 * A diver holding an 18 m stop: every compartment loaded to 3.0 bar of
 * nitrogen puts the ceiling at 17.5 m under the default gradient factors, and
 * decoStop() rounds that up to 18 m. Two cylinders, so a gas switch is
 * possible — it is the one act that forces a forecast without start().
 */
function stateAtStop(depthM = 18): DiveState {
  const base = createInitialDiveState(7, {
    tanks: [
      createTankState(createGasMix(0.21, 0)),
      createTankState(createGasMix(0.32, 0)),
    ],
  });
  return freezeDiveState({
    ...base,
    depthM: metres(depthM),
    maxDepthM: metres(34),
    tissues: {
      nitrogenBar: base.tissues.nitrogenBar.map(() => bars(3)),
      heliumBar: base.tissues.heliumBar,
    },
  });
}

function createHarness(initialState: DiveState) {
  const frames: GameFrame[] = [];
  const planner = new DivePlanner();
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
    initialState,
    // A real forecast, delivered the way the worker would: asynchronously.
    plannerClient: {
      forecast: (state: DiveState) =>
        Promise.resolve(planner.forecast(state, DEFAULT_PLANNER_SETTINGS)),
      dispose: () => undefined,
    } as unknown as ConstructorParameters<
      typeof GameController
    >[0]["plannerClient"],
  });
  const last = () => {
    const frame = frames.at(-1);
    if (!frame) {
      throw new Error("no frame has been published yet");
    }
    return frame.fastForward;
  };
  // The forecast lands in a later microtask; this lets it.
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return { controller, frames, last, settle };
}

describe("fast-forward at the controller", () => {
  it("the fixture really is at an 18 m stop", () => {
    const forecast = new DivePlanner().forecast(
      stateAtStop(),
      DEFAULT_PLANNER_SETTINGS,
    );
    expect(decoStopDepth(forecast.ceilingM)).toBe(18);
  });

  it("is not on offer until a forecast says there is a stop", () => {
    const { controller, last } = createHarness(stateAtStop());

    // Nothing has been forecast, so there is no stop to hold, so the toggle
    // is refused and publishes nothing. The torch is the probe: it publishes
    // a frame without touching the fast-forward state.
    controller.toggleFastForward();
    controller.toggleTorch();

    expect(last()).toEqual({ available: false, active: false });
  });

  it("toggles once the forecast places the diver at a stop", async () => {
    const { controller, last, settle } = createHarness(stateAtStop());
    controller.requestTankSwitch(1);
    await settle();
    expect(last().available).toBe(true);

    controller.toggleFastForward();
    expect(last()).toEqual({ available: true, active: true });

    controller.toggleFastForward();
    expect(last()).toEqual({ available: true, active: false });
  });

  it("is not on offer 1.6 m below the stop", async () => {
    // Just outside legacy's `Math.abs(depth - decoStopD) <= 1.5`.
    const { controller, last, settle } = createHarness(stateAtStop(19.6));
    controller.requestTankSwitch(1);
    await settle();

    controller.toggleFastForward();
    expect(last()).toEqual({ available: false, active: false });
  });

  it("stops when a vertical control is pressed and does not resume on release", async () => {
    const { controller, last, settle } = createHarness(stateAtStop());
    controller.requestTankSwitch(1);
    await settle();
    controller.toggleFastForward();
    expect(last().active).toBe(true);

    // src/game-loop.js: `canFastForward && !keys['w'] && ...` else
    // `fastForwardActive = false`. Not offered while held, and off.
    controller.setControl("ascend", true);
    controller.toggleTorch();
    expect(last()).toEqual({ available: false, active: false });

    // Pressing F while the key is held is refused too.
    controller.toggleFastForward();
    controller.toggleTorch();
    expect(last()).toEqual({ available: false, active: false });

    // Releasing offers the control again but does not switch it back on:
    // legacy cleared the flag, and only a new edge on F sets it.
    controller.setControl("ascend", false);
    controller.toggleTorch();
    expect(last()).toEqual({ available: true, active: false });
  });

  it("a gas switch ends it", async () => {
    // src/game-loop.js TASK-019 sets fastForwardActive = false on a switch.
    const { controller, last, settle } = createHarness(stateAtStop());
    controller.requestTankSwitch(1);
    await settle();
    controller.toggleFastForward();
    expect(last().active).toBe(true);

    controller.requestTankSwitch(0);
    expect(last().active).toBe(false);
    expect(controller.authoritativeState.activeTankIndex).toBe(0);
  });

  it("a refused switch leaves it running", async () => {
    // The cancel belongs to an actual switch. Asking for the cylinder
    // already breathed changes nothing, so it must not stop the clock.
    const { controller, last, settle } = createHarness(stateAtStop());
    controller.requestTankSwitch(1);
    await settle();
    controller.toggleFastForward();

    controller.requestTankSwitch(1);
    controller.toggleTorch();
    expect(last().active).toBe(true);
  });
});
