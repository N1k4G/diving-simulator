import { describe, expect, it } from "vitest";

import {
  CCR_CO2_FAILURE_SECONDS,
  DiveModel,
} from "../../src/core/dive-model";
import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
} from "../../src/core/dive-state";
import { NO_INPUT } from "../../src/core/inputs";
import {
  bars,
  litres,
  metres,
  seconds,
} from "../../src/core/units";

describe("DiveModel life-support transitions", () => {
  it("switches tanks from an intent and preserves immutable snapshots", () => {
    const initialState = createInitialDiveState(21, {
      tanks: [
        createTankState(createGasMix(0.21, 0)),
        createTankState(createGasMix(0.32, 0)),
      ],
    });
    const model = new DiveModel(initialState);

    const snapshot = model.advance(
      { depthM: metres(10) },
      seconds(1),
      { ...NO_INPUT, switchGasIndex: 1 },
    );

    expect(snapshot.activeTankIndex).toBe(1);
    expect(snapshot.events).toEqual([
      { type: "gas-switch", elapsedTimeS: 0, tankIndex: 1 },
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tanks)).toBe(true);
    expect(initialState.activeTankIndex).toBe(0);
    expect(initialState.tanks[1]?.gasRemainingL).toBe(2400);
  });

  it("automatically switches to the safest available gas when a tank empties", () => {
    const model = new DiveModel(
      createInitialDiveState(22, {
        tanks: [
          createTankState(createGasMix(0.21, 0), 1, 0.5),
          createTankState(createGasMix(0.5, 0), 2, 200),
        ],
      }),
    );

    model.advance({ depthM: metres(20) }, seconds(1));

    expect(model.snapshot.tanks[0]?.gasRemainingL).toBe(0);
    expect(model.snapshot.activeTankIndex).toBe(1);
    expect(model.snapshot.events.at(-1)).toMatchObject({
      type: "gas-switch",
      tankIndex: 1,
    });
  });

  it("makes CCR bailout irreversible and consumes diluent as open circuit", () => {
    const ccr = createCcrState(createGasMix(0.21, 0), {
      targetPo2Bar: bars(0.7),
      actualPo2Bar: bars(0.7),
    });
    const model = new DiveModel(createInitialDiveState(23, { ccr }));

    model.advance(
      { depthM: metres(10) },
      seconds(1),
      { ...NO_INPUT, bailout: true },
    );
    const pressureAtBailout = model.snapshot.ccr?.diluentCylinderPressureBar;
    model.advance({ depthM: metres(10) }, seconds(60));
    model.advance(
      { depthM: metres(10) },
      seconds(1),
      { ...NO_INPUT, bailout: true },
    );

    expect(model.snapshot.ccr?.onBailout).toBe(true);
    expect(model.snapshot.ccr?.diluentCylinderPressureBar).toBeCloseTo(
      (pressureAtBailout ?? 0) - (15 * 2 * 61) / 60 / 3,
      10,
    );
    expect(model.snapshot.events.filter((event) => event.type === "bailout")).toHaveLength(1);
  });

  it.each([
    {
      name: "open-circuit hypoxia",
      state: () =>
        createInitialDiveState(31, {
          tanks: [createTankState(createGasMix(0.1, 0))],
        }),
      depthM: 0,
      elapsedS: 10,
      reason: "hypoxia",
    },
    {
      name: "open-circuit oxygen toxicity",
      state: () =>
        createInitialDiveState(32, {
          tanks: [createTankState(createGasMix(1, 0))],
        }),
      depthM: 10,
      elapsedS: 30,
      reason: "oxygen-toxicity",
    },
    {
      name: "CCR hypoxia",
      state: () =>
        createInitialDiveState(33, {
          ccr: createCcrState(createGasMix(0.1, 0), {
            targetPo2Bar: bars(0.1),
            actualPo2Bar: bars(0.1),
            oxygenCylinderPressureBar: bars(0),
          }),
        }),
      depthM: 0,
      elapsedS: 30,
      reason: "ccr-hypoxia",
    },
    {
      name: "CCR hyperoxia",
      state: () =>
        createInitialDiveState(34, {
          ccr: createCcrState(createGasMix(0.21, 0), {
            targetPo2Bar: bars(1.6),
            actualPo2Bar: bars(1.7),
          }),
        }),
      depthM: 10,
      elapsedS: 30,
      reason: "ccr-hyperoxia",
    },
    {
      name: "CCR scrubber exhaustion",
      state: () =>
        createInitialDiveState(35, {
          ccr: createCcrState(createGasMix(0.21, 0), {
            targetPo2Bar: bars(0.7),
            actualPo2Bar: bars(0.7),
            scrubberRemainingS: seconds(0),
          }),
        }),
      depthM: 10,
      elapsedS: CCR_CO2_FAILURE_SECONDS,
      reason: "ccr-co2",
    },
  ])("records the $name failure at the legacy threshold", (scenario) => {
    const model = new DiveModel(scenario.state());

    model.advance(
      { depthM: metres(scenario.depthM) },
      seconds(scenario.elapsedS),
    );

    expect(model.snapshot.failure.reason).toBe(scenario.reason);
    expect(model.snapshot.events.at(-1)).toMatchObject({
      type: "failure",
      failureReason: scenario.reason,
    });
  });

  it("stops authoritative time when a terminal failure occurs", () => {
    const model = new DiveModel(
      createInitialDiveState(40, {
        tanks: [createTankState(createGasMix(0.1, 0), 12, 200)],
      }),
    );

    model.advance({ depthM: metres(0) }, seconds(60));

    expect(model.snapshot.failure.reason).toBe("hypoxia");
    expect(model.snapshot.elapsedTimeS).toBe(10);
  });

  it("rejects invalid life-support configuration", () => {
    expect(() => createInitialDiveState(1, { tanks: [] })).toThrow(RangeError);
    expect(() =>
      createInitialDiveState(1, {
        tanks: [createTankState(createGasMix(0.21, 0))],
        activeTankIndex: 2,
      }),
    ).toThrow(RangeError);
    expect(() => litres(-1)).toThrow(RangeError);
    expect(() =>
      createCcrState(createGasMix(0.21, 0), {
        po2ResponseBarPerSecond: -0.1,
      }),
    ).toThrow(RangeError);
  });
});

describe("DiveModel across a changing depth profile", () => {
  // Every other test in this suite advances at a constant depth, and the
  // golden-trace parity suite cannot cover an ascent because the fixture
  // records depth only at checkpoints (see docs/decisions.md). These two
  // invariants are fixture-independent and catch a model that mishandles the
  // depth/dt relationship during a profile.
  const openCircuitAir = () =>
    new DiveModel(
      createInitialDiveState(7, {
        tanks: [createTankState(createGasMix(0.21, 0))],
      }),
    );

  function ascendFrom(depthM: number, totalMinutes: number, steps: number) {
    const model = openCircuitAir();
    model.advance({ depthM: metres(depthM) }, seconds(30 * 60));
    const bottom = [...model.snapshot.tissues.nitrogenBar];

    for (let step = 1; step <= steps; step += 1) {
      model.advance(
        { depthM: metres(Math.max(0, depthM - (depthM * step) / steps)) },
        seconds((totalMinutes * 60) / steps),
      );
    }

    return { bottom, surfaced: [...model.snapshot.tissues.nitrogenBar] };
  }

  it("keeps every compartment bounded by the profile it was exposed to", () => {
    const { bottom, surfaced } = ascendFrom(18, 1.5, 60);
    // Inspired N2 at 18 m, the ceiling any compartment can approach here.
    const inspiredAt18M = 2.8 * 0.79;

    for (let index = 0; index < 16; index += 1) {
      expect(surfaced[index]).toBeGreaterThan(0.7);
      expect(surfaced[index]).toBeLessThan(inspiredAt18M);
    }

    // Only the fast compartments track a 90-second ascent. Slow ones keep
    // on-gassing throughout it, because ambient inert pressure stays above
    // their loading for most of the way up — so asserting that every
    // compartment unloads would be asserting wrong physics.
    expect(surfaced[0]).toBeLessThan(bottom[0] as number);
  });

  it("converges as the ascent step size shrinks", () => {
    // A model that applied dt or depth in the wrong order would diverge here
    // rather than converge on the same continuous profile.
    const coarse = ascendFrom(18, 1.5, 60).surfaced;
    const fine = ascendFrom(18, 1.5, 600).surfaced;

    for (let index = 0; index < 16; index += 1) {
      expect(Math.abs((coarse[index] as number) - (fine[index] as number)))
        .toBeLessThan(5e-3);
    }
  });
});
