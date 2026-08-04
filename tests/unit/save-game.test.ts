import { describe, expect, it } from "vitest";
import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
  type DiveState,
} from "../../src/core/dive-state";
import { bars, litres, seconds } from "../../src/core/units";
import {
  CURRENT_SAVE_GAME_VERSION,
  SAVE_GAME_SCHEMA,
  createSaveGame,
  decodeSaveGame,
  encodeSaveGame,
} from "../../src/save/save-game";

describe("SaveGame", () => {
  it("round-trips every authoritative DiveState field", () => {
    const state = representativeState();
    const encoded = encodeSaveGame(createSaveGame(state, 1_735_689_600_000));
    const decoded = decodeSaveGame(encoded);

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.migratedFrom).toBeNull();
    expect(decoded.saveGame.state).toEqual(state);
    expect(decoded.saveGame.savedAtEpochMs).toBe(1_735_689_600_000);
    expect(Object.isFrozen(decoded.saveGame)).toBe(true);
    expect(Object.isFrozen(decoded.saveGame.state.tissues.nitrogenBar)).toBe(true);
    expect(Object.isFrozen(decoded.saveGame.state.tanks[0]?.gas)).toBe(true);
  });

  it("rejects future versions without interpreting their payload", () => {
    const raw = JSON.stringify({
      schema: SAVE_GAME_SCHEMA,
      version: CURRENT_SAVE_GAME_VERSION + 1,
      savedAtEpochMs: 1_735_689_600_000,
      state: representativeState(),
    });

    expect(decodeSaveGame(raw)).toEqual({
      ok: false,
      reason: "unsupported-version",
    });
  });

  it.each([
    ["truncated JSON", "{\"schema\":"],
    ["wrong tissue count", corruptState((state) => {
      state.tissues.nitrogenBar.pop();
    })],
    ["coerced numeric value", corruptState((state) => {
      state.depthM = "20";
    })],
    ["invalid gas fractions", corruptState((state) => {
      state.tanks[0]!.gas.oxygenFraction = 0.8;
    })],
    ["out-of-range active tank", corruptState((state) => {
      state.activeTankIndex = 7;
    })],
    ["event after save time", corruptState((state) => {
      state.events[0]!.elapsedTimeS = state.elapsedTimeS + 1;
    })],
  ])("rejects corrupted input: %s", (_name, raw) => {
    expect(decodeSaveGame(raw).ok).toBe(false);
  });

  it("migrates the legacy browser v2 save into the authoritative schema", () => {
    const result = decodeSaveGame(JSON.stringify(legacyV2Save()));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migratedFrom).toBe("legacy-v2");
    expect(result.saveGame.schema).toBe(SAVE_GAME_SCHEMA);
    expect(result.saveGame.version).toBe(CURRENT_SAVE_GAME_VERSION);
    expect(result.saveGame.state.elapsedTimeS).toBe(750);
    expect(result.saveGame.state.depthM).toBe(24);
    expect(result.saveGame.state.tanks[0]).toMatchObject({
      volumeL: 12,
      gasRemainingL: 1_620,
    });
    expect(result.saveGame.state.ccr).toMatchObject({
      targetPo2Bar: 1.3,
      actualPo2Bar: 1.28,
      scrubberRemainingS: 9_000,
      onBailout: false,
    });
  });

  it("rejects malformed legacy saves instead of guessing missing state", () => {
    const legacy = legacyV2Save();
    delete (legacy.ccrState as Record<string, unknown>).actualPO2;

    expect(decodeSaveGame(JSON.stringify(legacy))).toEqual({
      ok: false,
      reason: "invalid-data",
    });
  });
});

function representativeState(): DiveState {
  const air = createTankState(createGasMix(0.21, 0), 12, 180);
  const nitrox = createTankState(createGasMix(0.5, 0), 7, 160);
  const initial = createInitialDiveState(0x1234_5678, {
    tanks: [air, nitrox],
    activeTankIndex: 1,
    surfaceAirConsumptionLpm: 18,
    ccr: {
      ...createCcrState(createGasMix(0.15, 0.45), {
        targetPo2Bar: bars(1.3),
        actualPo2Bar: bars(1.27),
      }),
      oxygenCylinderPressureBar: bars(175),
      diluentCylinderPressureBar: bars(164),
      scrubberRemainingS: seconds(8_800),
      co2BuildupS: seconds(2),
    },
  });

  return freezeDiveState({
    ...initial,
    elapsedTimeS: seconds(420),
    depthM: 21 as DiveState["depthM"],
    maxDepthM: 30 as DiveState["maxDepthM"],
    tanks: [
      { ...air, gasRemainingL: litres(1_950) },
      { ...nitrox, gasRemainingL: litres(930) },
    ],
    failure: {
      ...initial.failure,
      oxygenToxicityS: seconds(3),
    },
    events: [
      { type: "gas-switch", elapsedTimeS: seconds(400), tankIndex: 1 },
    ],
  });
}

interface MutableEncodedState {
  depthM: unknown;
  elapsedTimeS: number;
  activeTankIndex: unknown;
  tissues: { nitrogenBar: unknown[] };
  tanks: { gas: { oxygenFraction: unknown } }[];
  events: { elapsedTimeS: number }[];
}

function corruptState(mutator: (state: MutableEncodedState) => void): string {
  const save = JSON.parse(
    encodeSaveGame(createSaveGame(representativeState(), 1_735_689_600_000)),
  ) as { state: MutableEncodedState };
  mutator(save.state);
  return JSON.stringify(save);
}

function legacyV2Save(): Record<string, unknown> {
  return {
    saveVersion: 2,
    savedAt: 1_735_689_600_000,
    gameState: "diving",
    depth: 24,
    maxDepth: 31,
    diveTime: 12.5,
    amvRate: 17,
    po2ViolationTime: 1,
    hypoxiaTime: 0,
    ccrHypoxiaTime: 0,
    ccrHyperoxiaTime: 2,
    tissues: Array.from({ length: 16 }, (_, index) => 0.8 + index / 100),
    tissuesHe: Array.from({ length: 16 }, (_, index) => index / 200),
    activeTank: 0,
    tankCount: 1,
    diveMode: "ccr",
    tanks: [
      {
        fO2: 0.21,
        fHe: 0,
        fN2: 0.79,
        pressure: 135,
        volume: 12,
        totalGas: 2_400,
        gasRemaining: 1_620,
      },
    ],
    ccrState: {
      o2CylVolume: 2,
      o2CylPressure: 175,
      dilCylVolume: 3,
      dilCylPressure: 160,
      dilFO2: 0.15,
      dilFN2: 0.4,
      dilFHe: 0.45,
      loopVolume: 6,
      targetSP: 1.3,
      actualPO2: 1.28,
      scrubberRemaining: 150,
      metabolicO2Rate: 0.8,
      po2ResponseRate: 0.05,
      onBailout: false,
      scrubberFailed: false,
      co2BuildupTime: 0,
    },
  };
}
