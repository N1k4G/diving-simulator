import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GameController, type GameFrame } from "../../src/app/game-controller";
import { isWarningBeepActive } from "../../src/app/hud-warning";
import { neutralBcdSurfaceLitres } from "../../src/core/buoyancy";
import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
  type DiveState,
  type InitialDiveOptions,
} from "../../src/core/dive-state";
import { metres, seconds } from "../../src/core/units";

// The training drills in the controller (#160): legacy's roll at the top of
// updateDiving(), its 'drill' state, which stops the clock and the physics
// while the decision and the debriefing are up, and the effects the options
// leave on the dive.

const FRAME_MS = 20;
let queue: FrameRequestCallback[] = [];
let nowMs = 0;

beforeEach(() => {
  queue = [];
  nowMs = 0;
  vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined });
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    disconnect(): void {}
  });
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

/** Five dive minutes in, neutral at 20 m: a dive a drill may stop. */
function underWay(options: InitialDiveOptions = {}): DiveState {
  const state = createInitialDiveState(0x57524543, options);
  return freezeDiveState({
    ...state,
    depthM: metres(20),
    maxDepthM: metres(20),
    elapsedTimeS: seconds(300),
    bcdGasSurfaceLiters: neutralBcdSurfaceLitres(20),
  });
}

async function startController(initialState: DiveState, drillsEnabled = true) {
  const frames: GameFrame[] = [];
  const saved: DiveState[] = [];
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
      saved.push(state);
    },
    initialState,
    drillsEnabled,
    // Every roll fires, and picks the first drill that applies.
    random: () => 0,
    plannerClient: {
      forecast: () => new Promise(() => undefined),
      dispose: () => undefined,
    } as unknown as ConstructorParameters<typeof GameController>[0]["plannerClient"],
  });
  await controller.start({} as HTMLElement);
  step(1);
  return { controller, frames, saved, last: () => frames.at(-1)! };
}

describe("the training drills in the controller (#160)", () => {
  it("TC-45-TOGGLE-GATES-TRIGGER: none fires with the toggle off", async () => {
    const { controller, frames } = await startController(underWay(), false);
    step(200);
    expect(frames.every((frame) => frame.drill === null)).toBe(true);
    controller.destroy();
  });

  it("TC-45-PHYSICS-FROZEN-DURING-OVERLAY: the frame that rolls runs on, then the clock, the gas and the tissues stand until the debriefing ends", async () => {
    const { controller, frames, last } = await startController(underWay());
    step(1);
    // Started by this frame's roll, after which the frame still ran, as legacy's updateDiving() does.
    expect(last().drill).toEqual({ id: "freeflow", phase: "overlay", options: [0, 2], correct: false });
    const stopped = last().presentation;
    expect(stopped.elapsedTimeS).toBeGreaterThan(300);
    // Movement is not taken while it is up.
    controller.setControl("descend", true);
    const count = frames.length;
    step(100);
    // Frames go on, so the dive computer, and any warning's beep, go on too.
    expect(frames.length).toBe(count + 100);
    expect(last().presentation.elapsedTimeS).toBe(stopped.elapsedTimeS);
    expect(last().presentation.tanks[0]?.gasRemainingL).toBe(stopped.tanks[0]?.gasRemainingL);
    expect(last().presentation.depthM).toBe(stopped.depthM);

    controller.chooseDrillOption(0);
    expect(last().drill).toEqual({ id: "freeflow", phase: "debrief", options: [0, 2], correct: true });
    // A second choice is not taken, and the debriefing runs its 5 real seconds.
    controller.chooseDrillOption(1);
    expect(last().drill?.correct).toBe(true);
    step(248);
    expect(last().drill?.phase).toBe("debrief");
    expect(last().presentation.elapsedTimeS).toBe(stopped.elapsedTimeS);
    step(3);
    expect(last().drill).toBeNull();
    // Then the dive runs on, six breaths a breath from the free-flowing cylinder, and no second drill comes.
    const before = last().presentation.tanks[0]!.gasRemainingL;
    step(50);
    const usedL = before - last().presentation.tanks[0]!.gasRemainingL;
    // 50 frames of 0.06 dive seconds at about 3 bar, at 15 L/min, times 6.
    expect(usedL).toBeGreaterThan(15 * 3 * 3 / 60 * 5);
    expect(frames.slice(-50).every((frame) => frame.drill === null)).toBe(true);
    controller.destroy();
  });

  it("switches to the backup cylinder at once, and Enter's dismissal lets the dive run", async () => {
    const tanks = [createTankState(createGasMix(0.21, 0)), createTankState(createGasMix(0.32, 0))];
    const { controller, saved, last } = await startController(underWay({ tanks }));
    step(1);
    expect(last().drill?.options).toEqual([0, 1, 2]);
    controller.chooseDrillOption(1);
    expect(last().presentation.activeTankIndex).toBe(1);
    expect(saved.at(-1)?.activeTankIndex).toBe(1);
    controller.dismissDrillDebrief();
    expect(last().drill).toBeNull();
    const before = last().presentation.tanks;
    step(10);
    const now = last().presentation.tanks;
    expect(before[0]!.gasRemainingL - now[0]!.gasRemainingL).toBeGreaterThan(5 * (before[1]!.gasRemainingL - now[1]!.gasRemainingL));
    controller.destroy();
  });

  it("the co2 drill fails the scrubber as it starts, and its warning is on the frames it stops", async () => {
    const { controller, last } = await startController(underWay({ ccr: createCcrState(createGasMix(0.21, 0)) }));
    step(1);
    expect(last().drill).toMatchObject({ id: "co2", phase: "overlay", options: [0, 1] });
    expect(last().presentation.ccr?.scrubberFailed).toBe(true);
    step(5);
    expect(isWarningBeepActive(last().presentation)).toBe(true);
    controller.chooseDrillOption(0);
    expect(controller.authoritativeState.ccr).toMatchObject({ onBailout: true, co2BuildupS: 0 });
    expect(last().drill?.correct).toBe(true);
    controller.destroy();
  });

  it("the co2 drill's wrong option raises the setpoint and leaves the scrubber failed", async () => {
    const { controller, last } = await startController(underWay({ ccr: createCcrState(createGasMix(0.21, 0)) }));
    step(1);
    controller.chooseDrillOption(1);
    expect(last().presentation.ccr).toMatchObject({ onBailout: false, scrubberFailed: true });
    expect(last().presentation.ccr?.targetPo2Bar).toBeCloseTo(0.8, 12);
    expect(last().drill?.correct).toBe(false);
    controller.destroy();
  });

  it("is not rolled under the help, nor chosen while it is open", async () => {
    const { controller, frames, last } = await startController(underWay());
    controller.setPaused(true);
    step(50);
    expect(frames.every((frame) => frame.drill === null)).toBe(true);
    controller.setPaused(false);
    step(2);
    expect(last().drill?.phase).toBe("overlay");
    controller.setPaused(true);
    controller.chooseDrillOption(0);
    expect(last().drill?.phase).toBe("overlay");
    controller.destroy();
  });
});
