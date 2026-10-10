import { describe, expect, it } from "vitest";
import {
  LOW_GAS_BAR,
  NARCOSIS_CAUTION_INDEX,
  NARCOSIS_CRITICAL_INDEX,
  RESERVE_BAR,
  activeWarnings,
  isWarningBeepActive,
  selectWarning,
  type WarningSeverity,
} from "../../src/app/hud-warning";
import { WATER_VAPOR_PRESSURE_BAR } from "../../src/core/buhlmann-constants";
import {
  NDL_UNLIMITED_MINUTES,
  ndlMinutes,
  updateTissueArrays,
} from "../../src/core/decompression";
import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  freezeDiveState,
  type DiveState,
} from "../../src/core/dive-state";
import { bars, metres } from "../../src/core/units";
import {
  LOW_NDL_WARNING_MIN,
  createPresentationState,
  selectNearNdlMin,
  type PresentationCcr,
  type PresentationState,
} from "../../src/presentation/presentation-state";

// Legacy's dive-computer banner (src/renderer.js drawDiveComputer, the
// highestWarn chain) and its beep (hasWarning), as the HUD shows them (#228).

const air = createGasMix(0.21, 0);

const at20m = (state: DiveState): DiveState =>
  freezeDiveState({ ...state, depthM: metres(20), maxDepthM: metres(20) });

/** Open circuit at 20 m on fresh tissues: nothing to warn about. */
function oc(patch: Partial<PresentationState> = {}): PresentationState {
  return { ...createPresentationState(at20m(createInitialDiveState(3)), null), ...patch };
}

/** The loop breathed at 20 m, PO₂ 1.2. */
function ccr(
  patch: Partial<PresentationState> = {},
  loop: Partial<PresentationCcr> = {},
): PresentationState {
  const diluent = createGasMix(0.21, 0);
  const state = createInitialDiveState(4, {
    ccr: { ...createCcrState(diluent, { actualPo2Bar: bars(1.2) }), actualPo2Bar: bars(1.2) },
  });
  const base = createPresentationState(at20m(state), null);
  return { ...base, ...patch, ccr: { ...base.ccr!, ...loop } };
}

const ocTank = (pressureBar: number): Partial<PresentationState> => {
  const tank = oc().tanks[0]!;
  return { tanks: [{ ...tank, pressureBar: bars(pressureBar) }] };
};

// Each banner condition of legacy's chain, just past its threshold.
const ceiling = { decoStopDepthM: 6, depthM: 5.9 };
const oxygen = { breathingPo2Bar: bars(1.61) };
const narcosisCritical = { narcosisIndex: 0.71 };
const fastAscent = { ascentRateMpm: 9.1 };
const lowGas = ocTank(29);
const reserve = ocTank(49);
const lowNdl = { nearNdlMin: 3 };
const narcosisCaution = { narcosisIndex: 0.5 };

describe("the HUD warning's conditions, at legacy's boundaries", () => {
  it("is quiet on a plain dive, open circuit and loop alike", () => {
    expect(activeWarnings(oc())).toEqual([]);
    expect(activeWarnings(ccr())).toEqual([]);
    expect(isWarningBeepActive(oc())).toBe(false);
  });

  it("warns above the ceiling: inDeco && depth < decoStopDepth, strictly", () => {
    expect(selectWarning(oc({ decoStopDepthM: 6, depthM: 5.99 }))).toBe("ceiling");
    expect(selectWarning(oc({ decoStopDepthM: 6, depthM: 6 }))).toBeNull();
    expect(selectWarning(oc({ decoStopDepthM: 6, depthM: 9 }))).toBeNull();
    // No ceiling, no deco: at the surface too.
    expect(selectWarning(oc({ decoStopDepthM: 0, depthM: 0 }))).toBeNull();
  });

  it("warns of a low NDL: !inDeco && ndl > 0 && ndl < 5", () => {
    expect(selectWarning(oc({ nearNdlMin: 0 }))).toBeNull();
    expect(selectWarning(oc({ nearNdlMin: 1 }))).toBe("lowNdl");
    expect(selectWarning(oc({ nearNdlMin: 4 }))).toBe("lowNdl");
    expect(selectWarning(oc({ nearNdlMin: LOW_NDL_WARNING_MIN }))).toBeNull();
    expect(selectWarning(oc({ nearNdlMin: null }))).toBeNull();
  });

  it("warns of narcosis over 0.20, and ranks it high over 0.70, both strictly", () => {
    expect(NARCOSIS_CAUTION_INDEX).toBe(0.2);
    expect(NARCOSIS_CRITICAL_INDEX).toBe(0.7);
    expect(selectWarning(oc({ narcosisIndex: 0.2 }))).toBeNull();
    expect(selectWarning(oc({ narcosisIndex: 0.2000001 }))).toBe("narcosis");
    // 0.70 is still the caution, last in the chain: under a low NDL.
    expect(selectWarning(oc({ ...lowNdl, narcosisIndex: 0.7 }))).toBe("lowNdl");
    expect(selectWarning(oc({ ...lowNdl, narcosisIndex: 0.7000001 }))).toBe("narcosis");
    // Either tier is one warning, never two.
    expect(activeWarnings(oc({ narcosisIndex: 0.9 }))).toEqual(["narcosis"]);
  });

  it("says nothing of narcosis once the dive is completed, as legacy draws no dive computer then", () => {
    expect(selectWarning(oc({ narcosisIndex: 0.9, completed: true }))).toBeNull();
  });

  it("warns of low gas under 30 bar and of the reserve under 50, both strictly, on the active cylinder", () => {
    expect(LOW_GAS_BAR).toBe(30);
    expect(RESERVE_BAR).toBe(50);
    expect(selectWarning(oc(ocTank(29.99)))).toBe("lowGas");
    expect(activeWarnings(oc(ocTank(29.99)))).toEqual(["lowGas"]);
    expect(selectWarning(oc(ocTank(30)))).toBe("reserve");
    expect(selectWarning(oc(ocTank(49.99)))).toBe("reserve");
    expect(selectWarning(oc(ocTank(50)))).toBeNull();
    // Legacy's tankBar() reads tanks[activeTank]: another cylinder's level does not warn.
    const base = oc();
    const second = { ...base.tanks[0]!, index: 1, pressureBar: bars(10), active: false };
    expect(selectWarning({ ...base, tanks: [base.tanks[0]!, second] })).toBeNull();
    expect(selectWarning({ ...base, tanks: [base.tanks[0]!, second], activeTankIndex: 1 })).toBe("lowGas");
  });

  it("reads no open-circuit cylinder on a rebreather, loop or bailout", () => {
    const empty = { tanks: [{ ...ccr().tanks[0]!, pressureBar: bars(10) }] };
    expect(selectWarning(ccr(empty))).toBeNull();
    expect(selectWarning(ccr(empty, { onBailout: true }))).toBeNull();
  });

  it("keeps the fast-ascent threshold strict", () => {
    expect(selectWarning(oc({ ascentRateMpm: 9 }))).toBeNull();
    expect(selectWarning(oc({ ascentRateMpm: 9.01 }))).toBe("fastAscent");
  });
});

describe("the HUD warning's ranking", () => {
  // Legacy's chain, most urgent first, below the migration's failure.
  const chain: [WarningSeverity, Partial<PresentationState>][] = [
    ["failure", { failureReason: "out-of-gas" }],
    ["ceiling", ceiling],
    ["oxygen", oxygen],
    ["narcosis", narcosisCritical],
    ["fastAscent", fastAscent],
    ["lowGas", lowGas],
    ["reserve", reserve],
    ["lowNdl", lowNdl],
    ["narcosis", narcosisCaution],
  ];

  it("follows legacy's chain on open circuit, each warning over every one after it", () => {
    for (let first = 0; first < chain.length; first += 1) {
      // The two narcosis tiers share one index, and low gas and reserve one
      // cylinder: the lower tier shows only without the higher.
      const patch = Object.assign(
        {},
        ...chain.slice(first).reverse().map(([, condition]) => condition),
      ) as Partial<PresentationState>;
      expect(selectWarning(oc(patch)), chain[first]![0]).toBe(chain[first]![0]);
    }
  });

  it("lists every warning that holds in that order", () => {
    const all = { ...narcosisCaution, ...ceiling, ...oxygen, ...fastAscent, ...reserve, ...lowNdl };
    expect(activeWarnings(oc(all))).toEqual(["ceiling", "oxygen", "fastAscent", "reserve", "lowNdl", "narcosis"]);
    expect(activeWarnings(oc({ ...all, ...lowGas, ...narcosisCritical }))).toEqual([
      "ceiling",
      "oxygen",
      "narcosis",
      "fastAscent",
      "lowGas",
      "lowNdl",
    ]);
  });

  it("puts the loop's own warnings over the banner's, and the rebreather's low gas last", () => {
    const banner = { ...ceiling, ...narcosisCritical, ...fastAscent, ...lowNdl };
    expect(
      activeWarnings(
        ccr(banner, { scrubberRemainingS: 599, actualPo2Bar: bars(1.51), diluentCylinderPressureBar: bars(29) }),
      ),
    ).toEqual(["scrubberLow", "oxygen", "ceiling", "narcosis", "fastAscent", "lowNdl", "lowGas"]);
    expect(activeWarnings(ccr({ ...banner, ...narcosisCaution }, { scrubberFailed: true }))).toEqual([
      "co2",
      "ceiling",
      "fastAscent",
      "lowNdl",
      "narcosis",
    ]);
    // A caution over the rebreather's low gas, which legacy's banner lacks.
    expect(selectWarning(ccr(narcosisCaution, { diluentCylinderPressureBar: bars(29) }))).toBe("narcosis");
  });

  it("ranks the ceiling over the oxygen of a bailout, under the oxygen of the loop", () => {
    expect(selectWarning(ccr({ ...ceiling, breathingPo2Bar: bars(1.7) }, { onBailout: true }))).toBe("ceiling");
    expect(selectWarning(ccr(ceiling, { actualPo2Bar: bars(1.51) }))).toBe("oxygen");
  });
});

describe("the alarm, legacy's hasWarning", () => {
  it("sounds for each of legacy's beep terms: the ceiling, PO₂, the ascent, the reserve and narcosis", () => {
    for (const term of [ceiling, oxygen, fastAscent, lowGas, reserve, narcosisCaution, narcosisCritical]) {
      expect(isWarningBeepActive(oc(term))).toBe(true);
    }
    expect(isWarningBeepActive(oc({ narcosisIndex: 0.2 }))).toBe(false);
  });

  it("is silent for a low NDL, unless another term holds", () => {
    expect(selectWarning(oc(lowNdl))).toBe("lowNdl");
    expect(isWarningBeepActive(oc(lowNdl))).toBe(false);
    // The banner shows the NDL; legacy's beep reads narcosis on its own.
    const both = oc({ ...lowNdl, ...narcosisCaution });
    expect(selectWarning(both)).toBe("lowNdl");
    expect(isWarningBeepActive(both)).toBe(true);
  });

  it("keeps sounding for the warnings legacy's banner does not carry", () => {
    expect(isWarningBeepActive(oc({ failureReason: "out-of-gas" }))).toBe(true);
    expect(isWarningBeepActive(ccr({}, { scrubberFailed: true }))).toBe(true);
    expect(isWarningBeepActive(ccr({}, { diluentCylinderPressureBar: bars(29) }))).toBe(true);
  });
});

describe("what the presentation hands the warning", () => {
  const withCeiling = (lastCeilingM: number, extra: Partial<DiveState> = {}) => {
    const base = at20m(createInitialDiveState(5));
    return freezeDiveState({ ...base, log: { ...base.log, lastCeilingM: metres(lastCeilingM) }, ...extra });
  };

  it("gives legacy's decoStopDepth of the model's ceiling, 0 without one or once completed", () => {
    expect(createPresentationState(withCeiling(4.2), null).decoStopDepthM).toBe(6);
    expect(createPresentationState(withCeiling(6), null).decoStopDepthM).toBe(6);
    expect(createPresentationState(withCeiling(6.1), null).decoStopDepthM).toBe(9);
    expect(createPresentationState(withCeiling(0), null).decoStopDepthM).toBe(0);
    expect(createPresentationState(withCeiling(4.2, { completed: true }), null).decoStopDepthM).toBe(0);
  });

  it("passes the model's narcosis index through", () => {
    const state = freezeDiveState({ ...at20m(createInitialDiveState(6)), narcosisIndex: 0.42 });
    expect(createPresentationState(state, null).narcosisIndex).toBe(0.42);
  });

  /** Fresh tissues held at 25 m on air for `exposureMin`. */
  const exposed = (exposureMin: number): DiveState => {
    const base = createInitialDiveState(7);
    const nitrogenBar = [...base.tissues.nitrogenBar];
    const heliumBar = [...base.tissues.heliumBar];
    updateTissueArrays(nitrogenBar, heliumBar, (3.5 - WATER_VAPOR_PRESSURE_BAR) * air.nitrogenFraction, 0, exposureMin);
    return freezeDiveState({
      ...base,
      depthM: metres(25),
      maxDepthM: metres(25),
      tissues: { nitrogenBar, heliumBar },
    });
  };
  const fullNdl = (state: DiveState, gfHighPercent: number) =>
    ndlMinutes(state.tissues, state.depthM, air, gfHighPercent / 100);

  it("gives the same-tick NDL under five minutes, exactly as the full search, and nothing from five on", () => {
    const seen = new Set<number>();
    for (let exposureMin = 0; exposureMin <= 16; exposureMin += 0.25) {
      const state = exposed(exposureMin);
      const full = fullNdl(state, 75);
      seen.add(full);
      expect(selectNearNdlMin(state, 75), `${exposureMin} min`).toBe(full < LOW_NDL_WARNING_MIN ? full : null);
      expect(createPresentationState(state, null, null, 75).nearNdlMin).toBe(selectNearNdlMin(state, 75));
    }
    // The sweep crosses every value the warning's boundaries turn on.
    for (const value of [0, 1, 4, 5, 6]) {
      expect(seen.has(value), `NDL ${value}`).toBe(true);
    }
  });

  it("reads the dive's GF high", () => {
    let differs = false;
    for (let exposureMin = 0; exposureMin <= 20; exposureMin += 0.5) {
      const state = exposed(exposureMin);
      const near90 = createPresentationState(state, null, null, 90).nearNdlMin;
      expect(near90).toBe(fullNdl(state, 90) < 5 ? fullNdl(state, 90) : null);
      differs ||= near90 !== createPresentationState(state, null, null, 75).nearNdlMin;
    }
    expect(differs).toBe(true);
  });

  it("gives no NDL in deco, where legacy's warning does not read it, nor once completed", () => {
    const state = exposed(12);
    expect(selectNearNdlMin(state, 75)).not.toBeNull();
    expect(selectNearNdlMin(freezeDiveState({ ...state, log: { ...state.log, lastCeilingM: metres(0.1) } }), 75)).toBeNull();
    expect(selectNearNdlMin(freezeDiveState({ ...state, completed: true }), 75)).toBeNull();
  });

  it("searches only as far as asked, and 200 minutes by default as legacy", () => {
    const fresh = exposed(0);
    expect(ndlMinutes(fresh.tissues, 25, air, 0.75, 5)).toBe(NDL_UNLIMITED_MINUTES);
    expect(ndlMinutes(fresh.tissues, 25, air, 0.75)).toBe(fullNdl(fresh, 75));
    expect(fullNdl(fresh, 75)).toBeLessThan(NDL_UNLIMITED_MINUTES);
  });
});
