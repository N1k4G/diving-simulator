import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GameController, type GameFrame } from "../../src/app/game-controller";
import { buildBlocks, ndlText } from "../../src/app/gas-info";
import { neutralBcdSurfaceLitres } from "../../src/core/buoyancy";
import { WATER_VAPOR_PRESSURE_BAR } from "../../src/core/buhlmann-constants";
import {
  NDL_UNLIMITED_MINUTES,
  ndlMinutes,
  updateTissueArrays,
} from "../../src/core/decompression";
import { DiveModel, decompressionGas, frameNdlMinutes } from "../../src/core/dive-model";
import { NO_INPUT } from "../../src/core/inputs";
import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
  type DiveState,
} from "../../src/core/dive-state";
import { bars, metres, minutes, seconds } from "../../src/core/units";
import { DEFAULT_PLANNER_SETTINGS, type PlannerForecast } from "../../src/planner/dive-planner";
import {
  LOW_NDL_WARNING_MIN,
  createPresentationState,
} from "../../src/presentation/presentation-state";

// The HUD's NDL row against the planner's cadence (#244). Legacy's dive
// computer draws frameCalc.ndl, computed on the same frame as the tissues
// (src/renderer.js drawDiveComputer, src/game-loop.js updateDiving). The
// worker's forecast is asynchronous and pending after every gas switch,
// setpoint change and bailout, so the row reads the model's own NDL of the
// tick instead. ndlMinutes is the port of legacy's calculateNDL(), held to
// the recorded legacy trace in tests/unit/decompression.test.ts.

const FRAME_MS = 20;
const GF_HIGH_PERCENT = 75;
const AIR = createGasMix(0.21, 0);
const EAN32 = createGasMix(0.32, 0);
const UNAVAILABLE = "—";

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

/** Legacy's calculateNDL() on the state, at the dive's GF high. */
const legacyNdl = (state: DiveState, gas = decompressionGas(state)): number =>
  ndlMinutes(state.tissues, state.depthM, gas, GF_HIGH_PERCENT / 100);

/**
 * Neutral at 30 m on air, with a second cylinder of EAN32 (MOD 40 m), the
 * tissues having breathed air there for `exposureMin`. Fresh, the NDL is
 * about 10 minutes on air and 15 on the nitrox; after 8 minutes it is about
 * 2 on air.
 */
function stateAt30m(exposureMin = 0): DiveState {
  const base = createInitialDiveState(7, {
    tanks: [createTankState(AIR), createTankState(EAN32)],
  });
  const nitrogenBar = [...base.tissues.nitrogenBar];
  const heliumBar = [...base.tissues.heliumBar];
  updateTissueArrays(
    nitrogenBar,
    heliumBar,
    (4 - WATER_VAPOR_PRESSURE_BAR) * AIR.nitrogenFraction,
    0,
    exposureMin,
  );
  return freezeDiveState({
    ...base,
    elapsedTimeS: seconds(60 + exposureMin * 60),
    depthM: metres(30),
    maxDepthM: metres(30),
    bcdGasSurfaceLiters: neutralBcdSurfaceLitres(30),
    tissues: { nitrogenBar, heliumBar },
  });
}

/** A forecast whose NDL no same-tick search gives here. */
const STALE_NDL_MIN = 42;
const FORECAST: PlannerForecast = Object.freeze({
  ceilingM: metres(0),
  ndlMin: minutes(STALE_NDL_MIN),
  schedule: null,
  ttsMin: minutes(6),
});

async function start(exposureMin = 0) {
  const frames: GameFrame[] = [];
  const pending: Array<(forecast: PlannerForecast) => void> = [];
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
    initialState: stateAt30m(exposureMin),
    plannerClient: {
      forecast: () =>
        new Promise<PlannerForecast>((resolve) => {
          pending.push(resolve);
        }),
      dispose: () => undefined,
    } as unknown as ConstructorParameters<typeof GameController>[0]["plannerClient"],
  });
  await controller.start({} as HTMLElement);

  /**
   * Runs display frames and returns, for each, the published frame with the
   * model's state of that tick. The worker answers with FORECAST when
   * `answer` is set, and otherwise stays silent.
   */
  const run = async (count: number, answer: boolean) => {
    const ticks: Array<{ frame: GameFrame; state: DiveState }> = [];
    for (let i = 0; i < count; i += 1) {
      nowMs += FRAME_MS;
      const due = queue;
      queue = [];
      for (const callback of due) callback(nowMs);
      ticks.push({ frame: frames.at(-1)!, state: controller.authoritativeState });
      if (answer) {
        for (const resolve of pending.splice(0)) resolve(FORECAST);
      }
      for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    }
    return ticks;
  };
  return { controller, frames, run };
}

describe("the HUD's NDL row (#244)", () => {
  it("is legacy's NDL of the same tick right after a gas switch, while the forecast is stale", async () => {
    const { controller, frames, run } = await start();
    await run(10, true);
    // The forecast is in hand and the row does not read it.
    const before = frames.at(-1)!.presentation;
    const onAir = legacyNdl(controller.authoritativeState, AIR);
    expect(before.planner?.ndlMin).toBe(STALE_NDL_MIN);
    expect(before.ndlMin).toBe(onAir);
    expect(onAir).not.toBe(STALE_NDL_MIN);

    controller.requestTankSwitch(1);
    // The next frame reads it (#202).
    expect(controller.authoritativeState.activeTankIndex).toBe(0);
    const [switchTick] = await run(1, false);
    expect(switchTick!.state.activeTankIndex).toBe(1);
    // The forecast is dropped with the gas it was computed for, and the
    // replacement is pending.
    expect(switchTick!.frame.presentation.planner).toBeNull();
    // Legacy's frame that reads the key computed its NDL before it, on air,
    // and draws that.
    expect(switchTick!.frame.presentation.ndlMin).toBe(legacyNdl(switchTick!.state, AIR));

    const [nextTick] = await run(1, false);
    const switched = nextTick!.frame.presentation;
    const state = nextTick!.state;
    expect(switched.planner).toBeNull();
    const onNitrox = legacyNdl(state, EAN32);
    expect(switched.ndlMin).toBe(onNitrox);
    // Counter-checks: the switch moved the NDL, and the row shows a number,
    // not the unavailable mark the forecast's absence would give.
    expect(onNitrox).toBeGreaterThan(legacyNdl(state, AIR));
    expect(onNitrox).toBeLessThan(NDL_UNLIMITED_MINUTES);
    expect(ndlText(switched.ndlMin, "en", UNAVAILABLE)).toBe(`${Math.min(99, onNitrox)} min`);
    expect(ndlText(switched.planner?.ndlMin ?? null, "en", UNAVAILABLE)).toBe(UNAVAILABLE);
    // The decompression page's NDL row reads the same, as legacy's page 4
    // draws the same frameCalc.ndl.
    expect(decoPageRow(switched, "No-decompression time").value).toBe(
      ndlText(switched.ndlMin, "en", UNAVAILABLE),
    );

    // The worker stays silent: every tick's row is that tick's NDL on the
    // new gas, while no forecast is in hand.
    const silent = await run(30, false);
    for (const { frame, state: tickState } of silent) {
      expect(frame.presentation.planner).toBeNull();
      expect(frame.presentation.ndlMin).toBe(legacyNdl(tickState, EAN32));
    }
    controller.destroy();
  });

  it("agrees with the low-NDL warning on every tick", async () => {
    for (const exposureMin of [0, 8]) {
      const { controller, run } = await start(exposureMin);
      const ticks = await run(20, true);
      for (const { frame, state } of ticks) {
        const { ndlMin, nearNdlMin } = frame.presentation;
        expect(ndlMin).toBe(legacyNdl(state));
        expect(nearNdlMin).toBe(ndlMin !== null && ndlMin < LOW_NDL_WARNING_MIN ? ndlMin : null);
      }
      // Counter-check: the low NDL is reached, so the warning is not
      // vacuously quiet.
      expect(ticks.at(-1)!.frame.presentation.nearNdlMin === null).toBe(exposureMin === 0);
      controller.destroy();
    }
  });
});

/** A row of the gas information's decompression page, by its label. */
function decoPageRow(presentation: GameFrame["presentation"], label: string) {
  const row = buildBlocks("deco", presentation, DEFAULT_PLANNER_SETTINGS, "en")
    .flatMap((block) => (block.kind === "rows" ? block.rows : []))
    .find((candidate) => candidate.label === label);
  if (!row) throw new Error(`no ${label} row`);
  return row;
}

describe("the decompression page's NDL row (#244)", () => {
  it("is the NDL of the tick, as the HUD's row, whatever the forecast holds; the TTS stays the forecast's", () => {
    // After 8 min at 30 m the NDL on air is about 2 min: danger.
    const state = stateAt30m(8);
    const ndl = legacyNdl(state);
    expect(ndl).toBeLessThan(LOW_NDL_WARNING_MIN);
    for (const planner of [null, FORECAST]) {
      const presentation = createPresentationState(state, planner, null, GF_HIGH_PERCENT);
      const row = decoPageRow(presentation, "No-decompression time");
      expect(row.value).toBe(ndlText(ndl, "en", UNAVAILABLE));
      expect(row.severity).toBe("danger");
      // Counter-check: the forecast's 42 min is not what the page shows,
      // and the TTS beside it still comes from the forecast alone.
      expect(row.value).not.toBe(ndlText(STALE_NDL_MIN, "en", UNAVAILABLE));
      expect(decoPageRow(presentation, "Time to surface").value).toBe(
        planner === null ? UNAVAILABLE : "6 min",
      );
    }
  });

  it("reads the unavailable mark at the surface, where there is no limit, with no severity", () => {
    const presentation = createPresentationState(createInitialDiveState(7), FORECAST);
    const row = decoPageRow(presentation, "No-decompression time");
    expect(row.value).toBe(UNAVAILABLE);
    expect(row.severity).toBe("normal");
  });
});

describe("the model's NDL of the step (#244)", () => {
  it("is the full search the step ran, read back at the dive's GF high", () => {
    const model = new DiveModel(stateAt30m(), { gradientFactorHighPercent: GF_HIGH_PERCENT });
    const stepped = model.advance({ depthM: metres(30) }, seconds(1));
    expect(frameNdlMinutes(stepped, GF_HIGH_PERCENT)).toBe(legacyNdl(stepped));
    // At another GF high the search runs again: it is that GF's NDL, not the
    // step's.
    const at90 = ndlMinutes(stepped.tissues, stepped.depthM, AIR, 0.9);
    expect(at90).not.toBe(legacyNdl(stepped));
    expect(frameNdlMinutes(stepped, 90)).toBe(at90);
    expect(frameNdlMinutes(stepped, GF_HIGH_PERCENT)).toBe(legacyNdl(stepped));
  });

  it("is the one the step computed, before a bailout later in the same step, as legacy's frame", () => {
    // Legacy refreshes frameCalc right after updateTissues() and reads the
    // bailout key later in updateDiving() (src/game-loop.js TASK-032F), so
    // the frame that bails out still draws the loop's NDL. A search on the
    // stepped state would give the diluent's.
    const ccr = createCcrState(AIR, { targetPo2Bar: bars(1.3), actualPo2Bar: bars(1.3) });
    const onLoop = freezeDiveState({ ...stateAt30m(), ccr, tanks: [createTankState(AIR)], activeTankIndex: 0 });
    const model = new DiveModel(onLoop, { gradientFactorHighPercent: GF_HIGH_PERCENT });
    const stepped = model.advance({ depthM: metres(30) }, seconds(1), { ...NO_INPUT, bailout: true });
    expect(stepped.ccr?.onBailout).toBe(true);
    const loopGas = decompressionGas({ ...stepped, ccr: { ...stepped.ccr!, onBailout: false } });
    expect(frameNdlMinutes(stepped, GF_HIGH_PERCENT)).toBe(legacyNdl(stepped, loopGas));
    expect(legacyNdl(stepped, loopGas)).not.toBe(legacyNdl(stepped, AIR));
  });

  it("is searched for a state no step produced", () => {
    const fresh = freezeDiveState({ ...stateAt30m() });
    expect(frameNdlMinutes(fresh, GF_HIGH_PERCENT)).toBe(legacyNdl(fresh));
  });
});

describe("the NDL row's states (#244)", () => {
  it("reads the unavailable mark at the surface, where there is no limit", () => {
    const surface = createInitialDiveState(7);
    const presentation = createPresentationState(surface, null);
    expect(presentation.ndlMin).toBe(NDL_UNLIMITED_MINUTES);
    expect(ndlText(presentation.ndlMin, "en", UNAVAILABLE)).toBe(UNAVAILABLE);
  });

  it("caps a long limit at 99 minutes, as legacy", () => {
    const shallow = freezeDiveState({
      ...createInitialDiveState(7),
      depthM: metres(10),
      maxDepthM: metres(10),
    });
    const presentation = createPresentationState(shallow, null);
    expect(presentation.ndlMin).toBeGreaterThan(99);
    expect(presentation.ndlMin).toBeLessThan(NDL_UNLIMITED_MINUTES);
    expect(ndlText(presentation.ndlMin, "en", UNAVAILABLE)).toBe("99 min");
  });

  it("shows the NDL in deco, as legacy's row does, while the warning stays quiet", () => {
    const base = stateAt30m();
    const inDeco = freezeDiveState({
      ...base,
      depthM: metres(18),
      bcdGasSurfaceLiters: neutralBcdSurfaceLitres(18),
      tissues: {
        nitrogenBar: base.tissues.nitrogenBar.map(() => bars(3)),
        heliumBar: base.tissues.heliumBar,
      },
      log: { ...base.log, lastCeilingM: metres(7) },
    });
    const presentation = createPresentationState(inDeco, null, null, GF_HIGH_PERCENT);
    expect(presentation.ndlMin).toBe(legacyNdl(inDeco));
    expect(presentation.ndlMin).toBe(0);
    expect(ndlText(presentation.ndlMin, "en", UNAVAILABLE)).toBe("0 min");
    expect(presentation.nearNdlMin).toBeNull();
  });

  it("is absent once the dive is completed, where legacy draws no dive computer", () => {
    const completed = freezeDiveState({ ...stateAt30m(), depthM: metres(0), completed: true });
    expect(createPresentationState(completed, null).ndlMin).toBeNull();
  });
});
