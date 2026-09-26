import { describe, expect, it } from "vitest";

import {
  cylinderIndicesForPage,
  gasInfoAvailable,
  gasInfoPageStillValid,
  displayedNdlMinutes,
  displayedTtsMinutes,
  gasInfoPages,
  po2Severity,
  cylinderSeverity,
  mValueRatioSeverity,
  cnsSeverity,
  gradientFactorSeverity,
  ndlSeverity,
  scrubberSeverity,
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
import { selectLoopRowDanger } from "../../src/app/loop-danger";

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
    // Legacy: `isAdvanced() || diveMode === 'ccr'`, by the mode the dive
    // was set up with.
    expect(gasInfoAvailable(view(ocDive(1)), "rec")).toBe(false);
    expect(gasInfoAvailable(view(ocDive(2)), "tec")).toBe(true);
    expect(gasInfoAvailable(view(ccrDive()), "ccr")).toBe(true);
  });

  it("a technical dive with a single cylinder has it too", () => {
    // The default technical setup has one cylinder. Counting cylinders read
    // it as recreational and hid the pages (#185 review).
    expect(gasInfoAvailable(view(ocDive(1)), "tec")).toBe(true);
    expect(gasInfoPages(view(ocDive(1)), "tec")).toEqual([
      "cylinders-1",
      "tissues",
      "deco",
    ]);
  });

  it("is not offered once the dive has failed", () => {
    const failed = freezeDiveState({
      ...ocDive(2),
      failure: { ...ocDive(2).failure, reason: "out-of-gas" },
    });
    expect(gasInfoAvailable(view(failed), "tec")).toBe(false);
    expect(nextGasInfoPage(null, view(failed), "tec")).toBeNull();
  });
});

describe("the order I walks the pages in", () => {
  it("three cylinders or fewer: cylinders, tissues, deco, closed", () => {
    // Legacy skips page 2 when tankCount <= 3, and with it page 4, because
    // its cap drops to 3. Offering page 4 anyway is a recorded departure
    // (owner decision on #188, docs/decisions.md).
    const presentation = view(ocDive(3));
    expect(gasInfoPages(presentation, "tec")).toEqual(["cylinders-1", "tissues", "deco"]);
    const walk: (string | null)[] = [];
    let page = nextGasInfoPage(null, presentation, "tec");
    while (page !== null) {
      walk.push(page);
      page = nextGasInfoPage(page, presentation, "tec");
    }
    expect(walk).toEqual(["cylinders-1", "tissues", "deco"]);
  });

  it("four cylinders or more: both cylinder pages", () => {
    expect(gasInfoPages(view(ocDive(4)), "tec")).toEqual([
      "cylinders-1",
      "cylinders-2",
      "tissues",
      "deco",
    ]);
  });

  it("a rebreather toggles its one page", () => {
    // Legacy: `infoPageMode = (infoPageMode === 5) ? 0 : 5`.
    const presentation = view(ccrDive());
    expect(nextGasInfoPage(null, presentation, "ccr")).toBe("loop");
    expect(nextGasInfoPage("loop", presentation, "ccr")).toBeNull();
  });

  it("a page the dive no longer has closes rather than jumping", () => {
    const presentation = view(ocDive(2));
    expect(gasInfoPageStillValid("cylinders-2", presentation, "tec")).toBe(false);
    expect(nextGasInfoPage("cylinders-2", presentation, "tec")).toBeNull();
    expect(gasInfoPageStillValid("tissues", presentation, "tec")).toBe(true);
  });

  it("shows three cylinders per page", () => {
    expect(cylinderIndicesForPage("cylinders-1", 2)).toEqual([0, 1]);
    expect(cylinderIndicesForPage("cylinders-1", 6)).toEqual([0, 1, 2]);
    expect(cylinderIndicesForPage("cylinders-2", 6)).toEqual([3, 4, 5]);
    expect(cylinderIndicesForPage("cylinders-2", 4)).toEqual([3]);
    expect(cylinderIndicesForPage("tissues", 6)).toEqual([]);
  });
});

describe("the loop's danger limits, page and HUD", () => {
  // Legacy's gas-information page marks loop PO2 outside 0.16..1.6 bar
  // (PO2_HYPOXIA, PO2_HIGH); its dive-computer row uses 0.18..1.6. A reading
  // of 0.17 bar is marked on the HUD and not on the page (#185 review).
  const ccrAt = (actualPo2Bar: number) => {
    const ccr = view(
      freezeDiveState({
        ...ccrDive(),
        ccr: { ...ccrDive().ccr!, actualPo2Bar: bars(actualPo2Bar) },
      }),
    ).ccr!;
    return ccr;
  };

  it("0.17 bar: marked on the HUD row, not on the page", () => {
    expect(selectLoopRowDanger(ccrAt(0.17)).loopPo2).toBe(true);
    expect(po2Severity(0.17)).toBe("normal");
  });

  it("below 0.16 or above 1.6: marked on both", () => {
    expect(po2Severity(0.15)).toBe("danger");
    expect(selectLoopRowDanger(ccrAt(0.15)).loopPo2).toBe(true);
    expect(po2Severity(1.61)).toBe("danger");
    expect(selectLoopRowDanger(ccrAt(1.61)).loopPo2).toBe(true);
    expect(po2Severity(1.6)).toBe("warning");
  });
});

describe("legacy's colour tiers and display rules (#185 review round 2)", () => {
  it("no pages at the surface: legacy's gate is gameState === 'diving'", () => {
    const atSurface = freezeDiveState({ ...ocDive(2), depthM: metres(0) });
    expect(view(atSurface).status).toBe("surface");
    expect(gasInfoAvailable(view(atSurface), "tec")).toBe(false);
  });

  it("PO2 follows po2Color: caution above 1.0, warning above 1.4, danger outside 0.16..1.6", () => {
    expect(po2Severity(1.0)).toBe("normal");
    expect(po2Severity(1.01)).toBe("caution");
    expect(po2Severity(1.41)).toBe("warning");
    expect(po2Severity(0.159)).toBe("danger");
  });

  it("cylinders: caution from 100 bar down to 50, danger under 50", () => {
    expect(cylinderSeverity(101)).toBe("normal");
    expect(cylinderSeverity(100)).toBe("caution");
    expect(cylinderSeverity(50)).toBe("caution");
    expect(cylinderSeverity(49)).toBe("danger");
  });

  it("CNS: caution from 50%, danger from 80%, on the rounded value (#186)", () => {
    expect(cnsSeverity(49)).toBe("normal");
    expect(cnsSeverity(50)).toBe("caution");
    expect(cnsSeverity(79)).toBe("caution");
    expect(cnsSeverity(80)).toBe("danger");
  });

  it("tissues, gradient factors, NDL and scrubber use legacy's bands", () => {
    expect(mValueRatioSeverity(0.79)).toBe("normal");
    expect(mValueRatioSeverity(0.8)).toBe("caution");
    expect(mValueRatioSeverity(1)).toBe("danger");
    expect(gradientFactorSeverity(79)).toBe("normal");
    expect(gradientFactorSeverity(80)).toBe("caution");
    expect(gradientFactorSeverity(100)).toBe("danger");
    expect(ndlSeverity(15)).toBe("normal");
    expect(ndlSeverity(14)).toBe("caution");
    expect(ndlSeverity(4)).toBe("danger");
    expect(scrubberSeverity(30)).toBe("normal");
    expect(scrubberSeverity(29)).toBe("caution");
    expect(scrubberSeverity(9)).toBe("danger");
  });

  it("TTS shows nothing when there is nothing to ascend", () => {
    // Legacy: `ttsVal2 > 0 ? ttsVal2 + ' min' : '--'` (#188 pre-review).
    expect(displayedTtsMinutes(0)).toBeNull();
    expect(displayedTtsMinutes(4)).toBe(4);
  });

  it("NDL shows at most 99 minutes, and nothing for the 999 sentinel", () => {
    // Legacy: `ndl >= 999 ? '---' : (ndl > 99 ? '99' : ndl) + ' min'`.
    expect(displayedNdlMinutes(120)).toBe(99);
    expect(displayedNdlMinutes(99)).toBe(99);
    expect(displayedNdlMinutes(12)).toBe(12);
    expect(displayedNdlMinutes(999)).toBeNull();
  });
});

describe("the figures on the pages", () => {
  it("MOD is legacy's floor((1.6 / fO2 - 1) * 10)", () => {
    expect(maximumOperatingDepthM(0.21)).toBe(66);
    expect(maximumOperatingDepthM(0.32)).toBe(40);
    expect(maximumOperatingDepthM(0.5)).toBe(22);
    expect(maximumOperatingDepthM(1)).toBe(6);
    expect(() => maximumOperatingDepthM(-0.1)).toThrow(RangeError);
  });

  it("a mix without oxygen has no MOD, and the snapshot is still built", () => {
    // The setup allows 0% oxygen; a throw here threw out of every frame and
    // the dive never started (#185 review).
    expect(maximumOperatingDepthM(0)).toBeNull();
    const state = freezeDiveState({
      ...ocDive(2),
      tanks: [
        createTankState(createGasMix(0.21, 0)),
        createTankState(createGasMix(0, 1)),
      ],
    });
    expect(view(state).tanks.map((tank) => tank.modM)).toEqual([66, null]);
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
