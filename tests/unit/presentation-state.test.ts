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
  createPresentationState,
  selectBreathingPo2Bar,
  selectDiveStatus,
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
