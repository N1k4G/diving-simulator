import { describe, expect, it } from "vitest";

import {
  cylinderIndicesForPage,
  gasInfoAvailable,
  gasInfoPageStillValid,
  gasInfoPages,
  nextGasInfoPage,
} from "../../src/app/gas-info-pages";
import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
  type DiveState,
} from "../../src/core/dive-state";
import { ZHL16C_N2 } from "../../src/core/buhlmann-constants";
import { bars, metres } from "../../src/core/units";
import {
  DEFAULT_PLANNER_SETTINGS,
  calculateCeiling,
  compartmentSaturation,
  leadingGradientFactorPercent,
  maximumOperatingDepthM,
} from "../../src/planner/dive-planner";
import { createPresentationState } from "../../src/presentation/presentation-state";

// Gas information (#163): the page rules from src/state.js, and the figures
// from src/renderer.js drawDiveComputer infoPageMode 1-5.

function ocDive(cylinderCount: number): DiveState {
  return freezeDiveState({
    ...createInitialDiveState(71, {
      tanks: Array.from({ length: cylinderCount }, () =>
        createTankState(createGasMix(0.21, 0)),
      ),
    }),
    depthM: metres(26),
    maxDepthM: metres(26),
  });
}

function ccrDive(): DiveState {
  return freezeDiveState({
    ...createInitialDiveState(72, {
      ccr: createCcrState(createGasMix(0.21, 0), {
        targetPo2Bar: bars(0.7),
        actualPo2Bar: bars(0.7),
      }),
    }),
    depthM: metres(26),
    maxDepthM: metres(26),
  });
}

const view = (state: DiveState) => createPresentationState(state, null);

describe("which dives have gas information", () => {
  it("is offered on technical and rebreather dives, not recreational", () => {
    // Legacy: `isAdvanced() || diveMode === 'ccr'`. A single open-circuit
    // cylinder is how a recreational dive looks from its state.
    expect(gasInfoAvailable(view(ocDive(1)))).toBe(false);
    expect(gasInfoAvailable(view(ocDive(2)))).toBe(true);
    expect(gasInfoAvailable(view(ccrDive()))).toBe(true);
  });

  it("is not offered once the dive has failed", () => {
    const failed = freezeDiveState({
      ...ocDive(2),
      failure: { ...ocDive(2).failure, reason: "out-of-gas" },
    });
    expect(gasInfoAvailable(view(failed))).toBe(false);
    expect(nextGasInfoPage(null, view(failed))).toBeNull();
  });
});

describe("the order I walks the pages in", () => {
  it("three cylinders or fewer: cylinders, tissues, deco, closed", () => {
    // Legacy skips page 2 when tankCount <= 3.
    const presentation = view(ocDive(3));
    expect(gasInfoPages(presentation)).toEqual(["cylinders-1", "tissues", "deco"]);
    const walk: (string | null)[] = [];
    let page = nextGasInfoPage(null, presentation);
    while (page !== null) {
      walk.push(page);
      page = nextGasInfoPage(page, presentation);
    }
    expect(walk).toEqual(["cylinders-1", "tissues", "deco"]);
  });

  it("four cylinders or more: both cylinder pages", () => {
    expect(gasInfoPages(view(ocDive(4)))).toEqual([
      "cylinders-1",
      "cylinders-2",
      "tissues",
      "deco",
    ]);
  });

  it("a rebreather toggles its one page", () => {
    // Legacy: `infoPageMode = (infoPageMode === 5) ? 0 : 5`.
    const presentation = view(ccrDive());
    expect(nextGasInfoPage(null, presentation)).toBe("loop");
    expect(nextGasInfoPage("loop", presentation)).toBeNull();
  });

  it("a page the dive no longer has closes rather than jumping", () => {
    const presentation = view(ocDive(2));
    expect(gasInfoPageStillValid("cylinders-2", presentation)).toBe(false);
    expect(nextGasInfoPage("cylinders-2", presentation)).toBeNull();
    expect(gasInfoPageStillValid("tissues", presentation)).toBe(true);
  });

  it("shows three cylinders per page", () => {
    expect(cylinderIndicesForPage("cylinders-1", 2)).toEqual([0, 1]);
    expect(cylinderIndicesForPage("cylinders-1", 6)).toEqual([0, 1, 2]);
    expect(cylinderIndicesForPage("cylinders-2", 6)).toEqual([3, 4, 5]);
    expect(cylinderIndicesForPage("cylinders-2", 4)).toEqual([3]);
    expect(cylinderIndicesForPage("tissues", 6)).toEqual([]);
  });
});

describe("the figures on the pages", () => {
  it("MOD is legacy's floor((1.6 / fO2 - 1) * 10)", () => {
    expect(maximumOperatingDepthM(0.21)).toBe(66);
    expect(maximumOperatingDepthM(0.32)).toBe(40);
    expect(maximumOperatingDepthM(0.5)).toBe(22);
    expect(maximumOperatingDepthM(1)).toBe(6);
    expect(() => maximumOperatingDepthM(0)).toThrow(RangeError);
  });

  it("each cylinder in the snapshot carries its MOD", () => {
    const state = freezeDiveState({
      ...ocDive(2),
      tanks: [
        createTankState(createGasMix(0.21, 0.35)),
        createTankState(createGasMix(0.5, 0)),
      ],
    });
    expect(view(state).tanks.map((tank) => tank.modM)).toEqual([66, 22]);
  });

  it("a surface-saturated diver at the surface has no gradient to speak of", () => {
    // pN2 0.7405 bar against 1.0 bar ambient: every compartment is below
    // ambient, so every gf is negative and GF99 floors at 0, as legacy's
    // Math.max(0, ...) does.
    const state = createInitialDiveState(73);
    expect(leadingGradientFactorPercent(state.tissues, 1)).toBe(0);
    expect(view(state).saturation.gf99Percent).toBe(0);
    expect(view(state).saturation.surfaceGfPercent).toBe(0);
    expect(view(state).saturation.mValueRatios).toHaveLength(16);
  });

  it("at the ceiling depth, the leading compartment sits exactly at GF high", () => {
    // calculateCeiling solves for the ambient pressure at which the leading
    // compartment's gradient factor equals GF high. Evaluating the overlay's
    // gradient factor there must give GF high back — the two share their
    // coefficients, and this is what keeps them from drifting apart.
    const base = createInitialDiveState(74);
    const loaded = {
      nitrogenBar: base.tissues.nitrogenBar.map(() => bars(3)),
      heliumBar: base.tissues.heliumBar,
    };
    const ceilingM = calculateCeiling(loaded, DEFAULT_PLANNER_SETTINGS);
    expect(ceilingM).toBeGreaterThan(0);

    const atCeiling = compartmentSaturation(loaded, 1 + ceilingM / 10);
    const leading = Math.max(
      ...atCeiling.map((compartment) => compartment.gradientFactorPercent),
    );
    expect(leading).toBeCloseTo(DEFAULT_PLANNER_SETTINGS.gfHighPercent, 9);
  });

  it("the tissue bar is loading over M-value, as legacy draws it", () => {
    // Compartment 1, air-saturated at 30 m: pN2 = (4 - 0.0627) * 0.79.
    const base = createInitialDiveState(75);
    const pN2 = (4 - 0.0627) * 0.79;
    const tissues = {
      nitrogenBar: base.tissues.nitrogenBar.map(() => bars(pN2)),
      heliumBar: base.tissues.heliumBar,
    };
    const [first] = compartmentSaturation(tissues, 4);
    // Helium-free, so the combined coefficients are compartment 1's N2 pair
    // from the repository's table, the one legacy's combinedAB() reads.
    const { a, b } = ZHL16C_N2[0]!;
    expect(first?.mValueRatio).toBeCloseTo(pN2 / (a + 4 / b), 12);
  });
});
