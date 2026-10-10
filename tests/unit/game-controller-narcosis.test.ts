import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GameController, type GameFrame } from "../../src/app/game-controller";
import { neutralBcdSurfaceLitres } from "../../src/core/buoyancy";
import { createInitialDiveState, freezeDiveState, type DiveState } from "../../src/core/dive-state";
import { nextRandom } from "../../src/core/rng";
import { metres, seconds } from "../../src/core/units";

// The controller's side of narcosis's swallowed inputs (#220). The model
// holds the random state, so it draws for all four movement keys in legacy's
// order; the controller asks it once per frame, before the frame moves the
// diver, and acts on what it keeps: A and D along the route, W and S on the
// BCD. The draws themselves are tested in tests/unit/narcosis-effects.test.ts.

const FRAME_MS = 20;
/** FIN_SPEED_MPS (5) over one 20 ms frame. */
const STROKE_M = 0.1;

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

/** A dive under way at 5 m, above the wreck, at a given index. */
function at(narcosisIndex: number, seed = 97): DiveState {
  return freezeDiveState({
    ...createInitialDiveState(seed),
    elapsedTimeS: seconds(300),
    depthM: metres(5),
    maxDepthM: metres(5),
    bcdGasSurfaceLiters: neutralBcdSurfaceLitres(5),
    narcosisIndex,
  });
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
  // The first frame only records its timestamp.
  step(1);
  return { controller, frames };
}

/** How far the diver moved along the route on each of `count` frames. */
function strokes(frames: GameFrame[], count: number): number[] {
  const positions = frames.slice(-(count + 1)).map((frame) => frame.scene.routePositionM);
  return positions.slice(1).map((position, i) => +(position - positions[i]!).toFixed(9));
}

describe("the controller and narcosis's swallowed inputs", () => {
  it("moves on every frame a key is held at index 0.3 or below, and draws nothing", async () => {
    const initial = at(0.3);
    const { controller, frames } = await startController(initial);
    controller.setControl("right", true);
    controller.setControl("descend", true);
    step(40);
    expect(strokes(frames, 40)).toEqual(Array(40).fill(STROKE_M));
    expect(controller.authoritativeState.randomState).toBe(initial.randomState);
    controller.destroy();
  });

  it("asks the model for W, S, A and D before the frame moves, and moves on what it keeps", async () => {
    const initial = at(0.9);
    const { controller, frames } = await startController(initial);
    controller.setControl("ascend", true);
    controller.setControl("right", true);
    step(1);
    // W draws first, D second, then the drift after the physics.
    const w = nextRandom(initial.randomState);
    const d = nextRandom(w.state);
    const drift = nextRandom(d.state);
    expect(controller.authoritativeState.randomState).toBe(drift.state);
    const p = 1 - Math.pow(1 - ((0.9 - 0.3) / 0.7) * 0.6, FRAME_MS / 1000 * 60);
    expect(strokes(frames, 1)).toEqual([d.value > p ? STROKE_M : 0]);
    controller.destroy();
  });

  it("swallows strokes for single frames, without turning the diver", async () => {
    const { controller, frames } = await startController(at(0.9));
    controller.setControl("right", true);
    step(50);
    const moved = strokes(frames, 50);
    expect(moved.filter((m) => m === 0).length).toBeGreaterThan(5);
    expect(moved.filter((m) => m === STROKE_M).length).toBeGreaterThan(5);
    expect(moved.every((m) => m === 0 || m === STROKE_M)).toBe(true);
    expect(frames.slice(-50).every((frame) => frame.scene.facing === 1)).toBe(true);
    controller.destroy();
  });
});
