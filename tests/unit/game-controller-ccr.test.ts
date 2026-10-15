import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
// e2e in tests/in-dive-controls.spec.js drives those paths for real. Each
// act waits for the next frame, which applies it where legacy reads its key
// (#202), so these run the frames.

const FRAME_MS = 20;
let queue: FrameRequestCallback[] = [];
let nowMs = 0;

beforeEach(() => {
  queue = [];
  nowMs = 0;
  vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => queue.push(callback));
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function step(frames = 1): void {
  for (let i = 0; i < frames; i += 1) {
    nowMs += FRAME_MS;
    const due = queue;
    queue = [];
    for (const callback of due) callback(nowMs);
  }
}

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

async function createHarness(initialState: DiveState) {
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
  await controller.start({} as HTMLElement);
  // The first frame has no time and moves nothing.
  step();
  return { controller, frames, authoritative };
}

describe("rebreather controls at the controller", () => {
  it("publishes the new setpoint on the next frame and hands the save the same state", async () => {
    const { controller, frames, authoritative } = await createHarness(ccrState());

    controller.adjustSetpoint(CCR_SETPOINT_STEP_BAR);
    // Nothing moves before the frame that reads it.
    expect(controller.authoritativeState.ccr?.targetPo2Bar).toBe(0.7);

    step();
    expect(frames.at(-1)?.presentation.ccr?.targetPo2Bar).toBe(0.8);
    // The authoritative callback fires with the very state the frame shows.
    expect(authoritative.at(-1)?.ccr?.targetPo2Bar).toBe(0.8);
    expect(authoritative.at(-1)).toBe(controller.authoritativeState);
    controller.destroy();
  });

  it("raises the setpoint once per frame, however often ] is pressed before it", async () => {
    // Legacy holds one flag per key, cleared by the frame that reads it.
    const { controller } = await createHarness(ccrState());
    controller.adjustSetpoint(CCR_SETPOINT_STEP_BAR);
    controller.adjustSetpoint(CCR_SETPOINT_STEP_BAR);
    step();
    expect(controller.authoritativeState.ccr?.targetPo2Bar).toBe(0.8);
    step();
    expect(controller.authoritativeState.ccr?.targetPo2Bar).toBe(0.8);
    controller.destroy();
  });

  it("leaves the setpoint at the bound when the model refuses", async () => {
    const atMax = freezeDiveState({
      ...ccrState(),
      ccr: { ...ccrState().ccr!, targetPo2Bar: bars(1.6) },
    });
    const { controller, frames } = await createHarness(atMax);

    controller.adjustSetpoint(CCR_SETPOINT_STEP_BAR);
    step();

    expect(frames.at(-1)?.presentation.ccr?.targetPo2Bar).toBe(1.6);
    controller.destroy();
  });

  it("does nothing on open circuit", async () => {
    const { controller } = await createHarness(
      freezeDiveState({
        ...createInitialDiveState(52),
        depthM: metres(26),
        maxDepthM: metres(26),
      }),
    );

    controller.adjustSetpoint(CCR_SETPOINT_STEP_BAR);
    controller.bailOut();
    step();

    expect(controller.authoritativeState.ccr).toBeNull();
    expect(controller.authoritativeState.events).toEqual([]);
    controller.destroy();
  });

  it("bails out once, and only once", async () => {
    const { controller, frames, authoritative } = await createHarness(ccrState());

    controller.bailOut();
    step();
    expect(frames.at(-1)?.presentation.ccr?.onBailout).toBe(true);
    expect(authoritative.at(-1)?.events).toEqual([
      { type: "bailout", elapsedTimeS: authoritative.at(-1)?.elapsedTimeS },
    ]);

    controller.bailOut();
    step();
    // Refused by the model.
    expect(
      controller.authoritativeState.events.filter((e) => e.type === "bailout"),
    ).toHaveLength(1);
    controller.destroy();
  });

  it("refuses a setpoint change after the bailout", async () => {
    const { controller } = await createHarness(ccrState());
    controller.bailOut();
    step();

    controller.adjustSetpoint(CCR_SETPOINT_STEP_BAR);
    step();

    expect(controller.authoritativeState.ccr?.targetPo2Bar).toBe(0.7);
    controller.destroy();
  });
});
