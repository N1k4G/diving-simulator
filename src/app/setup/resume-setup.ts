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
import { CCR_PRESSURE_STEP_BAR, OXYGEN_PRESSURE_RANGE_BAR } from "./ccr-controls";
import type { CcrState, TankState } from "../../core/dive-state";

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
 * Held to the screen's 200-300 bar in its 10 bar steps, which changes no
 * fill the screen could have set. A save from before v10 never recorded the
 * fill and starts its gas where the migration found it, so its cylinder,
 * part-breathed, returns at the screen's 200 bar.
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
 * setpoint the dive was on, the two cylinder sizes. The oxygen cylinder at
 * the pressure the dive started on, as a new dive's retry returns to the
 * fill its setup configured; held to the screen's 50-300 bar.
 */
function ccrSetupFromSave(ccr: Readonly<CcrState>): CcrSetup {
  return Object.freeze({
    diluent: ccr.diluent,
    setpointBar: ccr.targetPo2Bar,
    diluentCylinderVolumeL: ccr.diluentCylinderVolumeL,
    oxygenCylinderVolumeL: ccr.oxygenCylinderVolumeL,
    oxygenCylinderPressureBar: clampToStep(
      ccr.oxygenCylinderStartPressureBar,
      OXYGEN_PRESSURE_RANGE_BAR.min,
      OXYGEN_PRESSURE_RANGE_BAR.max,
      CCR_PRESSURE_STEP_BAR,
    ),
  });
}
