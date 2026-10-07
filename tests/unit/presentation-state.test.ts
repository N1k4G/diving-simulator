import { describe, expect, it } from "vitest";
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

  it("shows no safety stop unless one is owed and not done", () => {
    const base = underwaterState();
    expect(selectSafetyStop(base)).toBeNull();
    expect(selectSafetyStop(freezeDiveState({ ...base, safetyStop: { ...owed, complete: true } }))).toBeNull();
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
