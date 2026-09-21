import { describe, expect, it } from "vitest";

import {
  applyPreset,
  createDefaultSetup,
  selectMode,
  toInitialDiveOptions,
  MAX_TANKS,
  type DiveSetup,
} from "./dive-setup";
import {
  AMV_RANGE_LPM,
  GRADIENT_FACTOR_RANGE,
  NEW_TANK_VOLUME_L,
  TANK_VOLUME_RANGE_L,
  addTank,
  adjustGradientFactorHigh,
  adjustGradientFactorLow,
  adjustHeliumFraction,
  adjustSurfaceAirConsumption,
  adjustTankVolume,
  removeTank,
  selectTankTab,
} from "./tec-controls";

const tec = (): DiveSetup => selectMode(createDefaultSetup(), "tec");

// Every bound below cites the legacy function it was read from. A number in
// this file that cannot be traced to src/state.js or src/constants.js is a
// bug in the test, not a specification — that is the lesson from the first
// slice, where invented bounds were asserted as if they were the contract.

describe("helium, from gsAdjustHe", () => {
  it("runs 0 to 1 minus oxygen and never moves oxygen to make room", () => {
    // src/state.js: Math.min(1.0 - t.fO2, ...) up, Math.max(0, ...) down.
    const raised = adjustHeliumFraction(tec(), 1);
    const tank = raised.tanks[0]!;

    expect(tank.gas.heliumFraction).toBeCloseTo(0.79, 10);
    expect(tank.gas.oxygenFraction).toBeCloseTo(0.21, 10);
    expect(tank.gas.nitrogenFraction).toBeCloseTo(0, 10);
  });

  it("floors at zero", () => {
    const trimix = applyPreset(tec(), 4);
    expect(trimix.tanks[0]?.gas.heliumFraction).toBeCloseTo(0.35, 10);

    const emptied = adjustHeliumFraction(trimix, -1);
    expect(emptied.tanks[0]?.gas.heliumFraction).toBe(0);
    expect(adjustHeliumFraction(emptied, -0.01)).toBe(emptied);
  });
});

describe("consumption, from gsAdjustAMV", () => {
  it("clamps to AMV_MIN and AMV_MAX", () => {
    // src/constants.js AMV_MIN 8, AMV_MAX 25.
    expect(AMV_RANGE_LPM.min).toBe(8);
    expect(AMV_RANGE_LPM.max).toBe(25);

    expect(adjustSurfaceAirConsumption(tec(), 1).surfaceAirConsumptionLpm).toBe(16);
    expect(adjustSurfaceAirConsumption(tec(), 999).surfaceAirConsumptionLpm).toBe(25);
    expect(adjustSurfaceAirConsumption(tec(), -999).surfaceAirConsumptionLpm).toBe(8);
  });
});

describe("tank volume, from gsAdjustTankVol", () => {
  it("clamps to TANK_VOL_MIN and TANK_VOL_MAX", () => {
    // src/constants.js TANK_VOL_MIN 6, TANK_VOL_MAX 24.
    expect(TANK_VOLUME_RANGE_L.min).toBe(6);
    expect(TANK_VOLUME_RANGE_L.max).toBe(24);

    expect(adjustTankVolume(tec(), 3).tanks[0]?.volumeL).toBe(15);
    expect(adjustTankVolume(tec(), 999).tanks[0]?.volumeL).toBe(24);
    expect(adjustTankVolume(tec(), -999).tanks[0]?.volumeL).toBe(6);
  });

  it("changes the gas the cylinder holds, because the model stores litres", () => {
    const bigger = adjustTankVolume(tec(), 3);
    expect(toInitialDiveOptions(bigger).tanks?.[0]?.gasRemainingL).toBe(15 * 200);
  });
});

describe("gradient factors, from gsAdjustGFLow and gsAdjustGFHigh", () => {
  it("clamps both to 30-100", () => {
    // src/constants.js GF_LOW_MIN/MAX and GF_HIGH_MIN/MAX are all 30 and 100.
    expect(GRADIENT_FACTOR_RANGE.min).toBe(30);
    expect(GRADIENT_FACTOR_RANGE.max).toBe(100);

    expect(adjustGradientFactorLow(tec(), -999).gradientFactorLow).toBe(30);
    expect(adjustGradientFactorHigh(tec(), 999).gradientFactorHigh).toBe(100);
  });

  it("does not let the pair cross: low yields to high", () => {
    // gsAdjustGFLow: after clamping, `if (gfLow > gfHigh) gfLow = gfHigh`.
    const raised = adjustGradientFactorLow(tec(), 999);
    expect(raised.gradientFactorLow).toBe(75);
    expect(raised.gradientFactorHigh).toBe(75);
  });

  it("does not let the pair cross: high yields to low", () => {
    // gsAdjustGFHigh: after clamping, `if (gfHigh < gfLow) gfHigh = gfLow`.
    const lowered = adjustGradientFactorHigh(tec(), -999);
    expect(lowered.gradientFactorHigh).toBe(35);
    expect(lowered.gradientFactorLow).toBe(35);
  });
});

describe("the tank list, from gsAddTank and gsRemoveTank", () => {
  it("adds air at 200 bar and stops at MAX_TANKS", () => {
    // src/state.js gsAddTank: createTank(0.21, 0.0, 200), refused past
    // MAX_TANKS (src/constants.js, 6).
    let setup = tec();
    for (let i = 1; i < MAX_TANKS; i += 1) setup = addTank(setup);
    expect(setup.tanks).toHaveLength(MAX_TANKS);
    expect(setup.tanks[MAX_TANKS - 1]?.gas.oxygenFraction).toBeCloseTo(0.21, 10);
    expect(setup.tanks[MAX_TANKS - 1]?.pressureBar).toBe(200);

    expect(addTank(setup)).toBe(setup);
  });

  it("gives a new tank the default size, not the selected tank's", () => {
    // createTank reads the module-level `tankVolume` (src/constants.js, 12),
    // and gsAdjustTankVol writes `t.volume` — never `tankVolume`. So resizing
    // cylinder 1 does not change what cylinder 2 is created at.
    //
    // An earlier revision of this file asserted 15 here, inheriting the
    // selected tank's size. That was the second deviation in this issue
    // written down as if it were the contract.
    const bigger = adjustTankVolume(tec(), 3);
    expect(bigger.tanks[0]?.volumeL).toBe(15);
    expect(addTank(bigger).tanks[1]?.volumeL).toBe(NEW_TANK_VOLUME_L);
    expect(NEW_TANK_VOLUME_L).toBe(12);
  });

  it("refuses to remove the last tank", () => {
    const setup = tec();
    expect(setup.tanks).toHaveLength(1);
    expect(removeTank(setup)).toBe(setup);
  });

  it("pulls the tab and the active index back inside the list", () => {
    // gsRemoveTank: `if (selectedTankTab >= tankCount) selectedTankTab = ...`
    // and the same for activeTank.
    const three = addTank(addTank(tec()));
    const onLast = selectTankTab(three, 2);
    expect(onLast.selectedTabIndex).toBe(2);

    const removed = removeTank(onLast);
    expect(removed.tanks).toHaveLength(2);
    expect(removed.selectedTabIndex).toBe(1);
    expect(removed.activeTankIndex).toBeLessThan(removed.tanks.length);
  });
});

describe("the tank tab", () => {
  it("clamps out-of-range values rather than wrapping", () => {
    // src/game-loop.js: Math.max(0, Math.min(tankCount - 1, v | 0)).
    const three = addTank(addTank(tec()));
    expect(selectTankTab(three, 99).selectedTabIndex).toBe(2);
    expect(selectTankTab(three, -5).selectedTabIndex).toBe(0);
  });

  it("edits the selected tank, not the active one", () => {
    // The distinction is the reason both indices exist: the tab is the
    // editing cursor, activeTankIndex is what the dive starts breathing.
    const two = addTank(tec());
    const editingSecond = applyPreset(selectTankTab(two, 1), 3);

    expect(editingSecond.tanks[0]?.gas.oxygenFraction).toBeCloseTo(0.21, 10);
    expect(editingSecond.tanks[1]?.gas.oxygenFraction).toBeCloseTo(0.36, 10);
    expect(editingSecond.activeTankIndex).toBe(0);
  });
});

describe("conversion carries every tank", () => {
  it("passes the whole list and starts on the active index", () => {
    const two = applyPreset(selectTankTab(addTank(tec()), 1), 3);
    const options = toInitialDiveOptions(two);

    expect(options.tanks).toHaveLength(2);
    expect(options.tanks?.[1]?.gas.oxygenFraction).toBeCloseTo(0.36, 10);
    expect(options.activeTankIndex).toBe(0);
  });
});

describe("immutability", () => {
  it("never mutates the setup it is given", () => {
    const setup = addTank(tec());
    const snapshot = JSON.stringify(setup);

    adjustHeliumFraction(setup, 0.1);
    adjustSurfaceAirConsumption(setup, 3);
    adjustTankVolume(setup, 2);
    adjustGradientFactorLow(setup, -5);
    adjustGradientFactorHigh(setup, 5);
    addTank(setup);
    removeTank(setup);
    selectTankTab(setup, 1);

    expect(JSON.stringify(setup)).toBe(snapshot);
  });
});
