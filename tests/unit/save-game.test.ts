import { describe, expect, it } from "vitest";
import {
  createCcrState,
  createEmptyDiveLog,
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
import { neutralBcdSurfaceLitres } from "../../src/core/buoyancy";

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
    // The dive itself survives the migration, and resumes at rest with the
    // BCD neutral at its depth, since no save before v6 recorded live
    // vertical motion (#192).
    expect(result.saveGame.state).toEqual({
      ...representativeState(),
      verticalVelocityMpm: 0,
      bcdGasSurfaceLiters: neutralBcdSurfaceLitres(representativeState().depthM),
    });
  });

  // v3 carries the dive mode (#163, #185 review): a technical dive starts
  // with one cylinder, so its state alone looks recreational, and the mode
  // decides whether gas information is offered after a resume.
  // v4 carries the dive's CNS exposure (#186).
  describe("CNS exposure", () => {
    const withCns = (cnsPercent: number) =>
      freezeDiveState({ ...createInitialDiveState(84), cnsPercent });

    it("round-trips in a current save", () => {
      const decoded = decodeSaveGame(
        encodeSaveGame(createSaveGame(withCns(17.92), CONSERVATIVE_FACTORS, 1_735_689_600_000)),
      );
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.migratedFrom).toBeNull();
      expect(decoded.saveGame.version).toBe(CURRENT_SAVE_GAME_VERSION);
      expect(decoded.saveGame.state.cnsPercent).toBe(17.92);
    });

    it("migrates a v3 save to 0, keeping its mode", () => {
      // A v3 save was written by a client that did not track CNS.
      const v3 = JSON.parse(
        encodeSaveGame(createSaveGame(withCns(0), CONSERVATIVE_FACTORS, 1_735_689_600_000, "rec")),
      ) as { version: number; diveMode: string; state: Record<string, unknown> };
      v3.version = 3;
      delete v3.state.cnsPercent;

      const result = decodeSaveGame(JSON.stringify(v3));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.migratedFrom).toBe("save-game-v3");
      expect(result.saveGame.state.cnsPercent).toBe(0);
      expect(result.saveGame.diveMode).toBe("rec");
    });

    it("resumes any pre-v4 save at 0, whatever cnsPercent it carries", () => {
      // #188 Codex round 1: a v3 payload with a stray cnsPercent kept it, and
      // an invalid one was rejected instead of resuming at 0.
      for (const stray of [17.92, "x", -3]) {
        const v3 = JSON.parse(
          encodeSaveGame(createSaveGame(withCns(0), CONSERVATIVE_FACTORS, 1_735_689_600_000, "rec")),
        ) as { version: number; state: Record<string, unknown> };
        v3.version = 3;
        v3.state.cnsPercent = stray;
        const result = decodeSaveGame(JSON.stringify(v3));
        expect(result.ok, String(stray)).toBe(true);
        if (!result.ok) return;
        expect(result.saveGame.state.cnsPercent, String(stray)).toBe(0);
      }
    });

    it("rejects a v4 save without a valid CNS", () => {
      for (const bad of [undefined, -1, "12", Number.NaN]) {
        const v4 = JSON.parse(
          encodeSaveGame(createSaveGame(withCns(5), CONSERVATIVE_FACTORS, 1_735_689_600_000)),
        ) as { state: Record<string, unknown> };
        if (bad === undefined) delete v4.state.cnsPercent;
        else v4.state.cnsPercent = bad;
        expect(decodeSaveGame(JSON.stringify(v4)).ok).toBe(false);
      }
    });

    it("carries legacy's cnsPercent over, and defaults a missing one to 0", () => {
      const legacy = { ...legacyV2Save(), cnsPercent: 23.5 };
      const carried = decodeSaveGame(JSON.stringify(legacy));
      expect(carried.ok && carried.saveGame.state.cnsPercent).toBe(23.5);

      const withoutCns: Record<string, unknown> = { ...legacyV2Save() };
      delete withoutCns.cnsPercent;
      const defaulted = decodeSaveGame(JSON.stringify(withoutCns));
      expect(defaulted.ok && defaulted.saveGame.state.cnsPercent).toBe(0);
    });
  });

  // v5 added vertical motion, v6 marks it live (#192).
  describe("vertical motion", () => {
    const moving = () =>
      freezeDiveState({
        ...createInitialDiveState(85),
        depthM: 22.5 as DiveState["depthM"],
        maxDepthM: 22.5 as DiveState["maxDepthM"],
        verticalVelocityMpm: -12.25,
        bcdGasSurfaceLiters: 13.9,
      });

    it("round-trips velocity and BCD gas in a current save", () => {
      const decoded = decodeSaveGame(encodeSaveGame(createSaveGame(moving(), CONSERVATIVE_FACTORS, 1_735_689_600_000)));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.saveGame.version).toBe(CURRENT_SAVE_GAME_VERSION);
      expect(decoded.saveGame.state.verticalVelocityMpm).toBe(-12.25);
      expect(decoded.saveGame.state.bcdGasSurfaceLiters).toBe(13.9);
    });

    it("resumes a v4 save at rest, with the BCD neutral at its depth", () => {
      const v4 = JSON.parse(
        encodeSaveGame(createSaveGame(moving(), CONSERVATIVE_FACTORS, 1_735_689_600_000)),
      ) as { version: number; state: Record<string, unknown> };
      v4.version = 4;
      delete v4.state.verticalVelocityMpm;
      delete v4.state.bcdGasSurfaceLiters;
      const result = decodeSaveGame(JSON.stringify(v4));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.migratedFrom).toBe("save-game-v4");
      expect(result.saveGame.state.verticalVelocityMpm).toBe(0);
      expect(result.saveGame.state.bcdGasSurfaceLiters).toBeCloseTo(neutralBcdSurfaceLitres(22.5), 12);
    });

    it("resumes a v5 save at rest and neutral: its client never moved the diver with them", () => {
      // What main's client wrote between #193 and #198: the model's untouched
      // 2 L at 26 m, which would sink a resumed diver to the floor.
      const v5 = JSON.parse(
        encodeSaveGame(createSaveGame(moving(), CONSERVATIVE_FACTORS, 1_735_689_600_000)),
      ) as { version: number; state: Record<string, unknown> };
      v5.version = 5;
      v5.state.depthM = 26;
      v5.state.maxDepthM = 26;
      v5.state.verticalVelocityMpm = 0;
      v5.state.bcdGasSurfaceLiters = 2;
      const result = decodeSaveGame(JSON.stringify(v5));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.migratedFrom).toBe("save-game-v5");
      expect(result.saveGame.version).toBe(CURRENT_SAVE_GAME_VERSION);
      expect(result.saveGame.state.verticalVelocityMpm).toBe(0);
      expect(result.saveGame.state.bcdGasSurfaceLiters).toBeCloseTo(neutralBcdSurfaceLitres(26), 12);
      // v5 already tracked CNS and the mode, and keeps both.
      expect(result.saveGame.state.cnsPercent).toBe(moving().cnsPercent);
      expect(result.saveGame.diveMode).toBe("rec");
    });

    it("rejects a current save with invalid motion", () => {
      for (const [field, bad] of [["verticalVelocityMpm", "fast"], ["bcdGasSurfaceLiters", -1], ["bcdGasSurfaceLiters", undefined]] as const) {
        const v5 = JSON.parse(
          encodeSaveGame(createSaveGame(moving(), CONSERVATIVE_FACTORS, 1_735_689_600_000)),
        ) as { state: Record<string, unknown> };
        if (bad === undefined) delete v5.state[field];
        else v5.state[field] = bad;
        expect(decodeSaveGame(JSON.stringify(v5)).ok, `${field}=${String(bad)}`).toBe(false);
      }
    });

    it("carries legacy's verticalVelocity and bcdGasSurfaceLiters over", () => {
      const legacy = { ...legacyV2Save(), verticalVelocity: 6.5, bcdGasSurfaceLiters: 9.25 };
      const result = decodeSaveGame(JSON.stringify(legacy));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.saveGame.state.verticalVelocityMpm).toBe(6.5);
      expect(result.saveGame.state.bcdGasSurfaceLiters).toBe(9.25);
    });
  });

  // v7 adds the dive log (#199).
  describe("the dive log", () => {
    const logged = () =>
      freezeDiveState({
        ...createInitialDiveState(86),
        elapsedTimeS: seconds(600),
        depthM: 14 as DiveState["depthM"],
        maxDepthM: 31 as DiveState["maxDepthM"],
        log: {
          ...createEmptyDiveLog(),
          entries: [
            { kind: "fast-ascent", elapsedTimeS: seconds(312.5), value: 11.25 },
            { kind: "ceiling-violation", elapsedTimeS: seconds(480), value: 0.75 },
          ],
          ascentRateMpm: 10.5,
          fastAscentS: seconds(1.25),
          fastAscentPeakMpm: 11,
          minNdlMin: 4,
          ndlDroppedBelowFiveMinutes: true,
          depthTimeMS: 7200,
          submergedS: seconds(560),
          profile: [
            { elapsedTimeS: seconds(2), depthM: 3 as DiveState["depthM"], ceilingM: 0 as DiveState["depthM"] },
            { elapsedTimeS: seconds(4), depthM: 5 as DiveState["depthM"], ceilingM: 0 as DiveState["depthM"] },
          ],
          profileTimerS: seconds(1.5),
          lastCeilingM: 0 as DiveState["depthM"],
        },
      });

    it("round-trips in a current save", () => {
      const decoded = decodeSaveGame(encodeSaveGame(createSaveGame(logged(), CONSERVATIVE_FACTORS, 1_735_689_600_000)));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.saveGame.version).toBe(CURRENT_SAVE_GAME_VERSION);
      expect(decoded.saveGame.state.log).toEqual(logged().log);
    });

    it("keeps a v7 save's log, and starts its average and profile at zero", () => {
      const v7 = JSON.parse(
        encodeSaveGame(createSaveGame(logged(), CONSERVATIVE_FACTORS, 1_735_689_600_000)),
      ) as { version: number; state: { log: Record<string, unknown> } };
      v7.version = 7;
      for (const key of ["depthTimeMS", "submergedS", "profile", "profileTimerS", "lastCeilingM"]) delete v7.state.log[key];
      const result = decodeSaveGame(JSON.stringify(v7));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.migratedFrom).toBe("save-game-v7");
      expect(result.saveGame.state.log.entries).toEqual(logged().log.entries);
      expect(result.saveGame.state.log.minNdlMin).toBe(4);
      expect(result.saveGame.state.log.profile).toEqual([]);
      expect(result.saveGame.state.log.submergedS).toBe(0);
    });

    it("starts empty for a v6 save, which never recorded one", () => {
      const v6 = JSON.parse(
        encodeSaveGame(createSaveGame(logged(), CONSERVATIVE_FACTORS, 1_735_689_600_000)),
      ) as { version: number; state: Record<string, unknown> };
      v6.version = 6;
      delete v6.state.log;
      const result = decodeSaveGame(JSON.stringify(v6));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.migratedFrom).toBe("save-game-v6");
      expect(result.saveGame.state.log).toEqual(createEmptyDiveLog());
      // v6 already carried live motion, and keeps it.
      expect(result.saveGame.state.bcdGasSurfaceLiters).toBe(logged().bcdGasSurfaceLiters);
    });

    it("rejects a current save with an invalid log", () => {
      const invalid: [string, (log: Record<string, unknown>) => void][] = [
        ["no log", (log) => { for (const key of Object.keys(log)) delete log[key]; }],
        ["unknown entry kind", (log) => { (log.entries as Record<string, unknown>[])[0]!.kind = "shark"; }],
        ["entry after the dive time", (log) => { (log.entries as Record<string, unknown>[])[0]!.elapsedTimeS = 601; }],
        ["negative window", (log) => { log.fastAscentS = -1; }],
        ["NDL not a number", (log) => { log.minNdlMin = "4"; }],
        ["latch not a boolean", (log) => { log.ceilingViolationLatched = 1; }],
        // What the model cannot produce (#201 Codex round 1).
        ["a full window left unlatched", (log) => { log.fastAscentS = 2; }],
        ["a latch on a short window", (log) => { log.ceilingViolationLatched = true; }],
        ["a window under way without a peak", (log) => { log.fastAscentPeakMpm = 0; }],
        ["a peak with no window", (log) => { log.fastAscentS = 0; }],
        ["a fast ascent at 9 m/min", (log) => { (log.entries as Record<string, unknown>[])[0]!.value = 9; }],
        ["a violation within the tolerance", (log) => { (log.entries as Record<string, unknown>[])[1]!.value = 0.2; }],
        ["entries out of order", (log) => { (log.entries as Record<string, unknown>[])[1]!.elapsedTimeS = 300; }],
        ["a fractional NDL", (log) => { log.minNdlMin = 4.5; }],
        ["an NDL below five without the latch", (log) => { log.ndlDroppedBelowFiveMinutes = false; }],
        ["the latch with no NDL seen", (log) => { log.minNdlMin = null; }],
        ["the latch with an NDL of five or more", (log) => { log.minNdlMin = 5; }],
        ["a window under way at a slow rate", (log) => { log.ascentRateMpm = 4.5; }],
        ["a peak below the step's rate", (log) => { log.fastAscentPeakMpm = 10; }],
        ["a latched fast ascent with no entry", (log) => {
          log.fastAscentS = 2;
          log.fastAscentLatched = true;
          log.entries = (log.entries as Record<string, unknown>[]).filter((entry) => entry.kind !== "fast-ascent");
        }],
        ["a latched fast ascent whose entry is above its peak", (log) => {
          log.fastAscentS = 2;
          log.fastAscentLatched = true;
          (log.entries as Record<string, unknown>[])[0]!.value = 20;
        }],
        ["an open ceiling window with no ceiling over the diver", (log) => { log.ceilingViolationS = 1; }],
        // The motion record (#199 slice 2b).
        ["a sampler timer at the next sample", (log) => { log.profileTimerS = 2; }],
        ["profile samples out of order", (log) => { (log.profile as Record<string, unknown>[])[1]!.elapsedTimeS = 1; }],
        ["a profile sample after the dive time", (log) => { (log.profile as Record<string, unknown>[])[1]!.elapsedTimeS = 601; }],
        ["a profile sample deeper than the dive went", (log) => { (log.profile as Record<string, unknown>[])[1]!.depthM = 40; }],
        ["more time submerged than the dive lasted", (log) => { log.submergedS = 700; }],
        ["an average deeper than the deepest point", (log) => { log.depthTimeMS = 31 * 560 + 1; }],
        ["a negative last ceiling", (log) => { log.lastCeilingM = -1; }],
      ];
      for (const [what, corrupt] of invalid) {
        const save = JSON.parse(
          encodeSaveGame(createSaveGame(logged(), CONSERVATIVE_FACTORS, 1_735_689_600_000)),
        ) as { state: { log: Record<string, unknown> } };
        corrupt(save.state.log);
        expect(decodeSaveGame(JSON.stringify(save)).ok, what).toBe(false);
      }
    });

    it("carries legacy's diveEvents, minNdlSeen, ndlDroppedBelow5 and ascentRate over", () => {
      const legacy = {
        ...legacyV2Save(),
        diveEvents: [
          { t: 5.25, kind: "fastAscent", value: 10.5 },
          { t: 7, kind: "drillOutcome", value: { id: "freeflow", option: 1, correct: true } },
          { t: 9.5, kind: "ceilingViolation", value: 0.4 },
        ],
        minNdlSeen: 6,
        ndlDroppedBelow5: false,
        ascentRate: -3.25,
      };
      const result = decodeSaveGame(JSON.stringify(legacy));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.saveGame.state.log.entries).toEqual([
        { kind: "fast-ascent", elapsedTimeS: 315, value: 10.5 },
        { kind: "ceiling-violation", elapsedTimeS: 570, value: 0.4 },
      ]);
      expect(result.saveGame.state.log.minNdlMin).toBe(6);
      expect(result.saveGame.state.log.ndlDroppedBelowFiveMinutes).toBe(false);
      expect(result.saveGame.state.log.ascentRateMpm).toBe(-3.25);
    });

    it("checks an open ceiling window against the ceiling the saved tissues give", () => {
      // 3 bar of nitrogen in every compartment puts the ceiling near 18 m,
      // and the diver is at 14 m: a broken ceiling the window may record.
      const loaded = logged();
      const aboveTheCeiling = freezeDiveState({
        ...loaded,
        tissues: {
          nitrogenBar: loaded.tissues.nitrogenBar.map(() => bars(3)),
          heliumBar: loaded.tissues.heliumBar,
        },
        log: { ...loaded.log, ceilingViolationS: seconds(2), ceilingViolationLatched: true },
      });
      const decoded = decodeSaveGame(
        encodeSaveGame(createSaveGame(aboveTheCeiling, CONSERVATIVE_FACTORS, 1_735_689_600_000)),
      );
      expect(decoded.ok).toBe(true);
      // The same window over clean tissues has no ceiling to break.
      expect(() =>
        createSaveGame(freezeDiveState({ ...aboveTheCeiling, tissues: loaded.tissues }), CONSERVATIVE_FACTORS, 1_735_689_600_000),
      ).toThrow(TypeError);
      // And a latched window must have logged its entry.
      expect(() =>
        createSaveGame(
          freezeDiveState({
            ...aboveTheCeiling,
            log: {
              ...aboveTheCeiling.log,
              entries: aboveTheCeiling.log.entries.filter((entry) => entry.kind !== "ceiling-violation"),
            },
          }),
          CONSERVATIVE_FACTORS,
          1_735_689_600_000,
        ),
      ).toThrow(TypeError);
    });

    it("accepts a slow rate over an open window on a dive a rebreather failure ended", () => {
      // That step moves the ascent rate and nothing else (#201 Codex round 1).
      const loop = createCcrState(createGasMix(0.21, 0));
      const failed = freezeDiveState({
        ...createInitialDiveState(87, { ccr: loop }),
        elapsedTimeS: seconds(600),
        depthM: 14 as DiveState["depthM"],
        maxDepthM: 31 as DiveState["maxDepthM"],
        failure: { ...createInitialDiveState(87).failure, reason: "ccr-co2" },
        events: [{ type: "failure", elapsedTimeS: seconds(600), failureReason: "ccr-co2" }],
        log: { ...logged().log, ascentRateMpm: 4.5 },
      });
      const decoded = decodeSaveGame(encodeSaveGame(createSaveGame(failed, CONSERVATIVE_FACTORS, 1_735_689_600_000)));
      expect(decoded.ok).toBe(true);
    });

    it("keeps a legacy save whose lowest NDL is below five without the flag", () => {
      const older: Record<string, unknown> = { ...legacyV2Save(), minNdlSeen: 3 };
      delete older.ndlDroppedBelow5;
      const result = decodeSaveGame(JSON.stringify(older));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.saveGame.state.log.minNdlMin).toBe(3);
      expect(result.saveGame.state.log.ndlDroppedBelowFiveMinutes).toBe(true);
    });

    it("keeps the flag of a legacy save that predates minNdlSeen, at the 4 minutes it implies", () => {
      const older: Record<string, unknown> = { ...legacyV2Save(), ndlDroppedBelow5: true };
      delete older.minNdlSeen;
      const result = decodeSaveGame(JSON.stringify(older));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.saveGame.state.log.ndlDroppedBelowFiveMinutes).toBe(true);
      expect(result.saveGame.state.log.minNdlMin).toBe(4);
    });

    it("carries legacy's average depth sums and depth profile over", () => {
      const legacy = {
        ...legacyV2Save(),
        avgDepthAccum: 16_200,
        avgDepthSamples: 720,
        diveProfile: [
          { t: 0.0333, depth: 1.5, ceiling: 0 },
          { t: 0.0667, depth: 3.25, ceiling: 0 },
        ],
      };
      const result = decodeSaveGame(JSON.stringify(legacy));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const log = result.saveGame.state.log;
      expect(log.depthTimeMS).toBe(16_200);
      expect(log.submergedS).toBe(720);
      expect(log.profile.map((sample) => sample.depthM)).toEqual([1.5, 3.25]);
      expect(log.profile[1]?.elapsedTimeS).toBeCloseTo(4.002, 9);
      // Legacy restores its sampler timer and frameCalc at zero.
      expect(log.profileTimerS).toBe(0);
      expect(log.lastCeilingM).toBe(0);
    });

    it("reads legacy's null minNdlSeen as no NDL seen yet", () => {
      const result = decodeSaveGame(JSON.stringify({ ...legacyV2Save(), minNdlSeen: null }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.saveGame.state.log.minNdlMin).toBeNull();
    });
  });

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
      expect(decoded.saveGame.version).toBe(CURRENT_SAVE_GAME_VERSION);
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
      expect(result.saveGame.version).toBe(CURRENT_SAVE_GAME_VERSION);
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
