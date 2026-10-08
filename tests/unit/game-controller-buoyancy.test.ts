import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GameController,
  createWreckInitialState,
  type GameFrame,
} from "../../src/app/game-controller";
import { neutralBcdSurfaceLitres } from "../../src/core/buoyancy";
import { DiveModel } from "../../src/core/dive-model";
import { createSaveGame } from "../../src/save/save-game";
import {
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
  type DiveState,
} from "../../src/core/dive-state";
import { bars, metres, seconds } from "../../src/core/units";
import { DEFAULT_PLANNER_SETTINGS, type PlannerSettings } from "../../src/planner/dive-planner";
import {
  CARGO_HOLD_FROM_M,
  WRECK_DECK_TOP,
  WRECK_DECK_UNDERSIDE,
  profileAt,
} from "../../src/sites/wreck-route";

// The controller's buoyancy wiring (#192 PR 2), on a stubbed animation-frame
// loop. The physics itself is replayed against legacy in
// tests/parity/buoyancy.test.ts; what is pinned here is what the controller
// hands the model each frame: legacy's frame dive time (dtReal capped at
// 0.1 s, times TIME_ACCELERATION, times the fast-forward multiplier), the
// controls (W inflates, S vents) and the route's bounds.

/** Open water at the route's start: the surface to the floor (#199). */
const ROUTE = { ceilingM: 0, floorM: 34 };
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

/**
 * A careful ascent: inflate while the diver rises slower than 6 m/min, vent
 * while faster than 12, one display frame at a time. Holding W all the way
 * up runs at legacy's 25 m/min cap, which ends the dive in pulmonary
 * barotrauma after 10 s past 18 m/min (#189), as it does in legacy.
 */
function ascendCarefully(controller: GameController, frames: number): void {
  for (let i = 0; i < frames; i += 1) {
    const rate = controller.authoritativeState.log.ascentRateMpm;
    controller.setControl("ascend", rate < 6);
    controller.setControl("descend", rate > 12);
    step(1);
  }
  controller.setControl("ascend", false);
  controller.setControl("descend", false);
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

  it("starts a fresh wreck dive at the surface, waiting for S, as legacy's updateSurface (#199)", async () => {
    const initial = createWreckInitialState();
    // legacy updateSurface: 2 L in the BCD, at rest, on leaving the surface.
    expect(initial.depthM).toBe(0);
    expect(initial.bcdGasSurfaceLiters).toBe(2);
    expect(initial.verticalVelocityMpm).toBe(0);
    const { controller, frames } = await startController(initial);
    expect(frames.at(-1)?.awaitingDescent).toBe(true);
    // Nothing but S starts the dive: no clock, no gas, no fin.
    controller.setControl("right", true);
    controller.setControl("ascend", true);
    step(60);
    controller.setControl("right", false);
    controller.setControl("ascend", false);
    expect(controller.authoritativeState).toEqual(initial);
    expect(frames.at(-1)?.scene.routePositionM).toBe(10);
    expect(frames.at(-1)?.scene.diverDepthM).toBe(0);
    expect(frames.at(-1)?.fastForward.available).toBe(false);

    // S begins it, and the next frames vent, as legacy's next updateDiving().
    controller.setControl("descend", true);
    step(30);
    const expected = new DiveModel(initial);
    for (let i = 0; i < 30; i += 1) {
      expected.advanceWithBuoyancy(ROUTE, seconds((FRAME_MS / 1000) * 3), { inflate: false, vent: true });
    }
    expect(controller.authoritativeState).toEqual(expected.snapshot);
    expect(controller.authoritativeState.depthM).toBeGreaterThan(0);
    expect(frames.at(-1)?.awaitingDescent).toBe(false);
    controller.destroy();
  });

  it("hands the waiting state on for the autosave, as legacy saves in its 'surface' state", async () => {
    const reported: DiveState[] = [];
    const controller = new GameController({
      renderer: {
        kind: "pixi",
        mount: () => Promise.resolve(),
        render: () => undefined,
        resize: () => undefined,
        destroy: () => undefined,
      },
      onFrame: () => undefined,
      onAuthoritativeState: (state) => {
        reported.push(state);
      },
      initialState: createWreckInitialState(),
      plannerClient: {
        forecast: () => new Promise(() => undefined),
        dispose: () => undefined,
      } as unknown as ConstructorParameters<typeof GameController>[0]["plannerClient"],
    });
    await controller.start({} as HTMLElement);
    step(11);
    expect(reported).toHaveLength(10);
    expect(reported.every((state) => state.elapsedTimeS === 0)).toBe(true);
    controller.destroy();
  });

  it("resumes a dive saved before its descent at the surface, still waiting", async () => {
    const { controller, frames } = await startController(createWreckInitialState());
    step(10);
    expect(frames.at(-1)?.awaitingDescent).toBe(true);
    expect(controller.authoritativeState.elapsedTimeS).toBe(0);
    controller.destroy();
  });

  it("inflates on W from the breathed cylinder, and stops the ascent at the surface outside the wreck", async () => {
    const { controller, frames } = await startController(neutralAt(3));
    controller.setControl("ascend", true);
    step(300);
    const state = controller.authoritativeState;
    expect(state.depthM).toBe(0);
    expect(state.verticalVelocityMpm).toBe(0);
    expect(state.bcdGasSurfaceLiters).toBeGreaterThan(neutralBcdSurfaceLitres(3) + 5);
    expect(frames.at(-1)?.scene.diverDepthM).toBe(0);
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

  it("resumes a dive saved at 12 m where it was, with its motion, now that the route is open to the surface (#199)", async () => {
    // A legacy save at 12 m, neutral there and rising. Before #199 the route
    // began at 18 m and this dive was moved down to it.
    const saved = freezeDiveState({ ...neutralAt(12), verticalVelocityMpm: -6 });
    const { controller, frames } = await startController(saved);
    expect(frames[0]?.scene.diverDepthM).toBe(12);
    expect(frames[0]?.awaitingDescent).toBe(false);
    step(1);
    const expected = new DiveModel(saved);
    expected.advanceWithBuoyancy(ROUTE, seconds((FRAME_MS / 1000) * 3), { inflate: false, vent: false });
    expect(controller.authoritativeState).toEqual(expected.snapshot);
    expect(controller.authoritativeState.depthM).toBeLessThan(12);
    controller.destroy();
  });

  it("keeps a saved safety stop under way, and offers fast-forward in its band (#199, deferred from #206)", async () => {
    // A save at 5 m with its countdown running. Before #199 it was moved to
    // 18 m and the stop reset; now the route reaches the band.
    const stop = { needed: true, countdownStarted: true, remainingS: seconds(100), paused: false, complete: false };
    const saved = freezeDiveState({
      ...neutralAt(5, freezeDiveState({ ...createInitialDiveState(13), maxDepthM: metres(24) })),
      elapsedTimeS: seconds(900),
      safetyStop: stop,
    });
    const { controller, frames } = await startController(saved);
    expect(controller.authoritativeState.safetyStop).toEqual(stop);
    expect(() => createSaveGame(controller.authoritativeState, { lowPercent: 35, highPercent: 75 }, 1)).not.toThrow();
    // legacy canFastForward: atSafetyStop, with no vertical key held.
    expect(frames.at(-1)?.fastForward).toEqual({ available: true, active: false });
    controller.toggleFastForward();
    expect(frames.at(-1)?.fastForward).toEqual({ available: true, active: true });
    step(1);
    const expected = new DiveModel(saved);
    expected.advanceWithBuoyancy(ROUTE, seconds((FRAME_MS / 1000) * 3 * 10), { inflate: false, vent: false });
    expect(controller.authoritativeState).toEqual(expected.snapshot);
    expect(controller.authoritativeState.safetyStop.remainingS).toBeCloseTo(100 - 0.6, 9);
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

  it("asks the forecast for the safety stop the dive keeps (#199)", async () => {
    // legacy calculateTTS() reads safetyStopNeeded and ndlDroppedBelow5 from
    // the dive; the forecast used to be sent false for both.
    const requested: PlannerSettings[] = [];
    const base = neutralAt(26);
    const initial = freezeDiveState({
      ...base,
      log: { ...base.log, minNdlMin: 4, ndlDroppedBelowFiveMinutes: true },
      safetyStop: { ...base.safetyStop, needed: true },
    });
    const controller = new GameController({
      renderer: {
        kind: "pixi",
        mount: () => Promise.resolve(),
        render: () => undefined,
        resize: () => undefined,
        destroy: () => undefined,
      },
      onFrame: () => undefined,
      initialState: initial,
      plannerClient: {
        forecast: (_state: DiveState, settings: PlannerSettings) => {
          requested.push(settings);
          return new Promise(() => undefined);
        },
        dispose: () => undefined,
      } as unknown as ConstructorParameters<typeof GameController>[0]["plannerClient"],
    });
    await controller.start({} as HTMLElement);
    expect(requested[0]?.safetyStopNeeded).toBe(true);
    expect(requested[0]?.ndlDroppedBelowFiveMinutes).toBe(true);
    // The configured gradient factors travel unchanged beside them.
    expect(requested[0]?.gfHighPercent).toBe(DEFAULT_PLANNER_SETTINGS.gfHighPercent);
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

// The route through the wreck (#199 slice 7, owner decision A on #199): open
// water to the surface outside the wreck, the deck as the ceiling inside it,
// and the hull in between, which stops a diver who swims into it.
// A swim along the route is a couple of thousand frames, which a loaded
// machine runs past vitest's 5 s default.
describe("the route through the wreck", { timeout: 30_000 }, () => {
  const FIN_FRAMES_PER_METRE = 1000 / FRAME_MS / 5;

  it("enters the cargo hold under the deck, where the deck is the ceiling and the rule of thirds runs", async () => {
    const { controller, frames } = await startController(neutralAt(28));
    controller.setControl("right", true);
    step(40 * FIN_FRAMES_PER_METRE);
    controller.setControl("right", false);
    expect(frames.at(-1)?.scene.routePositionM).toBeCloseTo(50, 9);
    expect(frames.at(-1)?.scene.zone).toBe("cargo-hold");
    // legacy updateDiving, Issue #27: the plan is set on entering the overhead.
    expect(controller.authoritativeState.thirds.startingGasL).toBeGreaterThan(0);

    controller.setControl("ascend", true);
    step(300);
    const state = controller.authoritativeState;
    expect(state.depthM).toBeCloseTo(profileAt(WRECK_DECK_UNDERSIDE, 50), 9);
    expect(state.verticalVelocityMpm).toBe(0);
    expect(state.completed).toBe(false);
    controller.destroy();
  });

  it("is in the overhead under the deck from the drawn hold's start, not from 45 m (#222)", async () => {
    const { controller, frames } = await startController(neutralAt(28));
    controller.setControl("right", true);
    step(25 * FIN_FRAMES_PER_METRE);
    controller.setControl("right", false);
    expect(frames.at(-1)?.scene.routePositionM).toBeCloseTo(35, 9);
    expect(frames.at(-1)?.scene.zone).toBe("cargo-hold");
    expect(controller.authoritativeState.thirds.startingGasL).toBeGreaterThan(0);

    // The deck holds the diver under it there too.
    controller.setControl("ascend", true);
    step(300);
    expect(controller.authoritativeState.depthM).toBeCloseTo(profileAt(WRECK_DECK_UNDERSIDE, 35), 9);
    controller.destroy();
  });

  it("ends the dive at the surface once the diver has swum out of the wreck", async () => {
    // In the hold and out again, neutral at 28 m: the deck as the ceiling is
    // the test above. A diver who left the hold pressed against the deck with
    // the BCD full would rocket up past 18 m/min and end in barotrauma.
    const { controller, frames } = await startController(neutralAt(28));
    controller.setControl("right", true);
    step(40 * FIN_FRAMES_PER_METRE);
    controller.setControl("right", false);
    expect(frames.at(-1)?.scene.zone).toBe("cargo-hold");
    expect(controller.authoritativeState.completed).toBe(false);

    // Out of the hold, the ceiling is the surface again, and legacy's last
    // check in updateDiving() ends the dive there. The diver swims out, then
    // rises at a controlled 6 to 12 m/min: about 24 m in two to four
    // minutes of dive time.
    controller.setControl("left", true);
    step(40 * FIN_FRAMES_PER_METRE);
    controller.setControl("left", false);
    ascendCarefully(controller, 6000);
    const state = controller.authoritativeState;
    expect(state.failure.reason).toBeNull();
    expect(state.completed).toBe(true);
    expect(state.depthM).toBeLessThan(0.3);
    expect(state.thirds.startingGasL).toBe(0);
    expect(frames.at(-1)?.scene.zone).toBe("exterior");
    // A dive that has ended moves no more.
    const endedAt = frames.at(-1)?.scene.routePositionM;
    step(60);
    expect(frames.at(-1)?.scene.routePositionM).toBe(endedAt);
    expect(controller.authoritativeState).toBe(state);
    controller.destroy();
  });

  it("stops a diver who swims into the deck's edge", async () => {
    // Between the top of the deck and its underside where the hold begins.
    const { controller, frames } = await startController(neutralAt(23));
    controller.setControl("right", true);
    step(40 * FIN_FRAMES_PER_METRE);
    const position = frames.at(-1)?.scene.routePositionM ?? Number.NaN;
    expect(position).toBeLessThan(CARGO_HOLD_FROM_M);
    expect(position).toBeGreaterThan(CARGO_HOLD_FROM_M - 0.2);
    expect(frames.at(-1)?.scene.zone).toBe("exterior");
    controller.destroy();
  });

  it("swims over the hold above the deck in open water, and lands on the deck", async () => {
    const { controller, frames } = await startController(neutralAt(10));
    controller.setControl("right", true);
    step(50 * FIN_FRAMES_PER_METRE);
    controller.setControl("right", false);
    expect(frames.at(-1)?.scene.routePositionM).toBeCloseTo(60, 9);
    expect(frames.at(-1)?.scene.zone).toBe("exterior");
    expect(controller.authoritativeState.thirds.startingGasL).toBe(0);

    controller.setControl("descend", true);
    step(1500);
    expect(controller.authoritativeState.depthM).toBeCloseTo(profileAt(WRECK_DECK_TOP, 60), 9);
    controller.destroy();
  });
});
