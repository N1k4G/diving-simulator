import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GameController,
  createWreckInitialState,
  type GameFrame,
} from "../../src/app/game-controller";
import { neutralBcdSurfaceLitres } from "../../src/core/buoyancy";
import {
  CCR_SETPOINT_STEP_BAR,
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
  type DiveState,
} from "../../src/core/dive-state";
import { bars, metres, seconds } from "../../src/core/units";

// The surface wait and the end of the dive at the controller (#223
// pre-review): legacy's 'surface' state reads S and nothing else, S sets
// updateSurface()'s BCD, and a dive that has ended takes no keys.

type KeyHandler = (event: KeyboardEvent) => void;

const FRAME_MS = 20;
/** A dive's seed, fixed here as the client's was before each dive drew one (#219). */
const DIVE_SEED = 0x57524543;
let queue: FrameRequestCallback[] = [];
let nowMs = 0;
let listeners: Map<string, KeyHandler>;

beforeEach(() => {
  queue = [];
  nowMs = 0;
  listeners = new Map();
  vi.stubGlobal("window", {
    addEventListener: (type: string, handler: KeyHandler) => listeners.set(type, handler),
    removeEventListener: () => undefined,
  });
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

function step(frames: number): void {
  for (let i = 0; i < frames; i += 1) {
    nowMs += FRAME_MS;
    const due = queue;
    queue = [];
    for (const callback of due) callback(nowMs);
  }
}

async function startController(initialState: DiveState) {
  const frames: GameFrame[] = [];
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
    plannerClient: {
      forecast: () => new Promise(() => undefined),
      dispose: () => undefined,
    } as unknown as ConstructorParameters<typeof GameController>[0]["plannerClient"],
  });
  await controller.start({} as HTMLElement);
  step(1);
  return { controller, frames };
}

/** Presses a key through the controller's own listener; true if it claimed it. */
function press(key: string, type: "keydown" | "keyup" = "keydown"): boolean {
  const preventDefault = vi.fn();
  listeners.get(type)?.({ key, repeat: false, preventDefault } as unknown as KeyboardEvent);
  return preventDefault.mock.calls.length > 0;
}

function twoCylinders(): DiveState {
  return createWreckInitialState({
    tanks: [createTankState(createGasMix(0.21, 0)), createTankState(createGasMix(0.32, 0))],
  }, DIVE_SEED);
}

function rebreather(): DiveState {
  return createWreckInitialState({ ccr: createCcrState(createGasMix(0.21, 0)) }, DIVE_SEED);
}

describe("waiting at the surface, as legacy's updateSurface()", () => {
  it("switches no cylinder, by key or by button, and leaves the digit keys alone", async () => {
    const { controller } = await startController(twoCylinders());
    expect(press("2")).toBe(false);
    controller.requestTankSwitch(1);
    // Not kept for a later frame either (#202).
    controller.setControl("descend", true);
    step(1);
    expect(controller.authoritativeState.activeTankIndex).toBe(0);
    expect(controller.authoritativeState.events).toHaveLength(0);

    // Once the dive has begun, the same press switches, on the next frame.
    expect(press("2")).toBe(true);
    step(1);
    expect(controller.authoritativeState.activeTankIndex).toBe(1);
    controller.destroy();
  });

  it("neither bails out nor moves the setpoint, by key or by button", async () => {
    const { controller } = await startController(rebreather());
    const target = controller.authoritativeState.ccr?.targetPo2Bar;
    expect(press("b")).toBe(false);
    expect(press("]")).toBe(false);
    controller.bailOut();
    controller.adjustSetpoint(CCR_SETPOINT_STEP_BAR);
    // Not kept for a later frame either (#202).
    controller.setControl("descend", true);
    step(1);
    expect(controller.authoritativeState.ccr?.onBailout).toBe(false);
    expect(controller.authoritativeState.ccr?.targetPo2Bar).toBe(target);

    controller.bailOut();
    step(1);
    expect(controller.authoritativeState.ccr?.onBailout).toBe(true);
    controller.destroy();
  });

  it("works no torch, by key or by button, while the waves still move", async () => {
    // Legacy reads T inside updateDiving() only (#223 Codex round 1).
    const { controller, frames } = await startController(createWreckInitialState({}, DIVE_SEED));
    const torch = frames.at(-1)?.scene.torchOn;
    const waves = frames.at(-1)?.scene.elapsedRealS ?? 0;
    expect(press("t")).toBe(false);
    controller.toggleTorch();
    step(10);
    expect(frames.at(-1)?.scene.torchOn).toBe(torch);
    expect(frames.at(-1)?.scene.elapsedRealS).toBeGreaterThan(waves);

    controller.setControl("descend", true);
    expect(press("t")).toBe(true);
    expect(frames.at(-1)?.scene.torchOn).toBe(!torch);
    controller.destroy();
  });

  it("leaves the surface with legacy's 2 L in the BCD, at rest, even from a save holding 0 L", async () => {
    // A legacy save written in 'surface': resetDive() leaves the BCD empty.
    const legacySurface = freezeDiveState({
      ...createWreckInitialState({}, DIVE_SEED),
      bcdGasSurfaceLiters: 0,
    });
    const { controller, frames } = await startController(legacySurface);
    expect(frames.at(-1)?.awaitingDescent).toBe(true);
    controller.setControl("descend", true);
    expect(controller.authoritativeState.bcdGasSurfaceLiters).toBe(2);
    expect(controller.authoritativeState.verticalVelocityMpm).toBe(0);
    controller.destroy();
  });

  it("sets the loop's PO2 as legacy does on leaving the surface", async () => {
    const waiting = rebreather();
    const loop = waiting.ccr!;
    const { controller } = await startController(
      freezeDiveState({ ...waiting, ccr: { ...loop, actualPo2Bar: bars(0.9) } }),
    );
    controller.setControl("descend", true);
    // targetSP 0.7 < ambientPressure(0): the loop starts at the setpoint.
    expect(controller.authoritativeState.ccr?.actualPo2Bar).toBe(loop.targetPo2Bar);
    controller.destroy();
  });
});

describe("a dive that has ended", () => {
  it("takes no movement keys and no T, and its scene stops", async () => {
    // Surfacing gently from 1 m on a dive with time and depth behind it.
    const base = createInitialDiveState(5);
    const nearlyUp = freezeDiveState({
      ...base,
      elapsedTimeS: seconds(120),
      depthM: metres(1),
      maxDepthM: metres(10),
      bcdGasSurfaceLiters: neutralBcdSurfaceLitres(1) + 0.4,
    });
    const { controller, frames } = await startController(nearlyUp);
    expect(press("t")).toBe(true);
    step(600);
    expect(controller.authoritativeState.completed).toBe(true);

    const torch = frames.at(-1)?.scene.torchOn;
    for (const key of ["w", "a", "s", "d", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "t"]) {
      expect(press(key), key).toBe(false);
    }
    expect(press("w", "keyup")).toBe(false);
    controller.toggleTorch();
    step(1);
    expect(frames.at(-1)?.scene.torchOn).toBe(torch);
    // The waves and the bubbles stand still: legacy's post-dive state draws
    // no scene (#223 Codex round 1).
    const waves = frames.at(-1)?.scene.elapsedRealS;
    step(60);
    expect(frames.at(-1)?.scene.elapsedRealS).toBe(waves);
    controller.destroy();
  });
});

describe("the dive paused under the help overlay (#160), as legacy skips updateDiving() while showHelp", () => {
  it("moves nothing, lets go of held controls, takes no intent, and runs no time on its first frame after", async () => {
    const { controller, frames } = await startController(twoCylinders());
    controller.setControl("descend", true);
    step(60);
    controller.setControl("descend", false);
    controller.setControl("ascend", true);
    controller.setPaused("help", true);
    const before = controller.authoritativeState;
    const seen = frames.length;
    const last = frames.at(-1);
    step(120);
    expect(press("w") || press("2") || press("t")).toBe(false);
    controller.setControl("descend", true);
    controller.requestTankSwitch(1);
    controller.toggleTorch();
    expect(controller.authoritativeState).toBe(before);
    // The last frame again, every frame, so a warning goes on beeping as
    // legacy's drawDiveComputer() goes on under its help.
    expect(frames.length).toBe(seen + 120);
    expect(frames.slice(seen).every((frame) => frame === last)).toBe(true);

    controller.setPaused("help", false);
    step(1);
    expect(controller.authoritativeState.elapsedTimeS).toBe(before.elapsedTimeS);
    step(1);
    // Neither the W held before it nor the S during it: the BCD is as it was.
    expect(controller.authoritativeState.elapsedTimeS).toBeGreaterThan(before.elapsedTimeS);
    expect(controller.authoritativeState.bcdGasSurfaceLiters).toBe(before.bcdGasSurfaceLiters);
    expect(frames.at(-1)?.scene.torchOn).toBe(true);
    // Nor did the switch asked for during it wait for the end of it.
    expect(controller.authoritativeState.activeTankIndex).toBe(0);
    // The switch lands in the next frame, at legacy's point in it (#202).
    expect(press("2")).toBe(true);
    step(1);
    expect(controller.authoritativeState.activeTankIndex).toBe(1);
    controller.destroy();
  });
});
