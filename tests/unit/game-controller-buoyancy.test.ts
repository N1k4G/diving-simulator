import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GameController,
  createWreckInitialState,
  type GameFrame,
} from "../../src/app/game-controller";
import { neutralBcdSurfaceLitres } from "../../src/core/buoyancy";
import { DiveModel } from "../../src/core/dive-model";
import {
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
  type DiveState,
} from "../../src/core/dive-state";
import { bars, metres, seconds } from "../../src/core/units";
import { DEFAULT_PLANNER_SETTINGS, type PlannerSettings } from "../../src/planner/dive-planner";

// The controller's buoyancy wiring (#192 PR 2), on a stubbed animation-frame
// loop. The physics itself is replayed against legacy in
// tests/parity/buoyancy.test.ts; what is pinned here is what the controller
// hands the model each frame: legacy's frame dive time (dtReal capped at
// 0.1 s, times TIME_ACCELERATION, times the fast-forward multiplier), the
// controls (W inflates, S vents) and the route's bounds.

const ROUTE = { ceilingM: 18, floorM: 34 };
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

function step(frames: number, frameMs = FRAME_MS): void {
  for (let i = 0; i < frames; i += 1) {
    nowMs += frameMs;
    const due = queue;
    queue = [];
    for (const callback of due) callback(nowMs);
  }
}

async function startController(
  initialState: DiveState,
  plannerSettings: Readonly<PlannerSettings> = DEFAULT_PLANNER_SETTINGS,
) {
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
    plannerSettings,
    plannerClient: {
      forecast: () => new Promise(() => undefined),
      dispose: () => undefined,
    } as unknown as ConstructorParameters<typeof GameController>[0]["plannerClient"],
  });
  await controller.start({} as HTMLElement);
  // The first frame only records its timestamp: legacy's first dtReal is 0.
  step(1);
  return { controller, frames };
}

function neutralAt(depthM: number, base: DiveState = createInitialDiveState(11)): DiveState {
  return freezeDiveState({
    ...base,
    depthM: metres(depthM),
    maxDepthM: metres(Math.max(depthM, base.maxDepthM)),
    bcdGasSurfaceLiters: neutralBcdSurfaceLitres(depthM),
  });
}

describe("the controller drives the buoyancy model frame by frame", () => {
  it("hands the model each frame's real time times three, with S venting", async () => {
    const initial = neutralAt(26);
    const { controller } = await startController(initial);
    controller.setControl("descend", true);
    step(30);

    const expected = new DiveModel(initial);
    for (let i = 0; i < 30; i += 1) {
      expected.advanceWithBuoyancy(ROUTE, seconds((FRAME_MS / 1000) * 3 * 1), { inflate: false, vent: true });
    }
    expect(controller.authoritativeState).toEqual(expected.snapshot);
    expect(controller.authoritativeState.verticalVelocityMpm).toBeGreaterThan(0);
    controller.destroy();
  });

  it("caps a slow frame at 0.1 s real, as legacy's gameLoop()", async () => {
    const initial = neutralAt(26);
    const { controller } = await startController(initial);
    controller.setControl("descend", true);
    step(1, 250);

    const expected = new DiveModel(initial);
    expected.advanceWithBuoyancy(ROUTE, seconds(0.1 * 3 * 1), { inflate: false, vent: true });
    expect(controller.authoritativeState).toEqual(expected.snapshot);
    expect(controller.authoritativeState.elapsedTimeS).toBeCloseTo(0.3, 12);
    controller.destroy();
  });

  it("keeps a fresh wreck dive neutral at its start depth", async () => {
    const initial = createWreckInitialState();
    expect(initial.bcdGasSurfaceLiters).toBe(neutralBcdSurfaceLitres(26));
    const { controller, frames } = await startController(initial);
    step(60);
    expect(controller.authoritativeState.depthM).toBe(26);
    expect(controller.authoritativeState.verticalVelocityMpm).toBe(0);
    expect(controller.authoritativeState.elapsedTimeS).toBeCloseTo(60 * 0.06, 9);
    expect(frames.at(-1)?.scene.diverDepthM).toBe(26);
    controller.destroy();
  });

  it("inflates on W from the breathed cylinder, and stops the ascent at the route's ceiling", async () => {
    const { controller, frames } = await startController(neutralAt(19));
    controller.setControl("ascend", true);
    step(300);
    const state = controller.authoritativeState;
    expect(state.depthM).toBe(18);
    expect(state.verticalVelocityMpm).toBe(0);
    expect(state.bcdGasSurfaceLiters).toBeGreaterThan(neutralBcdSurfaceLitres(19) + 5);
    expect(frames.at(-1)?.scene.diverDepthM).toBe(18);
    controller.destroy();
  });

  it("vents on S, and stops the descent at the route's floor", async () => {
    const { controller, frames } = await startController(neutralAt(33));
    controller.setControl("descend", true);
    step(300);
    const state = controller.authoritativeState;
    expect(state.depthM).toBe(34);
    expect(state.verticalVelocityMpm).toBe(0);
    expect(frames.at(-1)?.scene.diverDepthM).toBe(34);
    controller.destroy();
  });

  it("keeps moving on its momentum after the key is released", async () => {
    const { controller } = await startController(neutralAt(26));
    controller.setControl("descend", true);
    step(50);
    controller.setControl("descend", false);
    const released = controller.authoritativeState;
    step(50);
    // Nothing held, and the diver still sinks: the vented BCD, not the key,
    // moves it now. The old view moved only while a key was down.
    expect(controller.authoritativeState.depthM).toBeGreaterThan(released.depthM + 0.5);
    controller.destroy();
  });

  it("starts a dive saved above the route at its ceiling, at rest and neutral", async () => {
    // A legacy save at 12 m, neutral there and rising: moved to 18 m with that
    // gas it would arrive heavy and sink to the floor (#198 pre-review).
    const saved = freezeDiveState({ ...neutralAt(12), verticalVelocityMpm: -6 });
    const { controller, frames } = await startController(saved);
    expect(frames[0]?.scene.diverDepthM).toBe(18);
    step(120);
    const state = controller.authoritativeState;
    expect(state.depthM).toBe(18);
    expect(state.verticalVelocityMpm).toBe(0);
    expect(state.bcdGasSurfaceLiters).toBe(neutralBcdSurfaceLitres(18));
    controller.destroy();
  });

  it("starts a dive saved below the route at its floor, at rest and neutral", async () => {
    const saved = freezeDiveState({ ...neutralAt(40), verticalVelocityMpm: 8 });
    const { controller, frames } = await startController(saved);
    expect(frames[0]?.scene.diverDepthM).toBe(34);
    step(120);
    const state = controller.authoritativeState;
    expect(state.depthM).toBe(34);
    expect(state.verticalVelocityMpm).toBe(0);
    // The deepest point stays the one the save recorded.
    expect(state.maxDepthM).toBe(40);
    controller.destroy();
  });

  it("evaluates the dive log at the dive's GF high (#199)", async () => {
    // A fresh diver at 26 m on air: the NDL is some minutes away, and GF 75
    // and GF 100 put it at different minutes.
    const loaded = neutralAt(26);
    const at100 = { ...DEFAULT_PLANNER_SETTINGS, gfHighPercent: 100 };
    const { controller } = await startController(loaded, at100);
    step(5);
    const expected = new DiveModel(loaded, { gradientFactorHighPercent: 100 });
    for (let i = 0; i < 5; i += 1) {
      expected.advanceWithBuoyancy(ROUTE, seconds((FRAME_MS / 1000) * 3 * 1), { inflate: false, vent: false });
    }
    expect(controller.authoritativeState.log).toEqual(expected.snapshot.log);
    const atDefault = new DiveModel(loaded);
    atDefault.advanceWithBuoyancy(ROUTE, seconds((FRAME_MS / 1000) * 3 * 1), { inflate: false, vent: false });
    expect(controller.authoritativeState.log.minNdlMin ?? 0).toBeGreaterThan(atDefault.snapshot.log.minNdlMin ?? 0);
    controller.destroy();
  });

  it("hands the model ten times that while fast-forwarding at a stop", async () => {
    // Every compartment at 3.0 bar puts the stop at 18 m under the default
    // gradient factors (tests/unit/game-controller-fast-forward.test.ts).
    const base = createInitialDiveState(7, {
      tanks: [createTankState(createGasMix(0.21, 0))],
    });
    const atStop = neutralAt(
      18,
      freezeDiveState({
        ...base,
        maxDepthM: metres(34),
        tissues: {
          nitrogenBar: base.tissues.nitrogenBar.map(() => bars(3)),
          heliumBar: base.tissues.heliumBar,
        },
      }),
    );
    const { controller, frames } = await startController(atStop);
    controller.toggleFastForward();
    expect(frames.at(-1)?.fastForward.active).toBe(true);
    step(1);

    const expected = new DiveModel(atStop);
    expected.advanceWithBuoyancy(ROUTE, seconds((FRAME_MS / 1000) * 3 * 10), { inflate: false, vent: false });
    expect(controller.authoritativeState).toEqual(expected.snapshot);
    expect(controller.authoritativeState.elapsedTimeS).toBeCloseTo(0.6, 12);
    controller.destroy();
  });
});
