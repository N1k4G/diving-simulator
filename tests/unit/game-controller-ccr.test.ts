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
import { bars, metres } from "../../src/core/units";

// The rebreather controls at the controller (#163), read through the frames
// it publishes and the authoritative states it hands out, without a DOM.
// The keyboard and DOM paths both end in adjustSetpoint() and bailOut(); the
// e2e in tests/in-dive-controls.spec.js drives those paths for real.

function ccrState(depthM = 26): DiveState {
  const ccr = createCcrState(createGasMix(0.21, 0), {
    targetPo2Bar: bars(0.7),
    actualPo2Bar: bars(0.7),
  });
  return freezeDiveState({
    ...createInitialDiveState(51, { ccr }),
    depthM: metres(depthM),
    maxDepthM: metres(depthM),
  });
}

function createHarness(initialState: DiveState) {
  const frames: GameFrame[] = [];
  const authoritative: DiveState[] = [];
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
    onAuthoritativeState: (state) => {
      authoritative.push(state);
    },
    initialState,
    plannerClient: {
      forecast: () => new Promise(() => undefined),
      dispose: () => undefined,
    } as unknown as ConstructorParameters<
      typeof GameController
    >[0]["plannerClient"],
  });
  return { controller, frames, authoritative };
}

describe("rebreather controls at the controller", () => {
  it("publishes the new setpoint and hands the save the same state", () => {
    const { controller, frames, authoritative } = createHarness(ccrState());

    controller.adjustSetpoint(CCR_SETPOINT_STEP_BAR);

    expect(frames.at(-1)?.presentation.ccr?.targetPo2Bar).toBe(0.8);
    // The save must not wait for the next step to hear about it: the
    // authoritative callback fires with the very state the frame shows.
    expect(authoritative.at(-1)?.ccr?.targetPo2Bar).toBe(0.8);
    expect(authoritative.at(-1)).toBe(controller.authoritativeState);
  });

  it("publishes nothing when the model refuses", () => {
    // At the upper bound, a raise changes nothing, so there is no frame and
    // no save — the same silence as a refused gas switch.
    const atMax = freezeDiveState({
      ...ccrState(),
      ccr: { ...ccrState().ccr!, targetPo2Bar: bars(1.6) },
    });
    const { controller, frames, authoritative } = createHarness(atMax);

    controller.adjustSetpoint(CCR_SETPOINT_STEP_BAR);

    expect(frames).toHaveLength(0);
    expect(authoritative).toHaveLength(0);
  });

  it("does nothing on open circuit", () => {
    const { controller, frames } = createHarness(
      freezeDiveState({
        ...createInitialDiveState(52),
        depthM: metres(26),
        maxDepthM: metres(26),
      }),
    );

    controller.adjustSetpoint(CCR_SETPOINT_STEP_BAR);
    controller.bailOut();

    expect(frames).toHaveLength(0);
    expect(controller.authoritativeState.ccr).toBeNull();
  });

  it("bails out once, and only once", () => {
    const { controller, frames, authoritative } = createHarness(ccrState());

    controller.bailOut();
    expect(frames.at(-1)?.presentation.ccr?.onBailout).toBe(true);
    expect(authoritative.at(-1)?.events).toEqual([
      { type: "bailout", elapsedTimeS: 0 },
    ]);

    const published = frames.length;
    controller.bailOut();
    // Refused by the model, so nothing more is published or saved.
    expect(frames).toHaveLength(published);
    expect(
      controller.authoritativeState.events.filter((e) => e.type === "bailout"),
    ).toHaveLength(1);
  });

  it("refuses a setpoint change after the bailout", () => {
    const { controller, frames } = createHarness(ccrState());
    controller.bailOut();
    const published = frames.length;

    controller.adjustSetpoint(CCR_SETPOINT_STEP_BAR);

    expect(frames).toHaveLength(published);
    expect(controller.authoritativeState.ccr?.targetPo2Bar).toBe(0.7);
  });
});
