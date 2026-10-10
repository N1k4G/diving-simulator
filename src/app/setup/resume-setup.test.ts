import { describe, expect, it } from "vitest";

import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
  type DiveState,
} from "../../core/dive-state";
import { bars, litres, metres, seconds } from "../../core/units";
import {
  createSaveGame,
  decodeSaveGame,
  encodeSaveGame,
  type SaveGame,
  type SavedDiveMode,
} from "../../save/save-game";
import { createDefaultSetup, selectMode, toInitialDiveOptions } from "./dive-setup";
import { isSavedDiveExpired, setupForNextDive, setupFromSave } from "./resume-setup";

// The fills below are whole bar on whole litres, so startGasL over the
// volume is exact and toEqual compares them as the screen would.
//
// #191: a resumed dive's game over returned to the setup screen that had
// preceded the resume, not to the dive. Legacy's restoreDiveState() writes
// the save's mode, factors, consumption, tanks (fill included) and loop into
// the globals its gas setup is drawn from, so its Enter returns to the dive
// that failed.

const EAN32 = createGasMix(0.32, 0);
const TX1845 = createGasMix(0.18, 0.45);

/** The save as the setup screen loads it: written, then read back. */
function loaded(state: DiveState, mode: SavedDiveMode, low = 50, high = 80): SaveGame {
  const raw = encodeSaveGame(
    createSaveGame(state, { lowPercent: low, highPercent: high }, 1_735_689_600_000, mode),
  );
  const decoded = decodeSaveGame(raw);
  if (!decoded.ok) throw new Error(`save did not load: ${decoded.reason}`);
  return decoded.saveGame;
}

/** A rebreather dive with its oxygen at 181.5 of 220 bar and diluent at 150. */
function rebreatherDive(): DiveState {
  return breathed(
    createInitialDiveState(0, {
      tanks: [createTankState(createGasMix(0.21, 0), 12, 200)],
      ccr: createCcrState(TX1845, {
        targetPo2Bar: bars(1.3),
        diluentCylinderVolumeL: litres(5),
        oxygenCylinderVolumeL: litres(3),
        oxygenCylinderPressureBar: bars(181.5),
        oxygenCylinderStartPressureBar: bars(220),
        diluentCylinderPressureBar: bars(150),
        diluentCylinderStartPressureBar: bars(200),
      }),
    }),
    [],
  );
}

/** A dive twenty minutes in, at 20 m, each cylinder part-breathed. */
function breathed(state: DiveState, usedL: readonly number[]): DiveState {
  return {
    ...state,
    elapsedTimeS: seconds(1_200),
    depthM: metres(20),
    maxDepthM: metres(30),
    tanks: state.tanks.map((tank, index) => ({
      ...tank,
      gasRemainingL: litres(tank.startGasL - (usedL[index] ?? 0)),
    })),
  };
}

describe("setupFromSave", () => {
  it("returns a technical dive's mode, factors, consumption and cylinders at their fill", () => {
    // On the second cylinder, switched to ten minutes in.
    const state: DiveState = {
      ...breathed(
        createInitialDiveState(0, {
          tanks: [createTankState(TX1845, 15, 230), createTankState(EAN32, 7, 250)],
          surfaceAirConsumptionLpm: 18,
        }),
        [1_250, 400],
      ),
      activeTankIndex: 1,
      events: [{ type: "gas-switch", elapsedTimeS: seconds(600), tankIndex: 1 }],
    };

    const setup = setupFromSave(loaded(state, "tec"));

    expect(setup.mode).toBe("tec");
    expect(setup.siteId).toBe("wreck");
    expect(setup.gradientFactorLow).toBe(50);
    expect(setup.gradientFactorHigh).toBe(80);
    expect(setup.surfaceAirConsumptionLpm).toBe(18);
    // The fill, not what is left: 230 and 250 bar, where the cylinders
    // now hold about 147 and 193.
    expect(setup.tanks.map((tank) => tank.pressureBar)).toEqual([230, 250]);
    expect(setup.tanks.map((tank) => tank.volumeL)).toEqual([15, 7]);
    expect(setup.tanks[0]?.gas).toEqual(TX1845);
    expect(setup.tanks[1]?.gas).toEqual(EAN32);
    // Legacy's resetDive() starts the next dive on the first cylinder.
    expect(setup.activeTankIndex).toBe(0);
    expect(setup.selectedTabIndex).toBe(0);
  });

  it("starts the retried dive with the gas the resumed one started with", () => {
    const state = breathed(
      createInitialDiveState(0, {
        tanks: [createTankState(TX1845, 15, 230), createTankState(EAN32, 7, 250)],
      }),
      [1_250, 400],
    );

    const retried = toInitialDiveOptions(setupFromSave(loaded(state, "tec")));

    // Legacy's resetDive(): gasRemaining = totalGas, for every cylinder.
    expect(retried.tanks?.map((tank) => tank.startGasL)).toEqual([3_450, 1_750]);
    expect(retried.tanks?.map((tank) => tank.gasRemainingL)).toEqual([3_450, 1_750]);
    expect(retried.ccr).toBeNull();
  });

  it("returns a rebreather dive's loop, with both cylinders at what the dive left in them", () => {
    // Legacy's resetDive(): o2CylPressureStart = o2CylPressure and
    // dilCylPressureStart = dilCylPressure, never a refill.
    const state = rebreatherDive();

    const setup = setupFromSave(loaded(state, "ccr", 40, 85));

    expect(setup.mode).toBe("ccr");
    expect(setup.tanks).toHaveLength(1);
    expect(setup.gradientFactorLow).toBe(40);
    expect(setup.gradientFactorHigh).toBe(85);
    expect(setup.ccr).toEqual({
      diluent: TX1845,
      setpointBar: 1.3,
      diluentCylinderVolumeL: 5,
      oxygenCylinderVolumeL: 3,
      oxygenCylinderPressureBar: 181.5,
      diluentCylinderPressureBar: 150,
    });
    const retried = toInitialDiveOptions(setup).ccr;
    expect(retried?.oxygenCylinderPressureBar).toBe(181.5);
    expect(retried?.oxygenCylinderStartPressureBar).toBe(181.5);
    expect(retried?.diluentCylinderPressureBar).toBe(150);
    expect(retried?.diluentCylinderStartPressureBar).toBe(150);
  });

  it("returns a legacy save's fill, which legacy keeps as pressure and totalGas", () => {
    // src/state.js keeps totalGas at volume * pressure (createTank,
    // gsAdjustPressure, gsAdjustTankVol); the import keeps totalGas.
    const legacy = {
      saveVersion: 2,
      savedAt: 1_735_689_600_000,
      gameState: "diving",
      depth: 24,
      maxDepth: 31,
      diveTime: 12.5,
      amvRate: 17,
      po2ViolationTime: 0,
      hypoxiaTime: 0,
      ccrHypoxiaTime: 0,
      ccrHyperoxiaTime: 0,
      tissues: Array.from({ length: 16 }, (_, index) => 0.8 + index / 100),
      tissuesHe: Array.from({ length: 16 }, () => 0),
      activeTank: 1,
      tankCount: 2,
      diveMode: "tec",
      gfLow: 45,
      gfHigh: 70,
      tanks: [
        { fO2: 0.21, fHe: 0, fN2: 0.79, pressure: 260, volume: 15, totalGas: 3_900, gasRemaining: 2_100 },
        { fO2: 0.5, fHe: 0, fN2: 0.5, pressure: 210, volume: 7, totalGas: 1_470, gasRemaining: 1_470 },
      ],
    };
    const decoded = decodeSaveGame(JSON.stringify(legacy));
    if (!decoded.ok) throw new Error(`legacy save did not load: ${decoded.reason}`);

    const setup = setupFromSave(decoded.saveGame);

    expect(setup.mode).toBe("tec");
    expect(setup.gradientFactorLow).toBe(45);
    expect(setup.gradientFactorHigh).toBe(70);
    expect(setup.surfaceAirConsumptionLpm).toBe(17);
    expect(setup.tanks.map((tank) => tank.pressureBar)).toEqual([260, 210]);
    expect(setup.tanks.map((tank) => tank.volumeL)).toEqual([15, 7]);
  });

  it("returns a cylinder whose save never recorded its fill at the screen's 200 bar", () => {
    // A v9 save has no startGasL: the migration starts the gas where it
    // found it, part breathed, 1,500 L in 12 L, 125 bar, which the screen
    // cannot set.
    const state = breathed(
      createInitialDiveState(0, {
        tanks: [createTankState(createGasMix(0.21, 0), 12, 200)],
      }),
      [900],
    );
    const v9 = JSON.parse(
      encodeSaveGame(createSaveGame(state, { lowPercent: 35, highPercent: 75 }, 1_735_689_600_000, "rec")),
    ) as { version: number; state: { tanks: Record<string, unknown>[] } };
    v9.version = 9;
    for (const tank of v9.state.tanks) delete tank.startGasL;
    const decoded = decodeSaveGame(JSON.stringify(v9));
    if (!decoded.ok) throw new Error(`v9 save did not load: ${decoded.reason}`);
    expect(decoded.saveGame.state.tanks[0]?.startGasL).toBe(1_500);

    const setup = setupFromSave(decoded.saveGame);

    expect(setup.tanks[0]?.pressureBar).toBe(200);
  });

  it("returns a pre-v10 cylinder at the gas it had left, rounded to the screen's grid", () => {
    // 12 L filled to 300 bar, 300 L breathed: 3,300 L, 275 bar, to 280.
    const state = breathed(
      createInitialDiveState(0, {
        tanks: [createTankState(createGasMix(0.21, 0), 12, 300)],
      }),
      [300],
    );
    const v9 = JSON.parse(
      encodeSaveGame(createSaveGame(state, { lowPercent: 35, highPercent: 75 }, 1_735_689_600_000, "rec")),
    ) as { version: number; state: { tanks: Record<string, unknown>[] } };
    v9.version = 9;
    for (const tank of v9.state.tanks) delete tank.startGasL;
    const decoded = decodeSaveGame(JSON.stringify(v9));
    if (!decoded.ok) throw new Error(`v9 save did not load: ${decoded.reason}`);

    expect(setupFromSave(decoded.saveGame).tanks[0]?.pressureBar).toBe(280);
  });
});

describe("setupForNextDive", () => {
  it("starts a rebreather's next dive on the cylinders as this one left them", () => {
    const setup = selectMode(createDefaultSetup(), "ccr");

    const next = setupForNextDive(setup, rebreatherDive());

    expect(next.ccr.oxygenCylinderPressureBar).toBe(181.5);
    expect(next.ccr.diluentCylinderPressureBar).toBe(150);
    expect(next.ccr.diluent).toEqual(setup.ccr.diluent);
    expect(next.ccr.setpointBar).toBe(setup.ccr.setpointBar);
  });

  it("leaves an open-circuit setup as it is: its cylinders start full", () => {
    const setup = createDefaultSetup();
    const state = breathed(
      createInitialDiveState(0, { tanks: [createTankState(createGasMix(0.21, 0), 12, 200)] }),
      [900],
    );

    expect(setupForNextDive(setup, state)).toBe(setup);
  });
});

describe("isSavedDiveExpired", () => {
  it("drops a save older than legacy's hour, and keeps one an hour old", () => {
    const save = loaded(rebreatherDive(), "ccr");

    expect(isSavedDiveExpired(save, save.savedAtEpochMs + 3_600_000)).toBe(false);
    expect(isSavedDiveExpired(save, save.savedAtEpochMs + 3_600_001)).toBe(true);
  });
});
