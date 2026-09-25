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
  DEFAULT_SAVED_GRADIENT_FACTORS,
  FIRST_SAVE_GAME_VERSION,
  SAVE_GAME_SCHEMA,
  createSaveGame,
  decodeSaveGame,
  encodeSaveGame,
} from "../../src/save/save-game";

describe("SaveGame", () => {
  it("round-trips every authoritative DiveState field", () => {
    const state = representativeState();
    const encoded = encodeSaveGame(createSaveGame(state, CONSERVATIVE_FACTORS, 1_735_689_600_000));
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

// #158 review: the save carried the DiveState and nothing else, so a dive
// begun on 50/80 came back planned on 35/75 — the state from the save, the
// factors from the setup screen the reload had just drawn. Tissues, gas and
// the clock continued while ceiling, NDL and TTS jumped.

describe("SaveGame gradient factors", () => {
  it("round-trips the pair the dive was planned with", () => {
    const encoded = encodeSaveGame(
      createSaveGame(representativeState(), CONSERVATIVE_FACTORS, 1_735_689_600_000),
    );
    const decoded = decodeSaveGame(encoded);

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.saveGame.gradientFactors).toEqual(CONSERVATIVE_FACTORS);
    expect(Object.isFrozen(decoded.saveGame.gradientFactors)).toBe(true);
    // Not the defaults, or the assertion above would pass on a save that
    // dropped the field and fell back.
    expect(decoded.saveGame.gradientFactors).not.toEqual(
      DEFAULT_SAVED_GRADIENT_FACTORS,
    );
  });

  it("migrates a v1 save by filling in the defaults it was planned on", () => {
    // A v1 save predates the factors reaching the planner at all, so 35/75 is
    // what that dive actually ran on. Filling them in is exact, not a guess.
    const v1 = JSON.parse(
      encodeSaveGame(
        createSaveGame(representativeState(), CONSERVATIVE_FACTORS, 1_735_689_600_000),
      ),
    ) as Record<string, unknown>;
    v1.version = FIRST_SAVE_GAME_VERSION;
    delete v1.gradientFactors;

    const result = decodeSaveGame(JSON.stringify(v1));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migratedFrom).toBe("save-game-v1");
    expect(result.saveGame.version).toBe(CURRENT_SAVE_GAME_VERSION);
    expect(result.saveGame.gradientFactors).toEqual(DEFAULT_SAVED_GRADIENT_FACTORS);
    // The dive itself survives the migration untouched.
    expect(result.saveGame.state).toEqual(representativeState());
  });

  // v3 carries the dive mode (#163, #185 review): a technical dive starts
  // with one cylinder, so its state alone looks recreational, and the mode
  // decides whether gas information is offered after a resume.
  describe("the dive mode", () => {
    const singleCylinder = () =>
      createInitialDiveState(81, {
        tanks: [createTankState(createGasMix(0.21, 0.35))],
      });

    it("round-trips a single-cylinder technical dive as technical", () => {
      const encoded = encodeSaveGame(
        createSaveGame(singleCylinder(), CONSERVATIVE_FACTORS, 1_735_689_600_000, "tec"),
      );
      const decoded = decodeSaveGame(encoded);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.migratedFrom).toBeNull();
      expect(decoded.saveGame.version).toBe(3);
      expect(decoded.saveGame.diveMode).toBe("tec");
    });

    it("defaults to the mode the dive implies when none is given", () => {
      expect(createSaveGame(singleCylinder(), CONSERVATIVE_FACTORS).diveMode).toBe("rec");
      const twoCylinders = createInitialDiveState(82, {
        tanks: [
          createTankState(createGasMix(0.21, 0)),
          createTankState(createGasMix(0.5, 0)),
        ],
      });
      expect(createSaveGame(twoCylinders, CONSERVATIVE_FACTORS).diveMode).toBe("tec");
      const loop = createInitialDiveState(83, {
        ccr: createCcrState(createGasMix(0.21, 0)),
      });
      expect(createSaveGame(loop, CONSERVATIVE_FACTORS).diveMode).toBe("ccr");
    });

    it("migrates a v2 save with the mode read off the dive", () => {
      const v2 = JSON.parse(
        encodeSaveGame(createSaveGame(singleCylinder(), CONSERVATIVE_FACTORS, 1_735_689_600_000, "tec")),
      ) as Record<string, unknown>;
      v2.version = 2;
      delete v2.diveMode;

      const result = decodeSaveGame(JSON.stringify(v2));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.migratedFrom).toBe("save-game-v2");
      expect(result.saveGame.version).toBe(3);
      // The best a save that never recorded the mode allows.
      expect(result.saveGame.diveMode).toBe("rec");
      expect(result.saveGame.gradientFactors).toEqual(CONSERVATIVE_FACTORS);
    });

    it("rejects a v3 save whose mode contradicts its state", () => {
      const v3 = JSON.parse(
        encodeSaveGame(createSaveGame(singleCylinder(), CONSERVATIVE_FACTORS, 1_735_689_600_000)),
      ) as Record<string, unknown>;
      for (const bad of ["ccr", "deep", undefined]) {
        v3.diveMode = bad;
        expect(decodeSaveGame(JSON.stringify(v3))).toEqual({ ok: false, reason: "invalid-data" });
      }
    });

    it("refuses to build a save whose mode contradicts its state", () => {
      expect(() => createSaveGame(singleCylinder(), CONSERVATIVE_FACTORS, 1, "ccr")).toThrow(RangeError);
    });
  });

  it.each([
    ["missing", undefined],
    ["not an object", 50],
    ["half a pair", { lowPercent: 50 }],
    ["below the floor", { lowPercent: 20, highPercent: 80 }],
    ["above the ceiling", { lowPercent: 50, highPercent: 140 }],
    ["crossed", { lowPercent: 80, highPercent: 50 }],
    ["not a number", { lowPercent: "50", highPercent: "80" }],
    ["not finite", { lowPercent: 50, highPercent: Number.POSITIVE_INFINITY }],
  ])(
    "rejects a current save whose factors are %s rather than silently defaulting",
    (_name, factors) => {
      // Falling back here would re-plan the dive on 35/75 without saying so —
      // the exact failure this field exists to stop, hidden behind a save that
      // still loads.
      const save = JSON.parse(
        encodeSaveGame(
          createSaveGame(representativeState(), CONSERVATIVE_FACTORS, 1_735_689_600_000),
        ),
      ) as Record<string, unknown>;
      if (factors === undefined) {
        delete save.gradientFactors;
      } else {
        save.gradientFactors = factors;
      }

      expect(decodeSaveGame(JSON.stringify(save))).toEqual({
        ok: false,
        reason: "invalid-data",
      });
    },
  );

  it("refuses to write a pair outside the bounds", () => {
    expect(() =>
      createSaveGame(representativeState(), { lowPercent: 80, highPercent: 50 }),
    ).toThrow(RangeError);
  });

  it("carries the legacy client's own gfLow and gfHigh across", () => {
    // src/game-loop.js writes `gfLow` and `gfHigh` into the browser save and
    // restoreDiveState reads them back, so this migration is lossless. It used
    // to drop them: the same defect as the resume path, one format earlier.
    const legacy = { ...legacyV2Save(), gfLow: 45, gfHigh: 85 };

    const result = decodeSaveGame(JSON.stringify(legacy));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.saveGame.gradientFactors).toEqual({
      lowPercent: 45,
      highPercent: 85,
    });
  });

  it.each([
    ["written before the field existed", {}],
    ["out of bounds", { gfLow: 0, gfHigh: 200 }],
  ])("resumes a legacy save whose factors are %s on the defaults", (_name, overrides) => {
    // Losing a dive is worse than resuming it on 35/75, so an unusable legacy
    // pair falls back rather than failing the whole migration. A current-format
    // save gets the opposite treatment above, because it has no excuse.
    const result = decodeSaveGame(
      JSON.stringify({ ...legacyV2Save(), ...overrides }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.saveGame.gradientFactors).toEqual(DEFAULT_SAVED_GRADIENT_FACTORS);
  });
});

const CONSERVATIVE_FACTORS = Object.freeze({
  lowPercent: 50,
  highPercent: 80,
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
    encodeSaveGame(
      createSaveGame(
        representativeState(),
        CONSERVATIVE_FACTORS,
        1_735_689_600_000,
      ),
    ),
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
