// Legacy's instructor panel (#46, src/renderer.js drawInstructorOverlay) in
// the migration client (#160): the values it shows, when it is offered and
// shown, its key and its words. The cases are legacy's TC-46 harness cases
// (src/diving-simulator-tests.html); TC-46-DEFAULT-OFF and the key presses
// themselves are in tests/instructor-panel.spec.js.
import { beforeEach, describe, expect, it, vi } from "vitest";

// Every exported way to the NDL, the ceiling and the schedule, wrapped, so
// the panel can be shown to run none of them (TC-46-RENDER-NO-EXTRA-CALCS).
vi.mock("../../src/core/decompression", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/core/decompression")>();
  return { ...actual, ceilingDepthM: vi.fn(actual.ceilingDepthM), ndlMinutes: vi.fn(actual.ndlMinutes) };
});
vi.mock("../../src/planner/dive-planner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/planner/dive-planner")>();
  return {
    ...actual,
    calculateCeiling: vi.fn(actual.calculateCeiling),
    calculateNdl: vi.fn(actual.calculateNdl),
    calculateDecoSchedule: vi.fn(actual.calculateDecoSchedule),
  };
});

import { ceilingDepthM, ndlMinutes } from "../../src/core/decompression";
import { DiveModel } from "../../src/core/dive-model";
import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
  type DiveState,
} from "../../src/core/dive-state";
import { bars, metres, seconds } from "../../src/core/units";
import { calculateCeiling, calculateDecoSchedule, calculateNdl } from "../../src/planner/dive-planner";
import { createPresentationState } from "../../src/presentation/presentation-state";
import { selectInstructorPhysics, selectLeadingTissue } from "../../src/presentation/instructor-physics";
import type { DrillFrame } from "../../src/app/game-controller";
import {
  instructorAvailable,
  instructorPanelShown,
  isInstructorKey,
  leadingTissueValue,
} from "../../src/app/instructor-panel";
import { translate, type MessageKey } from "../../src/app/i18n/catalog";

/** A dive held at a depth, on EAN32 at AMV 15 with 8.4 L in the BCD, as TC-46-VALUES-MATCH-COMPUTER. */
function at(depthM: number, overrides: Partial<DiveState> = {}, gas = createGasMix(0.32, 0)): DiveState {
  const start = createInitialDiveState(0, {
    tanks: [createTankState(gas)],
    surfaceAirConsumptionLpm: 15,
    bcdGasSurfaceLiters: 8.4,
  });
  return freezeDiveState({ ...start, depthM: metres(depthM), maxDepthM: metres(depthM), ...overrides });
}

/** A dive the model has run: down to the depth and held there. */
function heldAt(depthM: number, minutes: number, gas = createGasMix(0.21, 0)): DiveState {
  const model = new DiveModel(createInitialDiveState(0, { tanks: [createTankState(gas, 24, 230)] }));
  for (let s = 0; s < minutes * 60; s += 1) {
    model.advance({ depthM: metres(Math.min(depthM, (s + 1) / 3)) }, seconds(1));
  }
  return model.snapshot;
}

describe("the instructor panel's values (#46)", () => {
  it("TC-46-VALUES-MATCH-COMPUTER: 30 m on EAN32 is 4.0 bar, 8.4 L at the surface 2.1 L, AMV 15 is 60 L/min, MOD calculateMOD(0.32)", () => {
    const panel = selectInstructorPhysics(at(30));
    expect(panel.ambientPressureBar).toBeCloseTo(4, 9);
    expect(panel.bcdSurfaceLitres).toBe(8.4);
    expect(panel.bcdEffectiveLitres).toBeCloseTo(2.1, 9);
    expect(panel.bcdSurfaceShare).toBeCloseTo(8.4 / 18, 9);
    expect(panel.bcdEffectiveShare).toBeCloseTo(2.1 / 18, 9);
    expect(panel.consumptionLpm).toBeCloseTo(60, 9);
    expect(panel.modM).toBe(Math.round((1.4 / 0.32 - 1) * 10));
    expect(panel.modM).toBe(34);
    expect(panel.beyondMod).toBe(false);
    expect(panel.endM).toBe(30);
    expect(Object.isFrozen(panel)).toBe(true);
  });

  it("reads what the HUD and the gas page read on a dive the model ran", () => {
    const state = heldAt(30, 25);
    const panel = selectInstructorPhysics(state);
    const hud = createPresentationState(state, null);
    expect(panel.ambientPressureBar).toBe(1 + hud.depthM / 10);
    expect(panel.narcosisPercent).toBe(Math.round(hud.narcosisIndex * 100));
    expect(panel.narcosisPercent).toBeGreaterThan(0);
    // The gas page's SrfGF is the leading compartment's share at 1 bar.
    expect(panel.leadingTissue?.percent).toBe(hud.saturation.surfaceGfPercent);
  });

  it("warns past the MOD, as legacy's `depth >= mod`, and has none for a mix without oxygen", () => {
    expect(selectInstructorPhysics(at(34)).beyondMod).toBe(true);
    expect(selectInstructorPhysics(at(33.7)).beyondMod).toBe(false);
    const noOxygen = selectInstructorPhysics(at(10, {}, createGasMix(0, 0.9)));
    expect(noOxygen.modM).toBeNull();
    expect(noOxygen.beyondMod).toBe(false);
  });

  it("reckons the END on legacy's narcosis gas: helium on open circuit, the loop at its PO2, the diluent after a bailout", () => {
    expect(selectInstructorPhysics(at(50, {}, createGasMix(0.21, 0.35))).endM).toBe(Math.round(60 * 0.65 - 10));
    const ccr = createCcrState(createGasMix(0.1, 0.5), { actualPo2Bar: bars(0.7) });
    const loop = at(20, { ccr });
    const inert = 1 - 0.7 / 3;
    expect(selectInstructorPhysics(loop).endM).toBe(Math.round(30 * (1 - inert * (0.5 / 0.9)) - 10));
    const bailedOut = at(20, { ccr: { ...ccr, onBailout: true } });
    expect(selectInstructorPhysics(bailedOut).endM).toBe(Math.round(30 * 0.5 - 10));
  });

  it("shows no MOD and no open-circuit consumption on an active loop, never the setup placeholder's (#183, #192)", () => {
    // The issue's case: the rec EAN36 cylinder carried into a rebreather dive, at 30 m on the loop.
    const ccr = createCcrState(createGasMix(0.21, 0), { actualPo2Bar: bars(1.2) });
    const rec = selectInstructorPhysics(at(30, {}, createGasMix(0.36, 0)));
    expect([rec.modM, rec.beyondMod, rec.consumptionLpm]).toEqual([29, true, 60]);
    const loop = selectInstructorPhysics(at(30, { ccr }, createGasMix(0.36, 0)));
    expect([loop.modM, loop.beyondMod, loop.consumptionLpm]).toEqual([null, false, null]);
    // Bailed out, the diluent is breathed on open circuit, as legacy's activeGas().
    const bailedOut = selectInstructorPhysics(at(30, { ccr: { ...ccr, onBailout: true } }, createGasMix(0.36, 0)));
    expect([bailedOut.modM, bailedOut.beyondMod]).toEqual([Math.round((1.4 / 0.21 - 1) * 10), false]);
    expect(bailedOut.consumptionLpm).toBeCloseTo(60, 9);
  });

  it("TC-46-LEADING-TISSUE-PICKS-HIGHEST: compartment index 3 loaded to 2.5 bar is #4", () => {
    const nitrogenBar = Array.from({ length: 16 }, (_, index) => (index === 3 ? 2.5 : 0.79));
    const lead = selectLeadingTissue(at(0, { tissues: { nitrogenBar: nitrogenBar as never, heliumBar: Array(16).fill(0) } }));
    // Legacy's arithmetic: (2.5 - 1) / (a + 1 / b - 1), a 0.7562 and b 0.7825.
    expect(lead).toEqual({ compartment: 4, halfTimeMin: 18.5, percent: Math.round((1.5 / (0.7562 + 1 / 0.7825 - 1)) * 100), severity: "danger" });
    expect(lead?.percent).toBe(145);
  });

  it("has no leading tissue at the start of a dive, where every compartment is under legacy's -1 %", () => {
    expect(selectLeadingTissue(createInitialDiveState(0))).toBeNull();
    expect(selectInstructorPhysics(createInitialDiveState(0)).leadingTissue).toBeNull();
  });

  it("tints the leading tissue from 80 % and warns from 100 %, as legacy's thresholds", () => {
    const loaded = (load: number) => {
      const nitrogenBar = Array.from({ length: 16 }, (_, index) => (index === 0 ? load : 0.79));
      return selectLeadingTissue(at(0, { tissues: { nitrogenBar: nitrogenBar as never, heliumBar: Array(16).fill(0) } }));
    };
    // Compartment 1: a 1.2599, b 0.505, so 100 % is 1 + (a + 1 / b - 1) bar.
    const span = 1.2599 + 1 / 0.505 - 1;
    expect(loaded(1 + 0.79 * span)?.severity).toBe("normal");
    expect(loaded(1 + 0.8 * span)?.severity).toBe("caution");
    expect(loaded(1 + span)?.severity).toBe("danger");
  });

  it("says the tissue's tier in more than colour: a hidden word for caution, the ⚠ for danger, in both languages", () => {
    const lead = (percent: number, severity: "normal" | "caution" | "danger") => ({ compartment: 1, halfTimeMin: 5, percent, severity });
    expect(leadingTissueValue(lead(50, "normal"), "en")).toEqual({ text: "50% of M-value", hiddenWord: null });
    expect(leadingTissueValue(lead(85, "caution"), "en")).toEqual({ text: "85% of M-value", hiddenWord: "(caution)" });
    expect(leadingTissueValue(lead(85, "caution"), "de")).toEqual({ text: "85 % des M-Werts", hiddenWord: "(Vorsicht)" });
    expect(leadingTissueValue(lead(110, "danger"), "en")).toEqual({ text: "⚠ 110% of M-value", hiddenWord: null });
    expect(leadingTissueValue(null, "de")).toEqual({ text: "—", hiddenWord: null });
  });

  describe("TC-46-RENDER-NO-EXTRA-CALCS", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("runs no NDL, ceiling or schedule, also on a dive in deco", () => {
      const state = heldAt(45, 30);
      expect(state.log.lastCeilingM).toBeGreaterThan(0);
      // The wrapped functions are the model's own: its steps ran them.
      expect(ndlMinutes).toHaveBeenCalled();
      expect(ceilingDepthM).toHaveBeenCalled();
      vi.clearAllMocks();
      const panel = selectInstructorPhysics(state);
      expect(panel.leadingTissue).not.toBeNull();
      for (const calculation of [ndlMinutes, ceilingDepthM, calculateNdl, calculateCeiling, calculateDecoSchedule]) {
        expect(calculation).not.toHaveBeenCalled();
      }
    });
  });
});

describe("when the instructor panel is offered and shown (#46)", () => {
  const frame = (state: DiveState, awaitingDescent = false, drill: DrillFrame | null = null) => ({
    awaitingDescent,
    presentation: createPresentationState(state, null),
    drill,
  });

  it("TC-46-L-KEY-DIVING-ONLY: offered while diving, not at the surface, after a failure or once surfaced", () => {
    const diving = at(10);
    expect(instructorAvailable(frame(diving))).toBe(true);
    expect(instructorAvailable(frame(createInitialDiveState(0), true))).toBe(false);
    expect(instructorAvailable(frame(freezeDiveState({ ...diving, failure: { ...diving.failure, reason: "out-of-gas" } })))).toBe(false);
    expect(instructorAvailable(frame(freezeDiveState({ ...diving, completed: true })))).toBe(false);
  });

  it("is not offered while a drill's decision or debriefing stops the dive, legacy's 'drill' state", () => {
    const diving = at(10);
    for (const phase of ["overlay", "debrief"] as const) {
      expect(instructorAvailable(frame(diving, false, { id: "freeflow", phase, options: [0, 1, 2], correct: false }))).toBe(false);
    }
  });

  it("TC-46-HIDES-UNDER-HELP: shown only on, diving, and under neither the help nor the gas information", () => {
    const clear = { help: false, gasInfo: false };
    expect(instructorPanelShown(true, true, clear)).toBe(true);
    expect(instructorPanelShown(false, true, clear)).toBe(false);
    expect(instructorPanelShown(true, false, clear)).toBe(false);
    expect(instructorPanelShown(true, true, { help: true, gasInfo: false })).toBe(false);
    expect(instructorPanelShown(true, true, { help: false, gasInfo: true })).toBe(false);
  });

  it("TC-46-L-KEY-TOGGLE: l and L, unmodified but for Shift", () => {
    const key = (init: Partial<KeyboardEvent>) =>
      isInstructorKey({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init } as KeyboardEvent);
    expect(key({ key: "l" })).toBe(true);
    expect(key({ key: "L", shiftKey: true })).toBe(true);
    expect(key({ key: "l", ctrlKey: true })).toBe(false);
    expect(key({ key: "l", metaKey: true })).toBe(false);
    expect(key({ key: "l", altKey: true })).toBe(false);
    expect(key({ key: "i" })).toBe(false);
  });
});

describe("TC-46-STRINGS-EN-DE: the panel's words are legacy's STRINGS.instructor*, word for word", () => {
  const legacy: Record<string, [string, string]> = {
    "instructor.title": ["PHYSICS LIVE", "PHYSIK LIVE"],
    "instructor.toggleHint": ["[L] toggle", "[L] umschalten"],
    "instructor.touchLabel": ["LEARN", "LERN"],
    "instructor.pressure.label": ["Ambient pressure", "Umgebungsdruck"],
    "instructor.pressure.formula": ["P = 1 + depth/10 bar", "P = 1 + Tiefe/10 bar"],
    "instructor.bcd.label": ["BCD (Boyle’s law)", "Tarierweste (Gesetz von Boyle)"],
    "instructor.bcd.formula": ["same gas → double pressure = half volume", "gleiche Gasmenge → doppelter Druck = halbes Volumen"],
    "instructor.tissue.label": ["Leading tissue", "Führendes Gewebe"],
    "instructor.tissue.formula": ["saturation vs. M-value at surface", "Sättigung vs. M-Wert an Oberfläche"],
    "instructor.tissue.none": ["compartments still washing in", "Kompartimente sättigen noch"],
    "instructor.consumption.label": ["Gas consumption", "Gasverbrauch"],
    "instructor.consumption.formula": ["SAC = AMV × P (at 30m: 4× surface rate)", "SAC = AMV × P (auf 30m: 4× Oberflächenrate)"],
    "instructor.gas.label": ["Current gas", "Aktuelles Gas"],
    "instructor.gas.formula": ["MOD = (1.4/fO₂ − 1) × 10, END with He", "MOD = (1,4/fO₂ − 1) × 10, END mit He"],
  };

  it.each(Object.entries(legacy))("%s", (key, [en, de]) => {
    expect(translate("en", key as MessageKey)).toBe(en);
    expect(translate("de", key as MessageKey)).toBe(de);
    expect(en).not.toBe(de);
  });
});
