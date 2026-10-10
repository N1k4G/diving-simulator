import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GameController, type GameFrame } from "../../src/app/game-controller";
import { neutralBcdSurfaceLitres } from "../../src/core/buoyancy";
import { DiveModel, SHARK_SPEED_MPS, type SharkFrame } from "../../src/core/dive-model";
import {
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
  type DiveState,
  type SharkEncounter,
} from "../../src/core/dive-state";
import { nextRandom } from "../../src/core/rng";
import { bars, metres, seconds } from "../../src/core/units";
import { wreckViewAround } from "../../src/render/camera";
import { SITE_GAMEPLAY } from "../../src/sites/site-resources";
import { ROUTE_START_POSITION_M, floorUnder } from "../../src/sites/wreck-route";

// The controller's shark wiring (#219 part 2): what it hands the model each
// frame as DiveEnvironment.shark, and the shark it hands the scene. The
// encounter itself is tested in tests/unit/shark-encounter.test.ts and
// replayed against legacy in tests/parity/shark-encounter.test.ts.

const FRAME_MS = 20;
/** The route's start: the camera's bound holds the view 10 m behind, 48 m ahead. */
const START_VIEW = { leftM: 10, rightM: 48 };

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
  vi.restoreAllMocks();
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
  // The first frame only records its timestamp.
  step(1);
  return { controller, frames };
}

/** The first seed whose first roll passes `test`. */
function seedWhoseFirstRoll(test: (value: number) => boolean): number {
  for (let seed = 0; ; seed += 1) {
    if (test(nextRandom(seed).value)) return seed;
  }
}

/** A diver neutral at 18 m off the bow, on `seed`, with this shark. */
function at18(seed: number, encounter: Partial<SharkEncounter> | null, timerS = 60): DiveState {
  const base = createInitialDiveState(seed, { tanks: [createTankState(createGasMix(0.21, 0))] });
  return freezeDiveState({
    ...base,
    depthM: metres(18),
    maxDepthM: metres(18),
    elapsedTimeS: seconds(120),
    bcdGasSurfaceLiters: neutralBcdSurfaceLitres(18),
    shark: {
      timerS: seconds(timerS),
      encounter: encounter && {
        offsetM: -20,
        depthM: metres(18),
        direction: 1,
        speedMps: SHARK_SPEED_MPS,
        passed: false,
        ...encounter,
      },
    },
  });
}

/** The shark's world the controller handed the model on its last frame. */
function lastSharkFrame(spy: { mock: { calls: unknown[][] } }): SharkFrame {
  const frame = spy.mock.calls.at(-1)?.[4] as SharkFrame | undefined;
  if (!frame) throw new Error("no shark frame was handed to the model");
  return frame;
}

describe("the controller hands the model the shark's world (#219 part 2)", () => {
  it("the clock's rate, the diver's swim, the camera's view, the route's floor and the site's noShark", async () => {
    const spy = vi.spyOn(DiveModel.prototype, "advanceWithBuoyancy");
    const { controller, frames } = await startController(at18(1, null));
    controller.setControl("right", true);
    step(1);
    const frame = lastSharkFrame(spy);
    expect(frame.timeMultiplier).toBe(3);
    // 5 m/s for 20 ms of real time is 0.1 m, over 60 ms of dive time.
    const positionM = frames.at(-1)!.scene.routePositionM;
    expect(positionM).toBeCloseTo(ROUTE_START_POSITION_M + 0.1, 12);
    expect(frame.diverVelocityMps).toBeCloseTo(0.1 / 0.06, 9);
    // The view as the camera shows it, its lead and its bound included.
    expect({ leftM: frame.viewLeftM, rightM: frame.viewRightM }).toEqual(wreckViewAround(positionM, 1));
    expect(frame.viewLeftM).toBeCloseTo(START_VIEW.leftM + 0.1, 12);
    // The floor under the shark, from where the diver is: over the bow's
    // stem 5 m ahead, in open water 20 m behind.
    expect(frame.floorAt(5, 30)).toBe(floorUnder(positionM + 5, 30));
    expect(frame.floorAt(5, 30)).toBe(24.5);
    expect(frame.floorAt(-20, 30)).toBe(34);
    expect(frame.noShark).toBe(SITE_GAMEPLAY.wreck?.noShark);
    expect(frame.noShark).toBe(false);

    // 40 m along, clear of the camera's bound, and turned round: the camera
    // leads 8 m to the left, so the view reaches 37 m behind and 21 m ahead.
    step(399);
    controller.setControl("right", false);
    controller.setControl("left", true);
    step(1);
    const turned = lastSharkFrame(spy);
    expect(frames.at(-1)!.scene.routePositionM).toBeCloseTo(ROUTE_START_POSITION_M + 40 - 0.1, 9);
    expect(turned.diverVelocityMps).toBeCloseTo(-0.1 / 0.06, 9);
    expect(turned.viewLeftM).toBeCloseTo(37, 9);
    expect(turned.viewRightM).toBeCloseTo(21, 9);
    controller.destroy();
  });

  it("the fast-forward's rate: the shark swims in real time while the dive's clock runs thirty times over", async () => {
    // Every compartment at 3.0 bar puts a stop at 18 m (as in
    // tests/unit/game-controller-buoyancy.test.ts), where fast-forward is on offer.
    const swimming = at18(1, { offsetM: -20 });
    const atStop = freezeDiveState({
      ...swimming,
      maxDepthM: metres(34),
      tissues: {
        nitrogenBar: swimming.tissues.nitrogenBar.map(() => bars(3)),
        heliumBar: swimming.tissues.heliumBar,
      },
    });
    const spy = vi.spyOn(DiveModel.prototype, "advanceWithBuoyancy");
    const { controller } = await startController(atStop);
    controller.toggleFastForward();
    step(1);
    expect(lastSharkFrame(spy).timeMultiplier).toBe(30);
    const { shark } = controller.authoritativeState;
    // 20 ms of real time at 7.5 m/s, and 0.6 dive seconds off the timer.
    expect(shark.encounter!.offsetM).toBeCloseTo(-20 + 7.5 * 0.02, 12);
    expect(shark.timerS).toBeCloseTo(60 - 0.6, 12);
    controller.destroy();
  });
});

describe("the shark in play (#219 part 2)", () => {
  it("spawns just beyond the edge of the view the camera shows, and the scene draws it there", async () => {
    const seed = seedWhoseFirstRoll((value) => value < 0.005);
    const { controller, frames } = await startController(at18(seed, null, 0.01));
    expect(frames.at(-1)!.scene.shark).toBeNull();
    step(1);
    const encounter = controller.authoritativeState.shark.encounter!;
    expect(encounter).not.toBeNull();
    // Beyond the edge behind its heading, then one frame's swim.
    const spawnedAtM = encounter.direction > 0 ? -(START_VIEW.leftM + 5) : START_VIEW.rightM + 5;
    expect(encounter.offsetM).toBeCloseTo(spawnedAtM + encounter.direction * 7.5 * 0.02, 12);
    expect(frames.at(-1)!.scene.shark).toEqual({
      positionM: ROUTE_START_POSITION_M + encounter.offsetM,
      depthM: encounter.depthM,
      direction: encounter.direction,
    });
    controller.destroy();
  });

  it("ends the dive in a shark attack when it reaches the diver on a roll under 0.33", async () => {
    const seed = seedWhoseFirstRoll((value) => value < 0.33);
    // 1.2 m short of the diver: contact on the next frame.
    const { frames } = await startController(at18(seed, { offsetM: -1.2 }));
    step(1);
    const last = frames.at(-1)!;
    expect(last.presentation.status).toBe("failed");
    expect(last.presentation.failureReason).toBe("shark-attack");
  });

  it("passes the diver on a roll of 0.33 or more, faster, and the dive goes on", async () => {
    const seed = seedWhoseFirstRoll((value) => value >= 0.33);
    const { controller, frames } = await startController(at18(seed, { offsetM: -1.2 }));
    step(1);
    expect(frames.at(-1)!.presentation.failureReason).toBeNull();
    expect(controller.authoritativeState.shark.encounter).toMatchObject({ passed: true, speedMps: 12 });
    controller.destroy();
  });
});
