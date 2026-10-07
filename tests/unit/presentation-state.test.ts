import { describe, expect, it } from "vitest";
import { DiveModel } from "../../src/core/dive-model";
import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
  type DiveState,
} from "../../src/core/dive-state";
import { bars, litres, metres, minutes, seconds } from "../../src/core/units";
import {
  SAFETY_STOP_TARGET_DEPTH_M,
  createPresentationState,
  selectBreathingPo2Bar,
  selectDiveStatus,
  selectRuleOfThirds,
  selectSafetyStop,
  selectTankPressureBar,
} from "../../src/presentation/presentation-state";
import type { PlannerForecast } from "../../src/planner/dive-planner";

describe("PresentationState", () => {
  it("publishes a deeply immutable renderer snapshot", () => {
    const state = underwaterState();
    const forecast = plannerForecast();
    const snapshot = createPresentationState(state, forecast);

    expect(snapshot.status).toBe("diving");
    expect(snapshot.tanks.map((tank) => tank.pressureBar)).toEqual([150, 100]);
    expect(snapshot.tanks[1]?.active).toBe(true);
    expect(snapshot.breathingPo2Bar).toBeCloseTo(2.1, 9);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tanks)).toBe(true);
    expect(Object.isFrozen(snapshot.tanks[0]?.gas)).toBe(true);
    expect(Object.isFrozen(snapshot.events)).toBe(true);
    expect(Object.isFrozen(snapshot.planner?.schedule?.stops)).toBe(true);

    expect(state.tanks[0]?.gasRemainingL).toBe(1_800);
    expect(forecast.schedule?.stops[0]?.depthM).toBe(6);
  });

  it("derives tank pressure and rejects an invalid tank selector", () => {
    const state = underwaterState();
    expect(selectTankPressureBar(state, 0)).toBe(150);
    expect(() => selectTankPressureBar(state, 9)).toThrow(RangeError);
  });

  it("derives surface, diving, and failure status without UI strings", () => {
    const surface = createInitialDiveState(1);
    const diving = underwaterState();
    const failed = freezeDiveState({
      ...diving,
      failure: { ...diving.failure, reason: "out-of-gas" },
      events: [
        ...diving.events,
        {
          type: "failure",
          elapsedTimeS: diving.elapsedTimeS,
          failureReason: "out-of-gas",
        },
      ],
    });

    expect(selectDiveStatus(surface)).toBe("surface");
    expect(selectDiveStatus(diving)).toBe("diving");
    expect(selectDiveStatus(failed)).toBe("failed");
  });

  it("uses actual CCR loop PO2 and diluent PO2 after bailout", () => {
    const diluent = createGasMix(0.1, 0.7);
    const initial = createInitialDiveState(2, {
      ccr: {
        ...createCcrState(diluent, { actualPo2Bar: bars(1.2) }),
        actualPo2Bar: bars(1.2),
      },
    });
    const activeCcr = freezeDiveState({ ...initial, depthM: metres(40) });
    const bailout = freezeDiveState({
      ...activeCcr,
      ccr: { ...activeCcr.ccr!, onBailout: true },
    });

    expect(selectBreathingPo2Bar(activeCcr)).toBeCloseTo(1.2, 9);
    expect(selectBreathingPo2Bar(bailout)).toBeCloseTo(0.5, 9);
  });
});

function underwaterState(): DiveState {
  const air = createTankState(createGasMix(0.21, 0), 12, 150);
  const nitrox = createTankState(createGasMix(0.5, 0), 7, 100);
  const initial = createInitialDiveState(7, {
    tanks: [air, nitrox],
    activeTankIndex: 1,
  });
  return freezeDiveState({
    ...initial,
    elapsedTimeS: seconds(300),
    depthM: metres(32),
    maxDepthM: metres(32),
    tanks: [
      { ...air, gasRemainingL: litres(1_800) },
      { ...nitrox, gasRemainingL: litres(700) },
    ],
    events: [
      { type: "gas-switch", elapsedTimeS: seconds(290), tankIndex: 1 },
    ],
  });
}

// The HUD's dive readouts (#197, #199): what legacy's dive computer draws in
// its ascent chevrons, its stop box and its hud-thirds gauge.
describe("dive readouts", () => {
  const owed = { needed: true, countdownStarted: false, remainingS: seconds(0), paused: false, complete: false };

  it("passes the log's ascent rate through, positive up", () => {
    const base = underwaterState();
    const state = freezeDiveState({ ...base, log: { ...base.log, ascentRateMpm: 12.5 } });
    expect(createPresentationState(state, null).ascentRateMpm).toBe(12.5);
  });

  it("shows no safety stop unless one is owed", () => {
    expect(selectSafetyStop(underwaterState())).toBeNull();
  });

  it("says the stop is complete once done, as legacy's SAFETY STOP / Complete", () => {
    const base = underwaterState();
    expect(selectSafetyStop(freezeDiveState({ ...base, safetyStop: { ...owed, countdownStarted: true, complete: true } }))).toEqual({
      phase: "complete",
      targetDepthM: 5,
      remainingS: 0,
    });
  });

  it("drops Complete when the diver goes back below 11 m, where the stop starts over", () => {
    // The model's own reset (updateSafetyStop), read through the presentation.
    const start = createInitialDiveState(9, { tanks: [createTankState(createGasMix(0.21, 0))] });
    const model = new DiveModel(
      freezeDiveState({
        ...start,
        elapsedTimeS: seconds(600),
        depthM: metres(5),
        maxDepthM: metres(20),
        safetyStop: { needed: true, countdownStarted: true, remainingS: seconds(0), paused: false, complete: true },
      }),
    );
    model.advance({ depthM: metres(5) }, seconds(1));
    expect(selectSafetyStop(model.snapshot)?.phase).toBe("complete");
    model.advance({ depthM: metres(12) }, seconds(1));
    expect(selectSafetyStop(model.snapshot)?.phase).toBe("planned");
  });

  it("gives way to the decompression stop from the model's ceiling, with no forecast yet", () => {
    // Legacy's stop box shows DECO STOP while frameCalc.ceiling > 0. The
    // worker's forecast is null after a gas switch, setpoint change or
    // bailout and on a resumed dive, so the decision may not wait for it.
    const base = underwaterState();
    for (const safetyStop of [owed, { ...owed, countdownStarted: true, remainingS: seconds(100) }, { ...owed, complete: true }]) {
      const inDeco = freezeDiveState({ ...base, safetyStop, log: { ...base.log, lastCeilingM: metres(4.2) } });
      expect(createPresentationState(inDeco, null).safetyStop).toBeNull();
      const clear = freezeDiveState({ ...inDeco, log: { ...inDeco.log, lastCeilingM: metres(0) } });
      expect(createPresentationState(clear, null).safetyStop).not.toBeNull();
    }
  });

  describe("the deco stop in the stop box", () => {
    const deco = (lastCeilingM: number, extra: Partial<DiveState> = {}) => {
      const base = underwaterState();
      return freezeDiveState({
        ...base,
        safetyStop: { ...owed, countdownStarted: true, remainingS: seconds(100) },
        log: { ...base.log, lastCeilingM: metres(lastCeilingM) },
        ...extra,
      });
    };

    // underwaterState() is 300 s into the dive at 32 m. The budget is the
    // controller's at x3: 2 s of interval and 0.5 s real of latency, in dive
    // seconds (3.5) and in real seconds since the request (2 / 3 + 0.5).
    const fresh = { sourceElapsedTimeS: 300, sourceDepthM: 32, maxAgeS: 3.5, realAgeS: 0, maxRealAgeS: 1.17 };

    it("shows the forecast's first stop, depth and minutes, while the model has a ceiling", () => {
      const presentation = createPresentationState(deco(4.2), plannerForecast(), fresh);
      expect(presentation.decoStop).toEqual({ firstStop: { depthM: 6, durationMin: 2 } });
      expect(presentation.safetyStop).toBeNull();
    });

    describe("only from a forecast that still describes the dive (#226 Codex round 2)", () => {
      const firstStop = (freshness: typeof fresh | null, extra: Partial<DiveState> = {}) =>
        createPresentationState(deco(4.2, extra), plannerForecast(), freshness).decoStop?.firstStop ?? null;

      it("keeps the numbers up to the budget, and from a state a little shallower or deeper", () => {
        expect(firstStop({ ...fresh, sourceElapsedTimeS: 296.5 })).not.toBeNull();
        expect(firstStop({ ...fresh, sourceDepthM: 30.5 })).not.toBeNull();
        expect(firstStop({ ...fresh, sourceDepthM: 33.5 })).not.toBeNull();
        expect(firstStop({ ...fresh, realAgeS: 1.1 })).not.toBeNull();
      });

      it("gives the title alone for a forecast older than the budget", () => {
        expect(firstStop({ ...fresh, sourceElapsedTimeS: 296 })).toBeNull();
        // A worker answer dropped under fast-forward: 150 dive seconds old.
        expect(firstStop({ ...fresh, sourceElapsedTimeS: 150, maxAgeS: 17 })).toBeNull();
        // Within the dive-time budget, but asked for too long ago in real time.
        expect(firstStop({ ...fresh, realAgeS: 1.2 })).toBeNull();
      });

      it("gives the title alone for a forecast naming another stop than the model's ceiling, within budget", () => {
        // plannerForecast()'s first stop is 6 m. A ceiling of 2.5 m now names
        // 3 m: the dive has cleared the 6 m stop since the forecast.
        expect(firstStop(fresh, { log: { ...underwaterState().log, lastCeilingM: metres(2.5) } })).toBeNull();
        // 4.2 m and 6 m itself still name 6 m.
        expect(firstStop(fresh, { log: { ...underwaterState().log, lastCeilingM: metres(6) } })).toEqual({
          depthM: 6,
          durationMin: 2,
        });
        expect(firstStop(fresh)).not.toBeNull();
      });

      it("gives the title alone for a forecast from another depth", () => {
        expect(firstStop({ ...fresh, sourceDepthM: 30 })).toBeNull();
        expect(firstStop({ ...fresh, sourceDepthM: 34 })).toBeNull();
      });

      it("gives the title alone with no source, and for a source ahead of the state", () => {
        expect(firstStop(null)).toBeNull();
        expect(firstStop({ ...fresh, sourceElapsedTimeS: 301 })).toBeNull();
      });
    });

    it("shows the title alone with no forecast, or a forecast with no stops, as legacy without a schedule", () => {
      expect(createPresentationState(deco(4.2), null).decoStop).toEqual({ firstStop: null });
      const empty = { ...plannerForecast(), schedule: { stops: [], ttsMin: minutes(0), outOfGas: false } };
      expect(createPresentationState(deco(4.2), empty, fresh).decoStop).toEqual({ firstStop: null });
      expect(createPresentationState(deco(4.2), { ...plannerForecast(), schedule: null }, fresh).decoStop).toEqual({
        firstStop: null,
      });
    });

    it("falls back to the safety stop at ceiling 0, even with a forecast still holding stops", () => {
      // The forecast arrives asynchronously; the model's ceiling of this tick decides.
      const presentation = createPresentationState(deco(0), plannerForecast(), fresh);
      expect(presentation.decoStop).toBeNull();
      expect(presentation.safetyStop?.phase).toBe("running");
    });

    it("shows no stop once the dive is completed", () => {
      const presentation = createPresentationState(deco(4.2, { completed: true }), plannerForecast(), fresh);
      expect(presentation.decoStop).toBeNull();
      expect(presentation.safetyStop).toBeNull();
    });
  });

  it("plans the stop's length until the countdown starts, at legacy's nominal 5 m", () => {
    const base = freezeDiveState({ ...underwaterState(), maxDepthM: metres(20) });
    expect(SAFETY_STOP_TARGET_DEPTH_M).toBe(5);
    expect(selectSafetyStop(freezeDiveState({ ...base, safetyStop: owed }))).toEqual({
      phase: "planned",
      targetDepthM: 5,
      remainingS: 180,
    });
    // Deeper than 30 m, the long stop: calculateSafetyStopDuration().
    const deep = freezeDiveState({ ...base, maxDepthM: metres(32), safetyStop: owed });
    expect(selectSafetyStop(deep)?.remainingS).toBe(300);
  });

  it("counts down once started, and says when it is paused outside the band", () => {
    const base = underwaterState();
    const running = { ...owed, countdownStarted: true, remainingS: seconds(161) };
    expect(selectSafetyStop(freezeDiveState({ ...base, safetyStop: running }))).toEqual({
      phase: "running",
      targetDepthM: 5,
      remainingS: 161,
    });
    expect(
      selectSafetyStop(freezeDiveState({ ...base, safetyStop: { ...running, paused: true } }))?.phase,
    ).toBe("paused");
  });

  it("reads no rate and owes no stop once the dive is completed, as legacy's post-dive draws neither", () => {
    // Surfaced fast past a stop it skipped: the last step's rate and the
    // paused countdown would otherwise stay on the HUD of the ended dive.
    const base = underwaterState();
    const surfaced = {
      ...base,
      log: { ...base.log, ascentRateMpm: 14 },
      safetyStop: { ...owed, countdownStarted: true, remainingS: seconds(100), paused: true },
    };
    expect(createPresentationState(freezeDiveState(surfaced), null)).toMatchObject({
      ascentRateMpm: 14,
      safetyStop: { phase: "paused" },
    });
    const ended = createPresentationState(freezeDiveState({ ...surfaced, completed: true }), null);
    expect(ended.ascentRateMpm).toBe(0);
    expect(ended.safetyStop).toBeNull();
    // Nor a stop that was made: legacy's post-dive draws no stop box.
    const made = freezeDiveState({ ...surfaced, safetyStop: { ...owed, countdownStarted: true, complete: true } });
    expect(createPresentationState(made, null).safetyStop?.phase).toBe("complete");
    expect(createPresentationState(freezeDiveState({ ...made, completed: true }), null).safetyStop).toBeNull();
  });

  it("has no rule of thirds outside an overhead", () => {
    expect(selectRuleOfThirds(underwaterState())).toBeNull();
  });

  it("splits the gas against the plan into legacy's thirds, over all cylinders", () => {
    // underwaterState() carries 1800 + 700 = 2500 L.
    const base = underwaterState();
    const plan = (startingGasL: number, turnWarned = false) =>
      selectRuleOfThirds(
        freezeDiveState({ ...base, thirds: { startingGasL: litres(startingGasL), turnWarned, reserveHit: false } }),
      );
    expect(plan(2500)).toEqual({ phase: "outbound", percent: 100, turnWarned: false });
    // Exactly two thirds left is already the turn: legacy's `> 2/3`.
    expect(plan(3750, true)).toEqual({ phase: "turn", percent: 67, turnWarned: true });
    expect(plan(7500, true)).toEqual({ phase: "reserve", percent: 33, turnWarned: true });
  });
});

function plannerForecast(): PlannerForecast {
  return {
    ceilingM: metres(4.2),
    ndlMin: minutes(0),
    schedule: {
      stops: [{ depthM: metres(6), durationMin: minutes(2) }],
      ttsMin: minutes(8),
      outOfGas: false,
    },
    ttsMin: minutes(8),
  };
}
