import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GameController,
  createWreckInitialState,
  type GameFrame,
} from "../../src/app/game-controller";
import { neutralBcdSurfaceLitres } from "../../src/core/buoyancy";
import { freezeDiveState, type DiveState } from "../../src/core/dive-state";
import { litres, metres, seconds } from "../../src/core/units";

// A dive resumed inside the wreck stays there (#222): the controller picks up
// at the saved route position, under the deck with its rule of thirds, and
// hands the position on with every state for the save.

const FRAME_MS = 20;
const DIVE_SEED = 0x57524543;
let queue: FrameRequestCallback[] = [];
let nowMs = 0;

beforeEach(() => {
  queue = [];
  nowMs = 0;
  vi.stubGlobal("window", {
    addEventListener: () => undefined,
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

async function startController(initialState: DiveState, initialRoutePositionM?: number) {
  const frames: GameFrame[] = [];
  const saved: { state: DiveState; routePositionM: number }[] = [];
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
    onAuthoritativeState: (state, session) => {
      saved.push({ state, routePositionM: session.routePositionM });
    },
    initialState,
    initialSession: { routePositionM: initialRoutePositionM },
    plannerClient: {
      forecast: () => new Promise(() => undefined),
      dispose: () => undefined,
    } as unknown as ConstructorParameters<typeof GameController>[0]["plannerClient"],
  });
  await controller.start({} as HTMLElement);
  return { controller, frames, saved };
}

/** The gas the overhead plan was made on: a fifth more than is left. */
const PLAN_GAS_L = 1.2 * createWreckInitialState({}, DIVE_SEED).tanks[0]!.gasRemainingL;

/** Ten minutes into a dive at 30 m, neutral there, inside an overhead plan. */
function underway(depthM = 30): DiveState {
  const initial = createWreckInitialState({}, DIVE_SEED);
  return freezeDiveState({
    ...initial,
    elapsedTimeS: seconds(600),
    depthM: metres(depthM),
    maxDepthM: metres(depthM),
    verticalVelocityMpm: 0,
    bcdGasSurfaceLiters: neutralBcdSurfaceLitres(depthM),
    thirds: { startingGasL: litres(PLAN_GAS_L), turnWarned: false, reserveHit: false },
  });
}

describe("a dive resumed at its saved route position (#222)", () => {
  it("stays in the cargo hold, under the overhead, with the plan it entered on", async () => {
    const { controller, frames, saved } = await startController(underway(), 50);
    expect(frames.at(-1)?.scene.routePositionM).toBe(50);
    expect(frames.at(-1)?.scene.zone).toBe("cargo-hold");
    expect(frames.at(-1)?.presentation.ruleOfThirds?.phase).toBe("outbound");

    step(10);
    // The rule of thirds runs on under the deck, from the plan made on
    // entering, rather than being dropped as outside the overhead.
    expect(controller.authoritativeState.thirds.startingGasL).toBe(PLAN_GAS_L);
    expect(frames.at(-1)?.scene.zone).toBe("cargo-hold");
    expect(frames.at(-1)?.presentation.ruleOfThirds?.phase).toBe("outbound");
    expect(controller.routePositionM).toBe(50);
    expect(saved.at(-1)?.routePositionM).toBe(50);
    controller.destroy();
  });

  it("stays in the engine room", async () => {
    const { controller, frames } = await startController(underway(28), 78);
    step(2);
    expect(frames.at(-1)?.scene.zone).toBe("engine-room");
    expect(controller.authoritativeState.thirds.startingGasL).toBe(PLAN_GAS_L);
    controller.destroy();
  });

  it("hands each new position on for the save as the diver fins", async () => {
    const { controller, saved } = await startController(underway(), 50);
    controller.setControl("right", true);
    step(10);
    controller.setControl("right", false);
    const last = saved.at(-1);
    expect(last?.routePositionM).toBe(controller.routePositionM);
    // 5 m/s of real time for nine timed frames of 20 ms.
    expect(last?.routePositionM).toBeCloseTo(50.9, 9);
    controller.destroy();
  });

  it("picks up at the route's start without a position, out of the overhead, and ends the plan", async () => {
    const { controller, frames } = await startController(underway());
    expect(frames.at(-1)?.scene.routePositionM).toBe(10);
    expect(frames.at(-1)?.scene.zone).toBe("exterior");
    step(2);
    expect(controller.authoritativeState.thirds.startingGasL).toBe(0);
    expect(frames.at(-1)?.presentation.ruleOfThirds).toBeNull();
    controller.destroy();
  });

  it("picks up at the route's start where the saved depth is inside the hull there", async () => {
    // Over the stem, which stands to 24.5 m: 30 m there is solid hull.
    const { controller, frames } = await startController(underway(), 15);
    expect(frames.at(-1)?.scene.routePositionM).toBe(10);
    expect(controller.routePositionM).toBe(10);
    controller.destroy();
  });
});
