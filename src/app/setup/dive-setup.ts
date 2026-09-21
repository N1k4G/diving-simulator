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
  DEFAULT_PLANNER_SETTINGS,
  type PlannerSettings,
} from "../../planner/dive-planner";
import {
  createGasMix,
  createTankState,
  type GasMix,
  type InitialDiveOptions,
} from "../../core/dive-state";

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
 * What the legacy client keeps per mode in `modeSettings` (src/state.js), so
 * switching away and back restores the configuration instead of losing it.
 */
export interface ModeSnapshot {
  readonly tanks: readonly SetupTank[];
  readonly selectedTabIndex: number;
  readonly activeTankIndex: number;
  readonly surfaceAirConsumptionLpm: number;
  readonly gradientFactorLow: number;
  readonly gradientFactorHigh: number;
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
    savedModes: Object.freeze({}),
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
 */
export function toPlannerSettings(setup: DiveSetup): PlannerSettings {
  return {
    ...DEFAULT_PLANNER_SETTINGS,
    gfLowPercent: setup.gradientFactorLow,
    gfHighPercent: setup.gradientFactorHigh,
  };
}

/** The configuration a DiveState is built from. */
export function toInitialDiveOptions(setup: DiveSetup): InitialDiveOptions {
  return {
    tanks: setup.tanks.map((tank) =>
      createTankState(tank.gas, tank.volumeL, tank.pressureBar),
    ),
    activeTankIndex: setup.activeTankIndex,
    surfaceAirConsumptionLpm: setup.surfaceAirConsumptionLpm,
    ccr: null,
  };
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
