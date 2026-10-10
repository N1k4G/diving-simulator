// The setup a resumed dive was configured with, rebuilt from its save (#191).
//
// Legacy's restoreDiveState() (src/game-loop.js) writes diveMode, gfLow,
// gfHigh, amvRate, the tanks and ccrState into the globals its gas setup is
// drawn from, so after a resumed dive ends, Enter returns to that dive's
// settings and not to whatever the setup showed before the resume. This is
// that, as a DiveSetup: the value the composition root hands the game-over
// and post-dive screens to return to.
//
// Pure, like dive-setup.ts: no DOM, so it is unit-tested without a browser.
import type { SaveGame } from "../../save/save-game";
import {
  TANK_PRESSURE_RANGE_BAR,
  TANK_PRESSURE_STEP_BAR,
  clampToStep,
  createDefaultCcrSetup,
  type CcrSetup,
  type DiveSetup,
  type SetupTank,
} from "./dive-setup";
import type { CcrState, DiveState, TankState } from "../../core/dive-state";

export function setupFromSave(save: Readonly<SaveGame>): DiveSetup {
  const { state } = save;
  const mode = save.diveMode;
  const tanks = state.tanks.map(setupTankFromSave);
  return Object.freeze({
    mode,
    // The save names no site, and the wreck is the only one a dive can be
    // resumed on: it is the only one the renderer draws (RENDERABLE_SITES).
    siteId: "wreck",
    // A rebreather dive carries one open-circuit cylinder, which its setup
    // keeps (selectMode); the others carry what they were set up with.
    tanks: Object.freeze(mode === "ccr" ? tanks.slice(0, 1) : tanks),
    selectedTabIndex: 0,
    // Legacy's resetDive() starts the next dive on tanks[0], whichever the
    // resumed dive was breathing.
    activeTankIndex: 0,
    surfaceAirConsumptionLpm: state.surfaceAirConsumptionLpm,
    gradientFactorLow: save.gradientFactors.lowPercent,
    gradientFactorHigh: save.gradientFactors.highPercent,
    ccr: state.ccr ? ccrSetupFromSave(state.ccr) : createDefaultCcrSetup(),
    savedModes: Object.freeze({}),
  });
}

/**
 * A cylinder at its fill. Legacy saves the fill as `pressure`, and keeps
 * `totalGas` at `volume * pressure` wherever either changes (createTank,
 * gsAdjustPressure, gsAdjustTankVol in src/state.js); the save's startGasL
 * is that totalGas (v10, and migrateLegacyTank for a legacy save), so the
 * fill is startGasL over the volume, with no new field.
 *
 * Rounded to the nearest of the screen's 200-300 bar in its 10 bar steps,
 * which changes no fill the screen could have set. A save from before v10
 * never recorded the fill: the migration starts its gas where the save left
 * it, so its cylinder comes back at the gas left over the volume, rounded to
 * that grid (275 bar to 280, anything under 205 bar to 200).
 */
function setupTankFromSave(tank: Readonly<TankState>): SetupTank {
  return Object.freeze({
    gas: tank.gas,
    volumeL: tank.volumeL,
    pressureBar: clampToStep(
      tank.startGasL / tank.volumeL,
      TANK_PRESSURE_RANGE_BAR.min,
      TANK_PRESSURE_RANGE_BAR.max,
      TANK_PRESSURE_STEP_BAR,
    ),
  });
}

/**
 * The loop as legacy's restored ccrState sets its screen: the diluent, the
 * setpoint the dive was on, the two cylinder sizes, and both cylinders at
 * what the dive has left in them, which legacy's resetDive() starts the
 * next dive on (o2CylPressureStart = o2CylPressure, src/state.js).
 */
function ccrSetupFromSave(ccr: Readonly<CcrState>): CcrSetup {
  return Object.freeze({
    diluent: ccr.diluent,
    setpointBar: ccr.targetPo2Bar,
    diluentCylinderVolumeL: ccr.diluentCylinderVolumeL,
    oxygenCylinderVolumeL: ccr.oxygenCylinderVolumeL,
    oxygenCylinderPressureBar: ccr.oxygenCylinderPressureBar,
    diluentCylinderPressureBar: ccr.diluentCylinderPressureBar,
  });
}

/**
 * The setup the next dive starts from once `state` has ended, by a game
 * over or at the surface. Legacy's resetDive() refills every open-circuit
 * cylinder (gasRemaining = totalGas) but starts a rebreather's oxygen and
 * diluent cylinders where the last dive left them
 * (o2CylPressureStart = o2CylPressure, dilCylPressureStart =
 * dilCylPressure, src/state.js), on the setpoint the diver left it on: the
 * in-dive [ and ] write ccrState.targetSP (src/game-loop.js), which nothing
 * resets. The same for a new dive and a resumed one.
 */
export function setupForNextDive(
  setup: DiveSetup,
  state: Readonly<DiveState>,
): DiveSetup {
  if (setup.mode !== "ccr" || state.ccr === null) return setup;
  return Object.freeze({
    ...setup,
    ccr: Object.freeze({
      ...setup.ccr,
      setpointBar: state.ccr.targetPo2Bar,
      oxygenCylinderPressureBar: state.ccr.oxygenCylinderPressureBar,
      diluentCylinderPressureBar: state.ccr.diluentCylinderPressureBar,
    }),
  });
}

/**
 * src/game-loop.js loadSavedDive(): a save written more than an hour ago is
 * cleared, not offered (`Date.now() - state.savedAt > 3600000`).
 */
export const SAVED_DIVE_MAX_AGE_MS = 3_600_000;

export function isSavedDiveExpired(
  save: Readonly<SaveGame>,
  nowMs: number,
): boolean {
  return nowMs - save.savedAtEpochMs > SAVED_DIVE_MAX_AGE_MS;
}
