import { describe, expect, it } from "vitest";

import {
  AIR_PRESET,
  GAS_PRESETS,
  OXYGEN_FRACTION_RANGE,
  REC_PRESET_COUNT,
  TANK_PRESSURE_RANGE_BAR,
  adjustOxygenFraction,
  adjustTankPressure,
  applyPreset,
  createDefaultSetup,
  presetCountFor,
  selectMode,
  selectSite,
  toInitialDiveOptions,
} from "./dive-setup";

describe("dive setup defaults", () => {
  it("starts on air at the legacy tank and consumption defaults", () => {
    const setup = createDefaultSetup();

    expect(setup.mode).toBe("rec");
    expect(setup.tanks).toHaveLength(1);
    expect(setup.tanks[0]?.gas.oxygenFraction).toBeCloseTo(0.21, 10);
    expect(setup.tanks[0]?.gas.heliumFraction).toBe(0);
    expect(setup.tanks[0]?.volumeL).toBe(12);
    expect(setup.tanks[0]?.pressureBar).toBe(200);
    expect(setup.surfaceAirConsumptionLpm).toBe(15);
    expect(setup.gradientFactorLow).toBe(35);
    expect(setup.gradientFactorHigh).toBe(75);
  });

  it("offers every authored site, not only the ones the renderer can draw", () => {
    // #158: the screen must not know which sites are migrated. If this ever
    // shrinks to the rendered subset, the knowledge has leaked into the wrong
    // layer.
    const setup = createDefaultSetup();
    for (const siteId of ["shore", "reef", "wreck", "cave"] as const) {
      expect(selectSite(setup, siteId).siteId).toBe(siteId);
    }
  });
});

describe("gas presets", () => {
  it("hides the trimix half in rec and shows all eight in tec", () => {
    expect(presetCountFor("rec")).toBe(REC_PRESET_COUNT);
    expect(presetCountFor("tec")).toBe(GAS_PRESETS.length);
    expect(GAS_PRESETS).toHaveLength(8);
  });

  it("applies a preset to the active tank", () => {
    const ean32 = applyPreset(createDefaultSetup(), 2);

    expect(ean32.tanks[0]?.gas.oxygenFraction).toBeCloseTo(0.32, 10);
    expect(ean32.tanks[0]?.gas.heliumFraction).toBe(0);
  });

  it("refuses a trimix preset in rec rather than substituting a neighbour", () => {
    // Index 4 is Tx 21/35 — available in tec, not in rec. Refusing is the
    // point: silently applying a different gas would be worse than nothing.
    const setup = createDefaultSetup();
    expect(applyPreset(setup, 4)).toBe(setup);
    expect(applyPreset(selectMode(setup, "tec"), 4).tanks[0]?.gas.heliumFraction)
      .toBeCloseTo(0.35, 10);
  });

  it("refuses indices that are out of range or not whole numbers", () => {
    const setup = createDefaultSetup();
    for (const index of [-1, 99, 1.5, Number.NaN]) {
      expect(applyPreset(setup, index)).toBe(setup);
    }
  });
});

describe("mode selection", () => {
  it("drops a trimix mix when leaving tec, because rec cannot express it", () => {
    const trimix = applyPreset(selectMode(createDefaultSetup(), "tec"), 4);
    expect(trimix.tanks[0]?.gas.heliumFraction).toBeCloseTo(0.35, 10);

    const backToRec = selectMode(trimix, "rec");
    expect(backToRec.tanks[0]?.gas.heliumFraction).toBe(0);
    expect(backToRec.tanks[0]?.gas.oxygenFraction).toBeCloseTo(
      AIR_PRESET.oxygenFraction,
      10,
    );
  });

  it("leaves a nitrox mix alone when leaving tec", () => {
    const nitrox = applyPreset(selectMode(createDefaultSetup(), "tec"), 2);
    const backToRec = selectMode(nitrox, "rec");

    expect(backToRec.tanks[0]?.gas.oxygenFraction).toBeCloseTo(0.32, 10);
  });

  it("returns the same object when the mode does not change", () => {
    const setup = createDefaultSetup();
    expect(selectMode(setup, "rec")).toBe(setup);
  });
});

describe("oxygen fraction", () => {
  it("steps by one percent and stays a valid mix", () => {
    const up = adjustOxygenFraction(createDefaultSetup(), 0.01);
    expect(up.tanks[0]?.gas.oxygenFraction).toBeCloseTo(0.22, 10);
    expect(up.tanks[0]?.gas.nitrogenFraction).toBeCloseTo(0.78, 10);
  });

  it("never pushes nitrogen negative against a helium fraction", () => {
    // Tx 15/55 leaves 30% for oxygen at most.
    const trimix = applyPreset(selectMode(createDefaultSetup(), "tec"), 6);
    const raised = adjustOxygenFraction(trimix, 1);

    expect(raised.tanks[0]?.gas.oxygenFraction).toBeCloseTo(0.45, 10);
    expect(raised.tanks[0]?.gas.nitrogenFraction).toBeCloseTo(0, 10);
    expect(raised.tanks[0]?.gas.nitrogenFraction).toBeGreaterThanOrEqual(0);
  });

  it("clamps at both ends and returns the same object at a bound", () => {
    const low = adjustOxygenFraction(createDefaultSetup(), -1);
    expect(low.tanks[0]?.gas.oxygenFraction).toBeCloseTo(
      OXYGEN_FRACTION_RANGE.min,
      10,
    );
    expect(adjustOxygenFraction(low, -1)).toBe(low);
  });

  it("converges onto the step grid instead of carrying an offset", () => {
    // 0.215 is off-grid; one nudge should land on a whole percent, not on
    // 0.225 and then 0.235 forever.
    const offGrid = adjustOxygenFraction(createDefaultSetup(), 0.005);
    expect(offGrid.tanks[0]?.gas.oxygenFraction).toBeCloseTo(0.22, 10);
  });
});

describe("tank pressure", () => {
  it("steps by ten bar and clamps to the authored range", () => {
    const up = adjustTankPressure(createDefaultSetup(), 10);
    expect(up.tanks[0]?.pressureBar).toBe(210);

    const high = adjustTankPressure(createDefaultSetup(), 10_000);
    expect(high.tanks[0]?.pressureBar).toBe(TANK_PRESSURE_RANGE_BAR.max);

    const low = adjustTankPressure(createDefaultSetup(), -10_000);
    expect(low.tanks[0]?.pressureBar).toBe(TANK_PRESSURE_RANGE_BAR.min);
  });
});

describe("conversion to initial dive options", () => {
  it("carries gas, volume and pressure into the model's tank state", () => {
    const setup = adjustTankPressure(
      applyPreset(createDefaultSetup(), 2),
      -10,
    );
    const options = toInitialDiveOptions(setup);

    expect(options.tanks).toHaveLength(1);
    expect(options.tanks?.[0]?.gas.oxygenFraction).toBeCloseTo(0.32, 10);
    expect(options.tanks?.[0]?.volumeL).toBe(12);
    // gasRemainingL is volume x pressure, which is how the model stores it.
    expect(options.tanks?.[0]?.gasRemainingL).toBe(12 * 190);
    expect(options.activeTankIndex).toBe(0);
    expect(options.surfaceAirConsumptionLpm).toBe(15);
    expect(options.ccr).toBeNull();
  });
});

describe("immutability", () => {
  it("never mutates the setup it is given", () => {
    const setup = createDefaultSetup();
    const snapshot = JSON.stringify(setup);

    applyPreset(setup, 1);
    adjustOxygenFraction(setup, 0.05);
    adjustTankPressure(setup, 50);
    selectMode(setup, "tec");
    selectSite(setup, "cave");

    expect(JSON.stringify(setup)).toBe(snapshot);
  });
});
