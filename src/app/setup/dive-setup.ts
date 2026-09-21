// The pre-dive configuration, as data.
//
// This module is pure: no DOM, no PixiJS, no catalogue. The screen in
// setup-screen.ts renders it and calls these transforms; the composition root
// turns the result into a DiveState. Keeping the two apart is what lets the
// rules below — clamping, preset availability, tank counts — be unit-tested
// without a browser, and it is the same split docs/decisions.md asks for
// between input adapters and the model.
//
// Legacy reference: src/constants.js (GAS_PRESETS, MAX_TANKS and the tank,
// AMV and gradient-factor defaults) and src/state.js (diveMode, modeSettings).
// The values here are those values; where this file diverges it says so.
import {
  plannerSettingsWithGradientFactors,
  type PlannerSettings,
} from "../../planner/dive-planner";
import {
  createCcrState,
  createGasMix,
  createTankState,
  type GasMix,
  type InitialDiveOptions,
} from "../../core/dive-state";
import { bars, litres } from "../../core/units";

export const DIVE_MODES = ["rec", "tec", "ccr"] as const;
export type DiveMode = (typeof DIVE_MODES)[number];

// All four, deliberately. Which of them the renderer can actually draw is not
// this module's business (#158): the screen offers the authored sites and the
// composition root decides what to do with one it cannot render yet, so this
// file needs no edit as #164-#167 land.
export const SITE_IDS = ["shore", "reef", "wreck", "cave"] as const;
export type SiteId = (typeof SITE_IDS)[number];

export const MAX_TANKS = 6;

// src/constants.js GAS_PRESETS, in the same order, because the legacy screen
// binds them to keys 1-8 by index and the parity checkpoint compares against
// dives configured through those keys.
export interface GasPreset {
  readonly id: string;
  readonly oxygenFraction: number;
  readonly heliumFraction: number;
}

/** Named because the defaults and the tec->rec fallback both reach for it. */
export const AIR_PRESET: GasPreset = Object.freeze({
  id: "air",
  oxygenFraction: 0.21,
  heliumFraction: 0,
});

export const GAS_PRESETS: readonly GasPreset[] = Object.freeze([
  AIR_PRESET,
  Object.freeze({ id: "ean28", oxygenFraction: 0.28, heliumFraction: 0 }),
  Object.freeze({ id: "ean32", oxygenFraction: 0.32, heliumFraction: 0 }),
  Object.freeze({ id: "ean36", oxygenFraction: 0.36, heliumFraction: 0 }),
  Object.freeze({ id: "tx21-35", oxygenFraction: 0.21, heliumFraction: 0.35 }),
  Object.freeze({ id: "tx18-45", oxygenFraction: 0.18, heliumFraction: 0.45 }),
  Object.freeze({ id: "tx15-55", oxygenFraction: 0.15, heliumFraction: 0.55 }),
  Object.freeze({ id: "hx21-79", oxygenFraction: 0.21, heliumFraction: 0.79 }),
]);

// Rec gets the four nitrox presets; tec gets all eight. Legacy splits them the
// same way (`presetsBasic` vs `presetsAdv1`/`presetsAdv2` in src/constants.js).
export const REC_PRESET_COUNT = 4;

// Ported from the legacy oracle, not chosen. src/state.js gsAdjustO2 clamps
// with Math.max(0.0, ...) on the way down and Math.min(1.0 - fHe, ...) on the
// way up, so oxygen runs 0 to whatever helium leaves; gsAdjustPressure clamps
// with Math.max(200, Math.min(300, ...)), so an open-circuit cylinder is
// 200-300 bar and nothing else. An earlier version of this file invented
// 0.05 and 50 instead, which let the new client configure a 190 bar dive the
// legacy screen cannot and refused the 0% mix it allows — and the unit tests
// below had already written that deviation down as if it were the contract.
// 50 bar belongs to the CCR cylinder configuration, which is a later slice.
export const OXYGEN_FRACTION_RANGE = Object.freeze({ min: 0, max: 1 });
export const TANK_PRESSURE_RANGE_BAR = Object.freeze({ min: 200, max: 300 });
export const OXYGEN_FRACTION_STEP = 0.01;
export const TANK_PRESSURE_STEP_BAR = 10;

export interface SetupTank {
  readonly gas: GasMix;
  readonly volumeL: number;
  readonly pressureBar: number;
}

/**
 * The closed-circuit configuration, mirroring the fields of src/state.js
 * `ccrState` that its setup screen can actually change.
 *
 * The diluent cylinder's *pressure* is deliberately absent. Legacy exposes
 * `ccrAdjustO2Pres` but has no diluent equivalent on the setup screen or
 * anywhere else, so the diluent starts at the 200 bar of CCR_DEFAULTS and
 * createCcrState's own default supplies it. Adding a control here would be
 * inventing one.
 */
export interface CcrSetup {
  readonly diluent: GasMix;
  readonly setpointBar: number;
  readonly diluentCylinderVolumeL: number;
  readonly oxygenCylinderVolumeL: number;
  readonly oxygenCylinderPressureBar: number;
}

/**
 * What the legacy client keeps per mode in `modeSettings` (src/state.js), so
 * switching away and back restores the configuration instead of losing it.
 * Legacy stores `ccrState` in the same record, so the diluent and setpoint
 * survive a trip through rec exactly as the tanks and gradient factors do.
 */
export interface ModeSnapshot {
  readonly tanks: readonly SetupTank[];
  readonly selectedTabIndex: number;
  readonly activeTankIndex: number;
  readonly surfaceAirConsumptionLpm: number;
  readonly gradientFactorLow: number;
  readonly gradientFactorHigh: number;
  readonly ccr: CcrSetup;
}

export interface DiveSetup {
  readonly mode: DiveMode;
  readonly siteId: SiteId;
  readonly tanks: readonly SetupTank[];
  /** Which tank the screen is editing. Legacy calls it `selectedTankTab`. */
  readonly selectedTabIndex: number;
  /** Which tank the dive starts breathing. Legacy sets this to 0 at setup. */
  readonly activeTankIndex: number;
  readonly surfaceAirConsumptionLpm: number;
  readonly gradientFactorLow: number;
  readonly gradientFactorHigh: number;
  /**
   * Carried in every mode, not only CCR, so that switching away and back does
   * not reset it — which is what src/state.js does by keeping `ccrState` in
   * `modeSettings`. Only CCR reads it; toInitialDiveOptions ignores it
   * otherwise.
   */
  readonly ccr: CcrSetup;
  /** Per-mode memory; see ModeSnapshot. Empty until a mode is left. */
  readonly savedModes: Readonly<Partial<Record<DiveMode, ModeSnapshot>>>;
}

// src/constants.js: tankVolume 12, amvRate 15, gfLow 35, gfHigh 75.
// Wreck is the default site because it is the one the renderer draws today;
// that is a composition-root fact leaking one value into a default, and it
// costs nothing to change when the other three land.
export function createDefaultSetup(): DiveSetup {
  return Object.freeze({
    mode: "rec",
    siteId: "wreck",
    tanks: Object.freeze([createSetupTank(AIR_PRESET)]),
    selectedTabIndex: 0,
    activeTankIndex: 0,
    surfaceAirConsumptionLpm: 15,
    gradientFactorLow: 35,
    gradientFactorHigh: 75,
    ccr: createDefaultCcrSetup(),
    savedModes: Object.freeze({}),
  });
}

/**
 * src/state.js CCR_DEFAULTS: air diluent, 0.7 bar setpoint, a 3 L diluent
 * cylinder and a 2 L oxygen cylinder at 200 bar.
 */
export function createDefaultCcrSetup(): CcrSetup {
  return Object.freeze({
    diluent: createGasMix(
      AIR_PRESET.oxygenFraction,
      AIR_PRESET.heliumFraction,
    ),
    setpointBar: 0.7,
    diluentCylinderVolumeL: 3,
    oxygenCylinderVolumeL: 2,
    oxygenCylinderPressureBar: 200,
  });
}

function createSetupTank(
  preset: GasPreset,
  volumeL = 12,
  pressureBar = 200,
): SetupTank {
  return Object.freeze({
    gas: createGasMix(preset.oxygenFraction, preset.heliumFraction),
    volumeL,
    pressureBar,
  });
}

/** How many presets the given mode offers. Rec hides the trimix half. */
export function presetCountFor(mode: DiveMode): number {
  return mode === "rec" ? REC_PRESET_COUNT : GAS_PRESETS.length;
}

/**
 * Switches mode the way src/state.js switchMode does: save the outgoing mode's
 * configuration, restore the incoming one's if it has been visited before.
 *
 * The first slice of #158 approximated this by dropping a trimix mix to air on
 * the way to rec, because rec has no helium control. That lost the mix; this
 * keeps it, so tec -> rec -> tec returns what the player had.
 *
 * Entering CCR normalises to a single tank, as switchMode does with the
 * BUG-CCR-9 comment: CCR has no concept of multiple open-circuit tanks, and
 * leaving stale tank state around lets it leak into a mode that cannot show
 * it. Leaving CCR is handled by the restore above.
 */
export function selectMode(setup: DiveSetup, mode: DiveMode): DiveSetup {
  if (setup.mode === mode) return setup;

  const savedModes = Object.freeze({
    ...setup.savedModes,
    [setup.mode]: snapshotOf(setup),
  });
  const restored = setup.savedModes[mode];

  const next: DiveSetup = Object.freeze({
    ...setup,
    ...(restored ?? {}),
    mode,
    savedModes,
  });

  if (mode !== "ccr") return next;
  return Object.freeze({
    ...next,
    tanks: Object.freeze([next.tanks[0]!]),
    selectedTabIndex: 0,
    activeTankIndex: 0,
  });
}

function snapshotOf(setup: DiveSetup): ModeSnapshot {
  return Object.freeze({
    tanks: setup.tanks,
    selectedTabIndex: setup.selectedTabIndex,
    activeTankIndex: setup.activeTankIndex,
    surfaceAirConsumptionLpm: setup.surfaceAirConsumptionLpm,
    gradientFactorLow: setup.gradientFactorLow,
    gradientFactorHigh: setup.gradientFactorHigh,
    ccr: setup.ccr,
  });
}

export function selectSite(setup: DiveSetup, siteId: SiteId): DiveSetup {
  return setup.siteId === siteId ? setup : Object.freeze({ ...setup, siteId });
}

/**
 * Applies a gas preset to the active tank. `index` is zero-based; the screen
 * binds it to keys 1-n. Out-of-range indices, including a trimix preset while
 * in rec, are refused rather than clamped: a silent neighbouring gas is worse
 * than nothing happening.
 */
export function applyPreset(setup: DiveSetup, index: number): DiveSetup {
  if (!Number.isInteger(index)) return setup;
  if (index < 0 || index >= presetCountFor(setup.mode)) return setup;

  const preset = GAS_PRESETS[index]!;
  const tank = setup.tanks[setup.selectedTabIndex]!;
  return Object.freeze({
    ...setup,
    tanks: replaceTank(setup.tanks, setup.selectedTabIndex, {
      ...tank,
      gas: createGasMix(preset.oxygenFraction, preset.heliumFraction),
    }),
  });
}

/**
 * Nudges the active tank's oxygen fraction, keeping helium where it is.
 * Clamped so that the three fractions stay a valid mix: oxygen can never push
 * nitrogen negative.
 */
export function adjustOxygenFraction(
  setup: DiveSetup,
  deltaFraction: number,
): DiveSetup {
  const tank = setup.tanks[setup.selectedTabIndex]!;
  const ceiling = Math.min(
    OXYGEN_FRACTION_RANGE.max,
    1 - tank.gas.heliumFraction,
  );
  const next = clampToStep(
    tank.gas.oxygenFraction + deltaFraction,
    OXYGEN_FRACTION_RANGE.min,
    ceiling,
    OXYGEN_FRACTION_STEP,
  );
  if (next === tank.gas.oxygenFraction) return setup;

  return Object.freeze({
    ...setup,
    tanks: replaceTank(setup.tanks, setup.selectedTabIndex, {
      ...tank,
      gas: createGasMix(next, tank.gas.heliumFraction),
    }),
  });
}

export function adjustTankPressure(
  setup: DiveSetup,
  deltaBar: number,
): DiveSetup {
  const tank = setup.tanks[setup.selectedTabIndex]!;
  const next = clampToStep(
    tank.pressureBar + deltaBar,
    TANK_PRESSURE_RANGE_BAR.min,
    TANK_PRESSURE_RANGE_BAR.max,
    TANK_PRESSURE_STEP_BAR,
  );
  if (next === tank.pressureBar) return setup;

  return Object.freeze({
    ...setup,
    tanks: replaceTank(setup.tanks, setup.selectedTabIndex, {
      ...tank,
      pressureBar: next,
    }),
  });
}

/**
 * The gradient factors and ascent rate the forecast runs on.
 *
 * Separate from toInitialDiveOptions because they are planner inputs, not
 * dive state: DiveState has no GF field. Without this the screen changed a
 * stored number and the planner kept using DEFAULT_PLANNER_SETTINGS (#158
 * review), so the control was decorative.
 *
 * This is the fresh-dive path only. A resumed dive takes its factors from the
 * save, through the same builder — see wreck-app.ts.
 */
export function toPlannerSettings(setup: DiveSetup): Readonly<PlannerSettings> {
  return plannerSettingsWithGradientFactors(
    setup.gradientFactorLow,
    setup.gradientFactorHigh,
  );
}

/**
 * The configuration a DiveState is built from.
 *
 * The open-circuit cylinder survives into CCR because the dive still carries
 * one — legacy keeps `tanks[0]` when it normalises to a single cylinder on
 * entering CCR, and its setup screen simply stops offering the controls for
 * it. Bailout breathes the diluent, not this tank, but the model wants a tank
 * either way.
 *
 * Everything createCcrState is not given comes from its own defaults, which
 * are CCR_DEFAULTS: the diluent's 200 bar, the 6 L loop, 180 minutes of
 * scrubber, the 0.8 L/min metabolic rate. Those have no control in the legacy
 * setup screen, so they get none here.
 */
export function toInitialDiveOptions(setup: DiveSetup): InitialDiveOptions {
  return {
    tanks: setup.tanks.map((tank) =>
      createTankState(tank.gas, tank.volumeL, tank.pressureBar),
    ),
    activeTankIndex: setup.activeTankIndex,
    surfaceAirConsumptionLpm: setup.surfaceAirConsumptionLpm,
    ccr: setup.mode === "ccr" ? toCcrState(setup.ccr) : null,
  };
}

function toCcrState(ccr: CcrSetup) {
  // actualPo2Bar is left to createCcrState, which starts the loop at the
  // setpoint below 1 bar and at 0.21 otherwise. That is src/game-loop.js's
  // `targetSP < ambientPressure(0) ? targetSP : 0.21`, and ambientPressure(0)
  // is 1.0 — the same rule, already implemented, so it is not repeated here.
  return createCcrState(ccr.diluent, {
    targetPo2Bar: bars(ccr.setpointBar),
    diluentCylinderVolumeL: litres(ccr.diluentCylinderVolumeL),
    oxygenCylinderVolumeL: litres(ccr.oxygenCylinderVolumeL),
    oxygenCylinderPressureBar: bars(ccr.oxygenCylinderPressureBar),
  });
}

function replaceTank(
  tanks: readonly SetupTank[],
  index: number,
  tank: SetupTank,
): readonly SetupTank[] {
  return Object.freeze(
    tanks.map((existing, at) => (at === index ? Object.freeze(tank) : existing)),
  );
}

// Rounded to the step before clamping, so repeated nudges from an off-grid
// starting value converge onto the grid instead of carrying the offset
// forever. Floating point is dealt with by rounding in integer step units
// rather than by comparing with an epsilon.
function clampToStep(
  value: number,
  min: number,
  max: number,
  step: number,
): number {
  const steps = Math.round(value / step);
  const snapped = steps * step;
  const bounded = Math.min(max, Math.max(min, snapped));
  return Math.round(bounded / step) * step;
}
