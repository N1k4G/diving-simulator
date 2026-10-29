import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GameController,
  createWreckInitialState,
  type GameFrame,
} from "../../src/app/game-controller";
import { neutralBcdSurfaceLitres } from "../../src/core/buoyancy";
import { freezeDiveState, type DiveState } from "../../src/core/dive-state";
import { metres, seconds } from "../../src/core/units";
import type { SessionSnapshot } from "../../src/save/session-snapshot";

// A resumed dive gives back its session (#137 A4b): the route position, the
// facing and the torch as saved, drawn at the state's own depth with no jump,
// and nothing held.

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

function step(frames: number): void {
  for (let i = 0; i < frames; i += 1) {
    nowMs += FRAME_MS;
    const due = queue;
    queue = [];
    for (const callback of due) callback(nowMs);
  }
}

async function resume(initialState: DiveState, initialSession?: Partial<SessionSnapshot>) {
  const frames: GameFrame[] = [];
  const saved: SessionSnapshot[] = [];
  const controller = new GameController({
    renderer: {
      kind: "pixi",
      mount: () => Promise.resolve(),
      render: () => undefined,
      resize: () => undefined,
      destroy: () => undefined,
    },
    onFrame: (frame) => frames.push(frame),
    onAuthoritativeState: (_, session) => saved.push(session),
    initialState,
    initialSession,
    plannerClient: {
      forecast: () => new Promise(() => undefined),
      dispose: () => undefined,
    } as unknown as ConstructorParameters<typeof GameController>[0]["plannerClient"],
  });
  await controller.start({} as HTMLElement);
  return { controller, frames, saved };
}

/** Ten minutes in at 30 m in the cargo hold, neutral there. */
function inTheHold(): DiveState {
  return freezeDiveState({
    ...createWreckInitialState({}, 0x57524543),
    elapsedTimeS: seconds(600),
    depthM: metres(30),
    maxDepthM: metres(30),
    verticalVelocityMpm: 0,
    bcdGasSurfaceLiters: neutralBcdSurfaceLitres(30),
  });
}

const TURNED: SessionSnapshot = { routePositionM: 50, facing: -1, torchOn: false };

describe("a resumed dive's session (#137 A4b)", () => {
  it("is drawn where it was saved: position, facing and torch, at the state's depth, from the first frame", async () => {
    const state = inTheHold();
    const { controller, frames } = await resume(state, TURNED);
    const first = frames[0]!.scene;
    expect(first.routePositionM).toBe(50);
    expect(first.facing).toBe(-1);
    expect(first.torchOn).toBe(false);
    expect(first.diverDepthM).toBe(state.depthM);
    expect(controller.session).toEqual(TURNED);
    controller.destroy();
  });

  it("hands the session on for the save, and a torch turned on with it", async () => {
    const { controller, saved } = await resume(inTheHold(), TURNED);
    step(3);
    expect(saved.at(-1)).toEqual(TURNED);
    controller.toggleTorch();
    step(2);
    expect(saved.at(-1)).toEqual({ ...TURNED, torchOn: true });
    controller.destroy();
  });

  it("draws the diver at the model's depth on every frame: there is no view depth to jump", async () => {
    const state = freezeDiveState({ ...inTheHold(), verticalVelocityMpm: 6 });
    const { controller, frames } = await resume(state, TURNED);
    step(30);
    expect(frames.length).toBeGreaterThan(30);
    for (const frame of frames) {
      expect(frame.scene.diverDepthM).toBe(frame.presentation.depthM);
    }
    expect(frames.at(-1)!.scene.diverDepthM).toBe(controller.authoritativeState.depthM);
    controller.destroy();
  });

  it("holds no control: the diver neither fins, turns nor works the BCD until asked", async () => {
    const state = inTheHold();
    const { controller, frames } = await resume(state, TURNED);
    step(25);
    expect(controller.session).toEqual(TURNED);
    expect(controller.authoritativeState.bcdGasSurfaceLiters).toBe(state.bcdGasSurfaceLiters);
    expect(frames.at(-1)!.fastForward.active).toBe(false);
    controller.destroy();
  });

  it("starts the real time again at 0, as it times only the animation", async () => {
    const { controller, frames } = await resume(inTheHold(), TURNED);
    expect(frames[0]!.scene.elapsedRealS).toBe(0);
    controller.destroy();
  });

  it("is a new dive's without one: the start, facing right, the torch on", async () => {
    const { controller, frames } = await resume(createWreckInitialState({}, 7));
    expect(controller.session).toEqual({ routePositionM: 10, facing: 1, torchOn: true });
    expect(frames[0]!.scene.facing).toBe(1);
    controller.destroy();
  });
});
