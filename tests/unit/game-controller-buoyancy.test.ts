import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GameController,
  createWreckInitialState,
  type GameFrame,
} from "../../src/app/game-controller";
import { neutralBcdSurfaceLitres } from "../../src/core/buoyancy";
import { DiveModel, type SharkFrame } from "../../src/core/dive-model";
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
import { DIVER_HALF_HEIGHT_M, DIVER_HALF_WIDTH_M } from "../../src/sites/site-collision";

// The controller's buoyancy wiring (#192 PR 2), on a stubbed animation-frame
// loop. The physics itself is replayed against legacy in
// tests/parity/buoyancy.test.ts; what is pinned here is what the controller
// hands the model each frame: legacy's frame dive time (dtReal capped at
// 0.1 s, times TIME_ACCELERATION, times the fast-forward multiplier), the
// controls (W inflates, S vents) and the wreck it moves the diver through.

/**
 * Open water at the route's start, x 10: the surface to the seabed (#240).
 * A diver who neither fins nor meets a structure moves there as between
 * these bounds.
 */
const ROUTE = { ceilingM: 0, floorM: 66 };
const FRAME_MS = 20;
/** A dive's seed, fixed here as the client's was before each dive drew one (#219). */
const DIVE_SEED = 0x57524543;

/**
 * The shark's world for a diver holding still at the route's start (#219):
 * the controller hands one to every frame, so the shark's roll timer runs.
 */
function still(timeMultiplier: number): SharkFrame {
  return {
    timeMultiplier,
    diverVelocityMps: 0,
    viewLeftM: 21,
    viewRightM: 37,
    floorAt: () => 34,
    noShark: false,
  };
}

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
      expected.advanceWithBuoyancy(ROUTE, seconds((FRAME_MS / 1000) * 3 * 1), { inflate: false, vent: true }, false, still(3));
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
    expected.advanceWithBuoyancy(ROUTE, seconds(0.1 * 3 * 1), { inflate: false, vent: true }, false, still(3));
    expect(controller.authoritativeState).toEqual(expected.snapshot);
    expect(controller.authoritativeState.elapsedTimeS).toBeCloseTo(0.3, 12);
    controller.destroy();
  });

  it("starts a fresh wreck dive at the surface, waiting for S, as legacy's updateSurface (#199)", async () => {
    const initial = createWreckInitialState({}, DIVE_SEED);
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
      expected.advanceWithBuoyancy(ROUTE, seconds((FRAME_MS / 1000) * 3), { inflate: false, vent: true }, false, still(3));
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
      initialState: createWreckInitialState({}, DIVE_SEED),
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
    const { controller, frames } = await startController(createWreckInitialState({}, DIVE_SEED));
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

  it("vents on S, and stops the descent at the seabed (#240)", async () => {
    const { controller, frames } = await startController(neutralAt(65));
    controller.setControl("descend", true);
    step(300);
    const state = controller.authoritativeState;
    expect(state.depthM).toBe(66);
    expect(state.verticalVelocityMpm).toBe(0);
    expect(frames.at(-1)?.scene.diverDepthM).toBe(66);
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
    expected.advanceWithBuoyancy(ROUTE, seconds((FRAME_MS / 1000) * 3), { inflate: false, vent: false }, false, still(3));
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
    expected.advanceWithBuoyancy(ROUTE, seconds((FRAME_MS / 1000) * 3 * 10), { inflate: false, vent: false }, false, still(30));
    expect(controller.authoritativeState).toEqual(expected.snapshot);
    expect(controller.authoritativeState.safetyStop.remainingS).toBeCloseTo(100 - 0.6, 9);
    controller.destroy();
  });

  it("starts a dive saved below the seabed on it, at rest and neutral", async () => {
    const saved = freezeDiveState({ ...neutralAt(70), verticalVelocityMpm: 8 });
    const { controller, frames } = await startController(saved);
    expect(frames[0]?.scene.diverDepthM).toBe(66);
    step(120);
    const state = controller.authoritativeState;
    expect(state.depthM).toBe(66);
    expect(state.verticalVelocityMpm).toBe(0);
    // The deepest point stays the one the save recorded.
    expect(state.maxDepthM).toBe(70);
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
      expected.advanceWithBuoyancy(ROUTE, seconds((FRAME_MS / 1000) * 3 * 1), { inflate: false, vent: false }, false, still(3));
    }
    expect(controller.authoritativeState.log).toEqual(expected.snapshot.log);
    const atDefault = new DiveModel(loaded);
    atDefault.advanceWithBuoyancy(ROUTE, seconds((FRAME_MS / 1000) * 3 * 1), { inflate: false, vent: false }, false, still(3));
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
    expected.advanceWithBuoyancy(ROUTE, seconds((FRAME_MS / 1000) * 3 * 10), { inflate: false, vent: false }, false, still(30));
    expect(controller.authoritativeState).toEqual(expected.snapshot);
    expect(controller.authoritativeState.elapsedTimeS).toBeCloseTo(0.6, 12);
    controller.destroy();
  });
});

// Through legacy's wreck (#240): open water to the surface outside it, its
// decks as the ceiling inside, and its structures, which stop a diver who
// swims or sinks into them. A swim is a couple of thousand frames, which a
// loaded machine runs past vitest's 5 s default.
describe("the route through the wreck", { timeout: 30_000 }, () => {
  const FIN_FRAMES_PER_METRE = 1000 / FRAME_MS / 5;
  /** How far a frame of physics moves the diver at most: a fin stroke, or legacy's 25 m/min for 60 ms. */
  const STEP_M = 0.1;

  /**
   * Into the vehicle deck the way the bow is built: neutral at 18 m off the
   * bow to x 19, over the bow visor's opening between the stem (x 14 to 16)
   * and the main deck (from x 22), then vented down it onto the vehicle
   * deck's floor, the slab at 39 to 40 m. Starts from neutralAt(18).
   */
  function downTheVisor(controller: GameController, frames: GameFrame[]): void {
    controller.setControl("right", true);
    step(9 * FIN_FRAMES_PER_METRE);
    controller.setControl("right", false);
    expect(frames.at(-1)?.scene.routePositionM).toBeCloseTo(19, 9);
    controller.setControl("descend", true);
    for (let i = 0; i < 3000 && controller.authoritativeState.depthM < 26; i += 1) step(1);
    controller.setControl("descend", false);
    for (let i = 0; i < 6000 && controller.authoritativeState.depthM < 38; i += 1) step(1);
    step(100);
    const depthM = controller.authoritativeState.depthM;
    expect(depthM).toBeLessThanOrEqual(39 - DIVER_HALF_HEIGHT_M);
    expect(depthM).toBeGreaterThan(39 - DIVER_HALF_HEIGHT_M - STEP_M);
    expect(controller.authoritativeState.verticalVelocityMpm).toBe(0);
    // The opening is open to the surface: not the overhead yet.
    expect(frames.at(-1)?.scene.zone).toBe("exterior");
    expect(controller.authoritativeState.thirds.startingGasL).toBe(0);
  }

  it("enters the vehicle deck under the main deck, where the overhead runs the rule of thirds", async () => {
    const { controller, frames } = await startController(neutralAt(18));
    downTheVisor(controller, frames);
    controller.setControl("right", true);
    step(31 * FIN_FRAMES_PER_METRE);
    controller.setControl("right", false);
    expect(frames.at(-1)?.scene.routePositionM).toBeCloseTo(50, 9);
    expect(frames.at(-1)?.scene.zone).toBe("cargo-hold");
    // legacy updateDiving, Issue #27: the plan is set on entering the overhead.
    expect(controller.authoritativeState.thirds.startingGasL).toBeGreaterThan(0);

    // Up at a controlled rate, until the main deck (27 to 28 m) holds the
    // diver's body: within a step of 28 m and its half height.
    ascendCarefully(controller, 3000);
    const state = controller.authoritativeState;
    expect(state.depthM).toBeGreaterThanOrEqual(28 + DIVER_HALF_HEIGHT_M);
    expect(state.depthM).toBeLessThan(28 + DIVER_HALF_HEIGHT_M + STEP_M);
    expect(state.verticalVelocityMpm).toBe(0);
    expect(state.completed).toBe(false);
    expect(state.failure.reason).toBeNull();
    controller.destroy();
  });

  it("stops a diver level at 30 m at the bow's stem, outside the overhead", async () => {
    const { controller, frames } = await startController(neutralAt(30));
    controller.setControl("right", true);
    step(40 * FIN_FRAMES_PER_METRE);
    const position = frames.at(-1)?.scene.routePositionM ?? Number.NaN;
    expect(position).toBeLessThanOrEqual(14 - DIVER_HALF_WIDTH_M);
    expect(position).toBeGreaterThan(14 - DIVER_HALF_WIDTH_M - STEP_M);
    expect(frames.at(-1)?.scene.zone).toBe("exterior");
    expect(controller.authoritativeState.thirds.startingGasL).toBe(0);
    controller.destroy();
  });

  it("ends the dive at the surface once the diver has swum out of the wreck through the visor's opening", async () => {
    const { controller, frames } = await startController(neutralAt(18));
    downTheVisor(controller, frames);
    controller.setControl("right", true);
    step(31 * FIN_FRAMES_PER_METRE);
    controller.setControl("right", false);
    expect(frames.at(-1)?.scene.zone).toBe("cargo-hold");
    expect(controller.authoritativeState.completed).toBe(false);

    // Forward out from under the main deck into the opening, where the stem
    // stops the diver: the ceiling is the surface again, and legacy's last
    // check in updateDiving() ends the dive there.
    controller.setControl("left", true);
    step(40 * FIN_FRAMES_PER_METRE);
    controller.setControl("left", false);
    const outAt = frames.at(-1)?.scene.routePositionM ?? Number.NaN;
    expect(outAt).toBeGreaterThanOrEqual(16 + DIVER_HALF_WIDTH_M);
    expect(outAt).toBeLessThan(16 + DIVER_HALF_WIDTH_M + STEP_M);
    expect(frames.at(-1)?.scene.zone).toBe("exterior");
    ascendCarefully(controller, 9000);
    const state = controller.authoritativeState;
    expect(state.failure.reason).toBeNull();
    expect(state.completed).toBe(true);
    expect(state.depthM).toBeLessThan(0.3);
    expect(frames.at(-1)?.scene.zone).toBe("exterior");
    // A dive that has ended moves no more.
    const endedAt = frames.at(-1)?.scene.routePositionM;
    step(60);
    expect(frames.at(-1)?.scene.routePositionM).toBe(endedAt);
    expect(controller.authoritativeState).toBe(state);
    controller.destroy();
  });

  it("stops a diver who swims into the main deck's forward edge", async () => {
    // Level with the main deck, 27 to 28 m, over the stem, whose top is at
    // 28 m: the diver passes over the stem and stops at the deck.
    const { controller, frames } = await startController(neutralAt(27.5));
    controller.setControl("right", true);
    step(40 * FIN_FRAMES_PER_METRE);
    const position = frames.at(-1)?.scene.routePositionM ?? Number.NaN;
    expect(position).toBeLessThanOrEqual(22 - DIVER_HALF_WIDTH_M);
    expect(position).toBeGreaterThan(22 - DIVER_HALF_WIDTH_M - STEP_M);
    expect(frames.at(-1)?.scene.zone).toBe("exterior");
    controller.destroy();
  });

  it("swims over the superstructure in open water, and lands on its roof", async () => {
    const { controller, frames } = await startController(neutralAt(10));
    controller.setControl("right", true);
    step(50 * FIN_FRAMES_PER_METRE);
    controller.setControl("right", false);
    expect(frames.at(-1)?.scene.routePositionM).toBeCloseTo(60, 9);
    expect(frames.at(-1)?.scene.zone).toBe("exterior");
    expect(controller.authoritativeState.thirds.startingGasL).toBe(0);

    // The accommodation's roof, 22 to 23 m.
    controller.setControl("descend", true);
    step(1500);
    const depthM = controller.authoritativeState.depthM;
    expect(depthM).toBeLessThanOrEqual(22 - DIVER_HALF_HEIGHT_M);
    expect(depthM).toBeGreaterThan(22 - DIVER_HALF_HEIGHT_M - STEP_M);
    expect(frames.at(-1)?.scene.zone).toBe("exterior");
    controller.destroy();
  });
});
