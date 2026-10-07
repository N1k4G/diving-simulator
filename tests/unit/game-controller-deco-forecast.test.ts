import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GameController, type GameFrame } from "../../src/app/game-controller";
import { neutralBcdSurfaceLitres } from "../../src/core/buoyancy";
import {
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
  type DiveState,
} from "../../src/core/dive-state";
import { bars, metres, minutes, seconds } from "../../src/core/units";
import {
  DEFAULT_PLANNER_SETTINGS,
  calculateCeiling,
  decoStopDepth,
  type PlannerForecast,
} from "../../src/planner/dive-planner";

// The deco stop's numbers against the forecast's cadence (#226 Codex round
// 2), on a stubbed frame loop and a worker client the test answers by hand.
// The stop box shows the forecast's first stop only while the forecast still
// describes the dive: in steady play it must keep the numbers from one
// answer to the next, at x3 and at x30, and a dropped answer must not leave
// them on screen.

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

/**
 * Holding an 18 m stop, neutral: every compartment at 3.0 bar of nitrogen,
 * as tests/unit/game-controller-fast-forward.test.ts has it.
 */
function stateAtStop(): DiveState {
  const base = createInitialDiveState(7, { tanks: [createTankState(createGasMix(0.21, 0))] });
  return freezeDiveState({
    ...base,
    elapsedTimeS: seconds(base.elapsedTimeS + 600),
    depthM: metres(18),
    maxDepthM: metres(34),
    bcdGasSurfaceLiters: neutralBcdSurfaceLitres(18),
    tissues: {
      nitrogenBar: base.tissues.nitrogenBar.map(() => bars(3)),
      heliumBar: base.tissues.heliumBar,
    },
  });
}

const FORECAST: PlannerForecast = Object.freeze({
  ceilingM: metres(17.5),
  ndlMin: minutes(0),
  schedule: { stops: [{ depthM: metres(18), durationMin: minutes(4) }], ttsMin: minutes(20), outOfGas: false },
  ttsMin: minutes(20),
});

interface Request {
  readonly madeAtFrame: number;
  readonly state: DiveState;
  resolve(forecast: PlannerForecast): void;
}

/**
 * A worker answer whose first stop is the planner's own: decoStopDepth of
 * the GF-high ceiling of the state it was asked for
 * (src/planner/dive-planner.ts calculateDecoSchedule).
 */
function plannersFirstStop(state: DiveState): PlannerForecast {
  const ceilingM = calculateCeiling(state.tissues, DEFAULT_PLANNER_SETTINGS);
  return Object.freeze({
    ceilingM,
    ndlMin: minutes(0),
    schedule: { stops: [{ depthM: decoStopDepth(ceilingM), durationMin: minutes(4) }], ttsMin: minutes(20), outOfGas: false },
    ttsMin: minutes(20),
  });
}

async function startAtStop(
  initialState: DiveState = stateAtStop(),
  answerFor: (state: DiveState) => PlannerForecast = () => FORECAST,
) {
  const frames: GameFrame[] = [];
  const requests: Request[] = [];
  let frameCount = 0;
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
      forecast: (state: DiveState) =>
        new Promise<PlannerForecast>((resolve) => {
          requests.push({ madeAtFrame: frameCount, state, resolve });
        }),
      dispose: () => undefined,
    } as unknown as ConstructorParameters<typeof GameController>[0]["plannerClient"],
  });
  await controller.start({} as HTMLElement);

  /**
   * Runs display frames. The worker answers each request `latencyFrames`
   * frames after it was made, unless `answer` is false.
   */
  const run = async (count: number, latencyFrames: number, answer = true): Promise<GameFrame[]> => {
    const published: GameFrame[] = [];
    for (let i = 0; i < count; i += 1) {
      nowMs += FRAME_MS;
      frameCount += 1;
      const due = queue;
      queue = [];
      for (const callback of due) callback(nowMs);
      published.push(frames.at(-1)!);
      if (answer) {
        for (const request of requests) {
          if (frameCount - request.madeAtFrame === latencyFrames) {
            request.resolve(answerFor(request.state));
          }
        }
      }
      // Lets an answered forecast land before the next frame: the client's
      // promise, the controller's then and finally.
      for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    }
    return published;
  };
  return { controller, frames, requests, run };
}

const firstStopOf = (frame: GameFrame) => frame.presentation.decoStop?.firstStop ?? null;

describe("the deco stop's numbers against the forecast's cadence", { timeout: 30_000 }, () => {
  it("are kept from one answer to the next at x3", async () => {
    const { controller, run } = await startAtStop();
    // The first frame only takes its timestamp; the first answer lands
    // three frames after the request.
    await run(6, 3);
    const steady = await run(500, 3);
    // Ten seconds of real time, thirty of dive time: about fifteen answers.
    expect(steady.every((frame) => frame.presentation.decoStop !== null)).toBe(true);
    expect(steady.every((frame) => firstStopOf(frame) !== null)).toBe(true);
    controller.destroy();
  });

  it("are kept from one answer to the next at x30, while fast-forwarding at the stop", async () => {
    const { controller, run } = await startAtStop();
    await run(6, 3);
    controller.toggleFastForward();
    const steady = await run(150, 3);
    expect(steady.every((frame) => frame.fastForward.active)).toBe(true);
    expect(steady.every((frame) => firstStopOf(frame) !== null)).toBe(true);
    controller.destroy();
  });

  it("are dropped, leaving the title, when an answer never comes at x30", async () => {
    const { controller, run } = await startAtStop();
    await run(6, 3);
    controller.toggleFastForward();
    await run(20, 3);
    // From here the worker answers nothing: the last forecast ages. Within
    // the budget (2 s of interval and half a second of real time at x30,
    // about 29 frames) its numbers stay; then the box shows its title alone,
    // where before this they stayed for the worker's whole 5 s timeout.
    const silent = await run(60, 3, false);
    expect(silent.every((frame) => frame.fastForward.active)).toBe(true);
    expect(silent.slice(0, 10).every((frame) => firstStopOf(frame) !== null)).toBe(true);
    expect(silent.slice(40).every((frame) => frame.presentation.decoStop !== null)).toBe(true);
    expect(silent.slice(40).every((frame) => firstStopOf(frame) === null)).toBe(true);
    controller.destroy();
  });

  it("show the title alone while the first request is pending", async () => {
    const { controller, run } = await startAtStop();
    const pending = await run(10, 3, false);
    expect(pending.slice(1).every((frame) => frame.presentation.decoStop !== null)).toBe(true);
    expect(pending.every((frame) => firstStopOf(frame) === null)).toBe(true);
    controller.destroy();
  });

  it("blink to the title for no more than the worker's answer as the ceiling crosses a stop", async () => {
    // A diver held at 9 m, every compartment loaded alike so the GF-high
    // ceiling sits just above 6 m and the stop is 9 m. Off-gassing brings it
    // under 6 m some dive seconds in, and the stop becomes 6 m. The worker
    // answers as the planner does, its first stop decoStopDepth of the
    // ceiling it was asked for; the box drops a forecast naming another stop
    // than the model's (#226), and the scheduler asks again as the stop
    // moves, so the title stands alone only until that answer lands.
    const base = createInitialDiveState(7, { tanks: [createTankState(createGasMix(0.21, 0))] });
    const loaded = (nitrogenBar: number) => ({
      nitrogenBar: base.tissues.nitrogenBar.map(() => bars(nitrogenBar)),
      heliumBar: base.tissues.heliumBar,
    });
    // The ceiling is linear in a uniform load: aim it at 6.0008 m.
    const low = calculateCeiling(loaded(1.8), DEFAULT_PLANNER_SETTINGS);
    const high = calculateCeiling(loaded(1.9), DEFAULT_PLANNER_SETTINGS);
    const tissues = loaded(1.8 + ((6.0008 - low) / (high - low)) * 0.1);
    const startCeilingM = calculateCeiling(tissues, DEFAULT_PLANNER_SETTINGS);
    expect(startCeilingM).toBeGreaterThan(6);
    expect(startCeilingM).toBeLessThan(6.002);

    const initial = freezeDiveState({
      ...base,
      elapsedTimeS: seconds(base.elapsedTimeS + 600),
      depthM: metres(9),
      maxDepthM: metres(34),
      bcdGasSurfaceLiters: neutralBcdSurfaceLitres(9),
      tissues,
    });
    const latencyFrames = 3;
    const { controller, run } = await startAtStop(initial, plannersFirstStop);
    await run(6, latencyFrames);
    const frames = await run(900, latencyFrames);

    const stops = frames.map((frame) => firstStopOf(frame)?.depthM ?? null);
    expect(frames.every((frame) => frame.presentation.decoStop !== null)).toBe(true);
    const lastNine = stops.lastIndexOf(9);
    const firstSix = stops.indexOf(6);
    // The crossing happened within the run, and once.
    expect(lastNine).toBeGreaterThan(0);
    expect(firstSix).toBeGreaterThan(lastNine);
    expect(stops.slice(firstSix).every((stop) => stop === 6)).toBe(true);
    // Between them, the title alone: the request goes out on the frame the
    // stop moves and lands latencyFrames later.
    expect(firstSix - lastNine - 1).toBeLessThanOrEqual(latencyFrames + 1);
    expect(stops.slice(0, lastNine).every((stop) => stop === 9)).toBe(true);
    controller.destroy();
  });
});
