import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GameController, type GameFrame } from "../../src/app/game-controller";
import { neutralBcdSurfaceLitres } from "../../src/core/buoyancy";
import { createInitialDiveState, freezeDiveState, type DiveState } from "../../src/core/dive-state";
import { metres, seconds } from "../../src/core/units";

// The dive's pause holders (#137 A5): the help overlay (#160) and the page in
// the background each hold the dive still and let go only of their own hold,
// and a training drill's stop (#160) is the drill's, which neither lifts.

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

function step(frames: number, frameMs = FRAME_MS): void {
  for (let i = 0; i < frames; i += 1) {
    nowMs += frameMs;
    const due = queue;
    queue = [];
    for (const callback of due) callback(nowMs);
  }
}

/** Five dive minutes in, neutral at 20 m. */
function underWay(): DiveState {
  const state = createInitialDiveState(0x57524543);
  return freezeDiveState({
    ...state,
    depthM: metres(20),
    maxDepthM: metres(20),
    elapsedTimeS: seconds(300),
    bcdGasSurfaceLiters: neutralBcdSurfaceLitres(20),
  });
}

async function startController(drillsEnabled = false) {
  const frames: GameFrame[] = [];
  /** The states handed to the autosave (#273 reports them every frame a drill stops the dive). */
  const reports = { count: 0 };
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
    onAuthoritativeState: () => {
      reports.count += 1;
    },
    initialState: underWay(),
    drillsEnabled,
    // With drills on, every roll fires.
    random: () => 0,
    plannerClient: {
      forecast: () => new Promise(() => undefined),
      dispose: () => undefined,
    } as unknown as ConstructorParameters<typeof GameController>[0]["plannerClient"],
  });
  await controller.start({} as HTMLElement);
  step(1);
  const time = () => controller.authoritativeState.elapsedTimeS;
  return { controller, frames, time, reports, last: () => frames.at(-1)! };
}

describe("the dive's pause holders (#137 A5)", () => {
  it("in the background nothing advances, a held control is let go, and the first frame back runs no time", async () => {
    const { controller, time } = await startController();
    controller.setControl("ascend", true);
    step(5);
    const bcd = controller.authoritativeState.bcdGasSurfaceLiters;
    controller.setPaused("background", true);
    expect(controller.paused).toBe(true);
    const stopped = time();
    // However long the page was away: a browser sends no frames meanwhile.
    step(1, 60_000);
    step(50);
    expect(time()).toBe(stopped);

    controller.setPaused("background", false);
    expect(controller.paused).toBe(false);
    step(1, 60_000);
    expect(time()).toBe(stopped);
    step(1);
    expect(time()).toBeGreaterThan(stopped);
    // The W held as the page went is not held when it comes back.
    expect(controller.authoritativeState.bcdGasSurfaceLiters).toBe(bcd);
    controller.destroy();
  });

  it("the help open across a trip to the background keeps the dive paused until it closes", async () => {
    const { controller, time } = await startController();
    controller.setPaused("help", true);
    const stopped = time();
    controller.setPaused("background", true);
    controller.setPaused("background", false);
    step(50);
    expect(controller.paused).toBe(true);
    expect(time()).toBe(stopped);
    controller.setControl("descend", true);
    controller.toggleTorch();
    step(5);
    expect(time()).toBe(stopped);

    controller.setPaused("help", false);
    step(2);
    expect(time()).toBeGreaterThan(stopped);
    controller.destroy();
  });

  it("the help closed while the page is away does not resume it before it is back", async () => {
    const { controller, time } = await startController();
    controller.setPaused("background", true);
    controller.setPaused("help", true);
    const stopped = time();
    controller.setPaused("help", false);
    step(50);
    expect(controller.paused).toBe(true);
    expect(time()).toBe(stopped);
    controller.setPaused("background", false);
    step(2);
    expect(time()).toBeGreaterThan(stopped);
    controller.destroy();
  });

  it("each holder letting go twice, or one never held, releases nothing of another's", async () => {
    const { controller, time } = await startController();
    controller.setPaused("help", true);
    controller.setPaused("background", false);
    controller.setPaused("background", false);
    const stopped = time();
    step(10);
    expect(time()).toBe(stopped);
    controller.setPaused("help", true);
    controller.setPaused("help", false);
    step(2);
    expect(time()).toBeGreaterThan(stopped);
    controller.destroy();
  });

  it("a drill's decision outlasts the background, and its debriefing does not run down while the page is away", async () => {
    const { controller, time, last, reports } = await startController(true);
    step(1);
    expect(last().drill?.phase).toBe("overlay");
    const stopped = time();
    // Under the drill the state goes to the autosave every frame (#273).
    const before = reports.count;
    step(3);
    expect(reports.count).toBe(before + 3);

    controller.setPaused("background", true);
    // Nothing is chosen while the page is away, and nothing goes to the
    // autosave: the client saved as the page went.
    controller.chooseDrillOption(0);
    step(20);
    expect(last().drill?.phase).toBe("overlay");
    expect(reports.count).toBe(before + 3);
    controller.setPaused("background", false);
    step(10);
    expect(reports.count).toBeGreaterThan(before + 3);
    expect(last().drill?.phase).toBe("overlay");
    expect(time()).toBe(stopped);

    controller.chooseDrillOption(0);
    expect(last().drill?.phase).toBe("debrief");
    // 4.8 of the debriefing's 5 real seconds, then a minute away.
    step(240);
    controller.setPaused("background", true);
    step(1, 60_000);
    step(100);
    controller.setPaused("background", false);
    step(5);
    expect(last().drill?.phase).toBe("debrief");
    expect(time()).toBe(stopped);
    step(10);
    expect(last().drill).toBeNull();
    step(2);
    expect(time()).toBeGreaterThan(stopped);
    controller.destroy();
  });
});
