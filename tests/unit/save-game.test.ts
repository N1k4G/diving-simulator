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
import { bars, litres, metres, seconds } from "../../src/core/units";
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
import { DiveModel } from "../../src/core/dive-model";

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
      // Before v9 there was no safety stop: it is needed from the deepest point.
      safetyStop: { ...representativeState().safetyStop, needed: representativeState().maxDepthM > 11 },
      // Before v10 no fill was recorded: the current contents are the start,
      // except for the scrubber, which no setup screen sets and every dive
      // restarts.
      tanks: representativeState().tanks.map((tank) => ({ ...tank, startGasL: tank.gasRemainingL })),
      ccr: {
        ...representativeState().ccr!,
        oxygenCylinderStartPressureBar: representativeState().ccr!.oxygenCylinderPressureBar,
        diluentCylinderStartPressureBar: representativeState().ccr!.diluentCylinderPressureBar,
        scrubberTotalS: Math.max(180 * 60, representativeState().ccr!.scrubberRemainingS),
      },
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
        ["submerged time with no depth", (log) => { log.depthTimeMS = 0; }],
        ["an average shallower than 0.5 m", (log) => { log.depthTimeMS = 0.4 * 560; }],
        ["a depth sum with no submerged time", (log) => { log.submergedS = 0; }],
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

  // v9 adds the adaptive safety stop (#199).
  describe("the safety stop", () => {
    const atTheStop = () =>
      freezeDiveState({
        ...createInitialDiveState(88),
        elapsedTimeS: seconds(1800),
        depthM: 5 as DiveState["depthM"],
        maxDepthM: 24 as DiveState["maxDepthM"],
        safetyStop: {
          needed: true,
          countdownStarted: true,
          remainingS: seconds(120),
          paused: false,
          complete: false,
        },
      });

    it("round-trips in a current save", () => {
      const decoded = decodeSaveGame(encodeSaveGame(createSaveGame(atTheStop(), CONSERVATIVE_FACTORS, 1_735_689_600_000)));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.saveGame.version).toBe(CURRENT_SAVE_GAME_VERSION);
      expect(decoded.saveGame.state.safetyStop).toEqual(atTheStop().safetyStop);
    });

    it("derives the stop of a v8 save from its deepest point, with no countdown", () => {
      const v8 = JSON.parse(
        encodeSaveGame(createSaveGame(atTheStop(), CONSERVATIVE_FACTORS, 1_735_689_600_000)),
      ) as { version: number; state: Record<string, unknown> };
      v8.version = 8;
      delete v8.state.safetyStop;
      const result = decodeSaveGame(JSON.stringify(v8));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.migratedFrom).toBe("save-game-v8");
      expect(result.saveGame.state.safetyStop).toEqual({
        needed: true,
        countdownStarted: false,
        remainingS: 0,
        paused: false,
        complete: false,
      });
    });

    it("rejects a stop the model could not have left", () => {
      const invalid: [string, (stop: Record<string, unknown>, state: Record<string, unknown>) => void][] = [
        ["no stop", (stop) => { for (const key of Object.keys(stop)) delete stop[key]; }],
        ["needed on a shallow dive", (_stop, state) => { state.maxDepthM = 10; }],
        ["a countdown below 11 m", (_stop, state) => { state.depthM = 12; }],
        ["time left before the countdown starts", (stop) => { stop.countdownStarted = false; }],
        ["complete with time left", (stop) => { stop.complete = true; }],
        ["more time than the long stop", (stop) => { stop.remainingS = 301; }],
        ["paused inside the band", (stop) => { stop.paused = true; }],
        ["running outside the band", (_stop, state) => { state.depthM = 1.5; }],
        // #206 Codex round 1: a countdown that reaches zero completes on that
        // step, unpaused, and never holds more than the stop's length.
        ["a countdown at zero, not complete", (stop) => { stop.remainingS = 0; }],
        ["complete and paused", (stop, state) => {
          stop.remainingS = 0;
          stop.complete = true;
          stop.paused = true;
          state.depthM = 1.5;
        }],
        ["more than the short stop on a dive that needs only it", (stop) => { stop.remainingS = 181; }],
      ];
      for (const [what, corrupt] of invalid) {
        const save = JSON.parse(
          encodeSaveGame(createSaveGame(atTheStop(), CONSERVATIVE_FACTORS, 1_735_689_600_000)),
        ) as { state: Record<string, unknown> & { safetyStop: Record<string, unknown> } };
        corrupt(save.state.safetyStop, save.state);
        expect(decodeSaveGame(JSON.stringify(save)).ok, what).toBe(false);
      }
    });

    it("holds a dive a rebreather failure ended to every rule but the two that follow the depth", () => {
      // The failure step keeps the step before's stop while the depth moves
      // on, so a running countdown may now sit outside the band or below
      // 11 m; nothing else about the stop changes on that step.
      const failed = (stop: Partial<DiveState["safetyStop"]>, depthM: number) => {
        const state = atTheStop();
        return JSON.stringify({
          ...JSON.parse(encodeSaveGame(createSaveGame(state, CONSERVATIVE_FACTORS, 1))),
          state: {
            ...JSON.parse(encodeSaveGame(createSaveGame(state, CONSERVATIVE_FACTORS, 1))).state,
            depthM,
            failure: { ...state.failure, reason: "ccr-co2" },
            events: [{ type: "failure", elapsedTimeS: state.elapsedTimeS, failureReason: "ccr-co2" }],
            safetyStop: { ...state.safetyStop, ...stop },
          },
        });
      };
      expect(decodeSaveGame(failed({}, 12)).ok, "a countdown the depth left").toBe(true);
      expect(decodeSaveGame(failed({}, 1.5)).ok, "a running countdown outside the band").toBe(true);
      const impossible: [string, Partial<DiveState["safetyStop"]>][] = [
        ["complete and paused", { remainingS: seconds(0), complete: true, paused: true }],
        ["a countdown at zero, not complete", { remainingS: seconds(0) }],
        ["more than the short stop", { remainingS: seconds(250) }],
        ["time left before the countdown starts", { countdownStarted: false }],
      ];
      for (const [what, stop] of impossible) {
        expect(decodeSaveGame(failed(stop, 5)).ok, what).toBe(false);
      }
    });

    it("allows the long stop's time on a dive that needs it", () => {
      const deep = (maxDepthM: number, below5: boolean) => {
        const state = atTheStop();
        return freezeDiveState({
          ...state,
          maxDepthM: maxDepthM as DiveState["maxDepthM"],
          safetyStop: { ...state.safetyStop, remainingS: seconds(300) },
          log: { ...state.log, ndlDroppedBelowFiveMinutes: below5, minNdlMin: below5 ? 4 : null },
        });
      };
      for (const [maxDepthM, below5] of [[31, false], [24, true]] as const) {
        const decoded = decodeSaveGame(encodeSaveGame(createSaveGame(deep(maxDepthM, below5), CONSERVATIVE_FACTORS, 1)));
        expect(decoded.ok, `${maxDepthM} m, below five ${below5}`).toBe(true);
      }
    });

    it("derives legacy's stop when a field is missing or malformed, or it is not needed past 11 m", () => {
      // legacyV2Save() dives to 31 m.
      const fields = {
        safetyStopNeeded: true,
        safetyStopCountdownStarted: false,
        safetyStopRemaining: 0,
        safetyStopPaused: false,
        safetyStopComplete: false,
      };
      const derived = { needed: true, countdownStarted: false, remainingS: 0, paused: false, complete: false };
      const cases: [string, Record<string, unknown>][] = [
        ["not needed past 11 m", { ...fields, safetyStopNeeded: false }],
        ["no fields at all", {}],
        ["a missing field", { ...fields, safetyStopPaused: undefined }],
        ["a malformed field", { ...fields, safetyStopComplete: "no" }],
        ["a negative time left", { ...fields, safetyStopRemaining: -1 }],
      ];
      for (const [what, stop] of cases) {
        const result = decodeSaveGame(JSON.stringify({ ...legacyV2Save(), ...stop }));
        expect(result.ok, what).toBe(true);
        if (!result.ok) return;
        expect(result.saveGame.state.safetyStop, what).toEqual(derived);
      }
      // Not needed is a record legacy can save on a dive that stayed above 11 m.
      const shallow = decodeSaveGame(JSON.stringify({
        ...legacyV2Save(),
        ...fields,
        safetyStopNeeded: false,
        depth: 9,
        maxDepth: 10,
      }));
      expect(shallow.ok).toBe(true);
      if (!shallow.ok) return;
      expect(shallow.saveGame.state.safetyStop.needed).toBe(false);
    });

    it("derives legacy's stop when its countdown is at zero but not complete", () => {
      const contradictory = decodeSaveGame(JSON.stringify({
        ...legacyV2Save(),
        depth: 5,
        safetyStopNeeded: true,
        safetyStopCountdownStarted: true,
        safetyStopRemaining: 0,
        safetyStopPaused: false,
        safetyStopComplete: false,
      }));
      expect(contradictory.ok).toBe(true);
      if (!contradictory.ok) return;
      expect(contradictory.saveGame.state.safetyStop).toEqual({
        needed: true,
        countdownStarted: false,
        remainingS: 0,
        paused: false,
        complete: false,
      });
    });

    it("carries legacy's safety stop over, and derives one when its fields disagree", () => {
      const carried = decodeSaveGame(JSON.stringify({
        ...legacyV2Save(),
        depth: 5,
        safetyStopNeeded: true,
        safetyStopCountdownStarted: true,
        safetyStopRemaining: 95,
        safetyStopPaused: false,
        safetyStopComplete: false,
      }));
      expect(carried.ok).toBe(true);
      if (!carried.ok) return;
      expect(carried.saveGame.state.safetyStop).toEqual({
        needed: true,
        countdownStarted: true,
        remainingS: 95,
        paused: false,
        complete: false,
      });
      const disagreeing = decodeSaveGame(JSON.stringify({
        ...legacyV2Save(),
        safetyStopNeeded: true,
        safetyStopCountdownStarted: true,
        safetyStopRemaining: 95,
      }));
      expect(disagreeing.ok).toBe(true);
      if (!disagreeing.ok) return;
      // Legacy's fixture diver is at 24 m, below 11 m, where a countdown cannot run.
      expect(disagreeing.saveGame.state.safetyStop.countdownStarted).toBe(false);
      expect(disagreeing.saveGame.state.safetyStop.needed).toBe(true);
    });
  });

  // v10 adds the start of the dive, for gas used (#199).
  describe("the start of the dive", () => {
    const halfway = () => {
      const base = createInitialDiveState(89, {
        ccr: createCcrState(createGasMix(0.21, 0), { oxygenCylinderPressureBar: bars(200) }),
      });
      return freezeDiveState({
        ...base,
        elapsedTimeS: seconds(900),
        tanks: base.tanks.map((tank) => ({ ...tank, gasRemainingL: litres(1800) })),
        ccr: {
          ...base.ccr!,
          oxygenCylinderPressureBar: bars(170),
          diluentCylinderPressureBar: bars(190),
          scrubberRemainingS: seconds(165 * 60),
        },
      });
    };

    it("round-trips in a current save", () => {
      const decoded = decodeSaveGame(encodeSaveGame(createSaveGame(halfway(), CONSERVATIVE_FACTORS, 1_735_689_600_000)));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.saveGame.state.tanks[0]?.startGasL).toBe(2400);
      expect(decoded.saveGame.state.ccr?.oxygenCylinderStartPressureBar).toBe(200);
      expect(decoded.saveGame.state.ccr?.scrubberTotalS).toBe(180 * 60);
    });

    it("starts a v9 save from its current contents, and the scrubber from its default", () => {
      const v9 = JSON.parse(
        encodeSaveGame(createSaveGame(halfway(), CONSERVATIVE_FACTORS, 1_735_689_600_000)),
      ) as { version: number; state: { tanks: Record<string, unknown>[]; ccr: Record<string, unknown> } };
      v9.version = 9;
      for (const tank of v9.state.tanks) delete tank.startGasL;
      delete v9.state.ccr.oxygenCylinderStartPressureBar;
      delete v9.state.ccr.diluentCylinderStartPressureBar;
      delete v9.state.ccr.scrubberTotalS;
      const result = decodeSaveGame(JSON.stringify(v9));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.migratedFrom).toBe("save-game-v9");
      expect(result.saveGame.state.tanks[0]?.startGasL).toBe(1800);
      expect(result.saveGame.state.ccr?.oxygenCylinderStartPressureBar).toBe(170);
      // Legacy shares the diluent between one session's dives, so only what
      // is left is known; the scrubber restarts at 180 minutes every dive
      // (#211 pre-review).
      expect(result.saveGame.state.ccr?.diluentCylinderStartPressureBar).toBe(190);
      expect(result.saveGame.state.ccr?.scrubberTotalS).toBe(180 * 60);
    });

    it("rejects a start below what is left", () => {
      const invalid: [string, (state: { tanks: Record<string, unknown>[]; ccr: Record<string, unknown> }) => void][] = [
        ["a fill below the gas left", (state) => { state.tanks[0]!.startGasL = 1000; }],
        ["no fill", (state) => { delete state.tanks[0]!.startGasL; }],
        ["an O2 start below the O2 left", (state) => { state.ccr.oxygenCylinderStartPressureBar = 150; }],
        ["a diluent start below the diluent left", (state) => { state.ccr.diluentCylinderStartPressureBar = 150; }],
        ["a scrubber total below the time left", (state) => { state.ccr.scrubberTotalS = 60; }],
        // 900 s into the dive: the scrubber cannot have run for 1000 s.
        ["a scrubber used for longer than the dive", (state) => { state.ccr.scrubberRemainingS = 9800; }],
      ];
      for (const [what, corrupt] of invalid) {
        const save = JSON.parse(
          encodeSaveGame(createSaveGame(halfway(), CONSERVATIVE_FACTORS, 1_735_689_600_000)),
        ) as { state: { tanks: Record<string, unknown>[]; ccr: Record<string, unknown> } };
        corrupt(save.state);
        expect(decodeSaveGame(JSON.stringify(save)).ok, what).toBe(false);
      }
    });

    it("loads a v9 save from before the first step whose diluent is below 200 bar", () => {
      // A second legacy dive in one session starts on the first dive's diluent.
      const fresh = createInitialDiveState(91, {
        ccr: createCcrState(createGasMix(0.21, 0), { diluentCylinderPressureBar: bars(185) }),
      });
      const v9 = JSON.parse(
        encodeSaveGame(createSaveGame(fresh, CONSERVATIVE_FACTORS, 1_735_689_600_000)),
      ) as { version: number; state: { ccr: Record<string, unknown> } };
      v9.version = 9;
      delete v9.state.ccr.oxygenCylinderStartPressureBar;
      delete v9.state.ccr.diluentCylinderStartPressureBar;
      delete v9.state.ccr.scrubberTotalS;
      const result = decodeSaveGame(JSON.stringify(v9));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.saveGame.state.ccr?.diluentCylinderStartPressureBar).toBe(185);
    });

    it("rejects anything drawn before the dive's first step", () => {
      const atStart = (corrupt: (state: { elapsedTimeS: number; tanks: Record<string, unknown>[]; ccr: Record<string, unknown> }) => void) => {
        const save = JSON.parse(
          encodeSaveGame(createSaveGame(halfway(), CONSERVATIVE_FACTORS, 1_735_689_600_000)),
        ) as { state: { elapsedTimeS: number; tanks: Record<string, unknown>[]; ccr: Record<string, unknown> } };
        save.state.elapsedTimeS = 0;
        save.state.ccr.scrubberRemainingS = save.state.ccr.scrubberTotalS;
        save.state.ccr.oxygenCylinderPressureBar = save.state.ccr.oxygenCylinderStartPressureBar;
        save.state.ccr.diluentCylinderPressureBar = save.state.ccr.diluentCylinderStartPressureBar;
        for (const tank of save.state.tanks) tank.gasRemainingL = tank.startGasL;
        corrupt(save.state);
        return JSON.stringify(save);
      };
      expect(decodeSaveGame(atStart(() => {})).ok, "nothing drawn").toBe(true);
      const drawn: [string, Parameters<typeof atStart>[0]][] = [
        ["cylinder gas", (state) => { state.tanks[0]!.gasRemainingL = 2300; }],
        ["oxygen", (state) => { state.ccr.oxygenCylinderPressureBar = 190; }],
        ["diluent", (state) => { state.ccr.diluentCylinderPressureBar = 190; }],
        ["scrubber", (state) => { state.ccr.scrubberRemainingS = 10_000; }],
      ];
      for (const [what, corrupt] of drawn) {
        expect(decodeSaveGame(atStart(corrupt)).ok, what).toBe(false);
      }
    });

    it("carries legacy's scrubber total only when the dive is long enough to have used the difference", () => {
      // The fixture's loop has 150 minutes left.
      const legacy = (diveTime: number) => {
        const save = legacyV2Save();
        return JSON.stringify({ ...save, diveTime, ccrState: { ...(save.ccrState as Record<string, unknown>), scrubberTotal: 180 } });
      };
      const long = decodeSaveGame(legacy(45));
      expect(long.ok).toBe(true);
      if (!long.ok) return;
      expect(long.saveGame.state.ccr?.scrubberTotalS).toBe(180 * 60);
      const short = decodeSaveGame(legacy(10));
      expect(short.ok).toBe(true);
      if (!short.ok) return;
      expect(short.saveGame.state.ccr?.scrubberTotalS).toBe(150 * 60);
    });

    it("carries legacy's totalGas over, and the current contents when it is unusable", () => {
      const legacy = legacyV2Save();
      const tanks = legacy.tanks as Record<string, unknown>[];
      const carried = decodeSaveGame(JSON.stringify({
        ...legacy,
        tanks: tanks.map((tank) => ({ ...tank, totalGas: (tank.gasRemaining as number) + 300 })),
      }));
      expect(carried.ok).toBe(true);
      if (!carried.ok) return;
      expect(carried.saveGame.state.tanks[0]?.startGasL).toBe((tanks[0]!.gasRemaining as number) + 300);
      const unusable = decodeSaveGame(JSON.stringify({
        ...legacy,
        tanks: tanks.map((tank) => ({ ...tank, totalGas: 1 })),
      }));
      expect(unusable.ok).toBe(true);
      if (!unusable.ok) return;
      expect(unusable.saveGame.state.tanks[0]?.startGasL).toBe(tanks[0]!.gasRemaining);
    });
  });

  // v11 adds the decompression-sickness timer (#199).
  describe("the decompression-sickness timer", () => {
    const aboveTheStop = () => {
      const base = createInitialDiveState(97);
      return freezeDiveState({
        ...base,
        elapsedTimeS: seconds(1500),
        failure: { ...base.failure, dcsViolationS: seconds(42.5) },
      });
    };
    const encoded = () =>
      JSON.parse(encodeSaveGame(createSaveGame(aboveTheStop(), CONSERVATIVE_FACTORS, 1_735_689_600_000))) as {
        version: number;
        state: { failure: Record<string, unknown> };
      };

    it("round-trips in a current save", () => {
      const decoded = decodeSaveGame(JSON.stringify(encoded()));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.saveGame.state.failure.dcsViolationS).toBe(42.5);
    });

    it("resumes a v10 save at zero, which never ran it", () => {
      const v10 = encoded();
      v10.version = 10;
      delete v10.state.failure.dcsViolationS;
      const result = decodeSaveGame(JSON.stringify(v10));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.migratedFrom).toBe("save-game-v10");
      expect(result.saveGame.state.failure.dcsViolationS).toBe(0);
    });

    it("rejects a current save without a valid timer", () => {
      for (const value of [undefined, -1, Number.NaN, "42"]) {
        const save = encoded();
        save.state.failure.dcsViolationS = value;
        expect(decodeSaveGame(JSON.stringify(save)).ok, String(value)).toBe(false);
      }
    });

    type Failed = { version: number; state: { failure: Record<string, unknown>; events: unknown[]; elapsedTimeS: number } };
    const endedIn = (reason: string, dcsViolationS: number): Failed => {
      const save = encoded() as unknown as Failed;
      save.state.failure.reason = reason;
      save.state.failure.dcsViolationS = dcsViolationS;
      save.state.events.push({ type: "failure", elapsedTimeS: save.state.elapsedTimeS, failureReason: reason });
      return save;
    };

    it("accepts a save of a dive the DCS timer ended", () => {
      // Tissues loaded to a 27 m ceiling: the diver is above its 30 m stop.
      const save = endedIn("decompression-sickness", 60) as Failed & { state: { tissues: { nitrogenBar: number[]; heliumBar: number[] } } };
      save.state.tissues.nitrogenBar = save.state.tissues.nitrogenBar.map(() => 4);
      save.state.tissues.heliumBar = save.state.tissues.heliumBar.map(() => 0);
      const result = decodeSaveGame(JSON.stringify(save));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.saveGame.state.failure.reason).toBe("decompression-sickness");
    });

    /** The model's own end: trimix 21/35 at 45 m for 20 min, then up. */
    const surfacedWithDcs = () => {
      const model = new DiveModel(
        createInitialDiveState(113, { tanks: [createTankState(createGasMix(0.21, 0.35), 24, 200)] }),
      );
      model.advance({ depthM: metres(45) }, seconds(20 * 60));
      model.advance({ depthM: metres(0) }, seconds(1));
      return model.snapshot;
    };

    it("accepts a save of a dive that surfaced with a ceiling deeper than 3 m", () => {
      const state = surfacedWithDcs();
      expect(state.failure.reason).toBe("decompression-sickness");
      expect(state.failure.dcsViolationS).toBe(1);
      const decoded = decodeSaveGame(encodeSaveGame(createSaveGame(state, CONSERVATIVE_FACTORS, 1)));
      expect(decoded.ok).toBe(true);
    });

    it("rejects a timer the model could not have left", () => {
      const invalid: [string, Failed][] = [
        ["a timer longer than the dive", (() => {
          // Short of 60, so only the bound by the dive's time can catch it.
          const save = encoded() as unknown as Failed;
          save.state.elapsedTimeS = 10;
          save.state.failure.dcsViolationS = 20;
          return save;
        })()],
        ["a dive going on with the timer at 60", (() => {
          const save = encoded() as unknown as Failed;
          save.state.failure.dcsViolationS = 60;
          return save;
        })()],
        ["decompression sickness below the surface with the timer short of 60", endedIn("decompression-sickness", 42.5)],
        ["hypoxia with the timer at 60, which DCS would have ended first", endedIn("hypoxia", 60)],
        // The step that takes the timer to 60 counted it up: a ceiling, and
        // the diver above its stop. This dive has no ceiling.
        ["out of gas with the timer at 60 and no ceiling", endedIn("out-of-gas", 60)],
        // That surfacing ends the dive on the step: none goes on from it.
        ["a dive going on at the surface with a ceiling deeper than 3 m", (() => {
          const save = JSON.parse(encodeSaveGame(createSaveGame(surfacedWithDcs(), CONSERVATIVE_FACTORS, 1))) as Failed;
          save.state.failure.reason = null;
          save.state.events = save.state.events.filter((event) => (event as { type: string }).type !== "failure");
          return save;
        })()],
        ["the surfacing end with the timer at zero", (() => {
          const save = JSON.parse(encodeSaveGame(createSaveGame(surfacedWithDcs(), CONSERVATIVE_FACTORS, 1))) as Failed;
          save.state.failure.dcsViolationS = 0;
          return save;
        })()],
        ["a rebreather failure with the timer at 60", endedIn("ccr-co2", 60)],
      ];
      for (const [what, save] of invalid) {
        expect(decodeSaveGame(JSON.stringify(save)).ok, what).toBe(false);
      }
      // Out of gas and oxygen toxicity are checked before the timer, so they
      // can end its 60th second, on tissues that give it a ceiling above
      // the diver's stop.
      for (const reason of ["out-of-gas", "oxygen-toxicity", "decompression-sickness"]) {
        const save = endedIn(reason, 60) as Failed & { state: { tissues: { nitrogenBar: number[]; heliumBar: number[] }; depthM: number } };
        save.state.tissues.nitrogenBar = save.state.tissues.nitrogenBar.map(() => 4);
        save.state.tissues.heliumBar = save.state.tissues.heliumBar.map(() => 0);
        expect(decodeSaveGame(JSON.stringify(save)).ok, reason).toBe(true);
      }
    });

    it("rejects a pre-v11 save that ended in decompression sickness, which no such client could write", () => {
      // A surfacing end, which the v11 rules alone would accept with the
      // timer at zero.
      const v10 = JSON.parse(encodeSaveGame(createSaveGame(surfacedWithDcs(), CONSERVATIVE_FACTORS, 1))) as Failed;
      v10.version = 10;
      delete v10.state.failure.dcsViolationS;
      expect(decodeSaveGame(JSON.stringify(v10)).ok).toBe(false);
    });

    it("carries legacy's dcsViolationTime over, and resumes a save without one at zero", () => {
      const carried = decodeSaveGame(JSON.stringify({ ...legacyV2Save(), dcsViolationTime: 17.25 }));
      expect(carried.ok).toBe(true);
      if (!carried.ok) return;
      expect(carried.saveGame.state.failure.dcsViolationS).toBe(17.25);
      const without = legacyV2Save();
      delete without.dcsViolationTime;
      const missing = decodeSaveGame(JSON.stringify(without));
      expect(missing.ok).toBe(true);
      if (!missing.ok) return;
      expect(missing.saveGame.state.failure.dcsViolationS).toBe(0);
    });
  });

  // v12 adds the end of a dive at the surface (#199).
  describe("a dive ended at the surface", () => {
    type Encoded = {
      version: number;
      state: {
        completed: unknown;
        depthM: number;
        failure: Record<string, unknown>;
        events: unknown[];
        safetyStop: Record<string, unknown>;
        log: { entries: Record<string, unknown>[] };
      };
    };
    /** Ten minutes at 12 m on air, then up without the safety stop. */
    // Built once: the state is frozen, and each test encodes its own copy.
    let surfaced: DiveState | undefined;
    const surfacedWithoutStop = () => {
      if (!surfaced) {
        const model = new DiveModel(createInitialDiveState(101));
        model.advance({ depthM: metres(12) }, seconds(600));
        model.advance({ depthM: metres(0) }, seconds(1));
        surfaced = model.snapshot;
      }
      return surfaced;
    };
    const encode = (state: DiveState) =>
      JSON.parse(encodeSaveGame(createSaveGame(state, CONSERVATIVE_FACTORS, 1_735_689_600_000))) as Encoded;

    it("round-trips in a current save, with its skipped safety stop", () => {
      const state = surfacedWithoutStop();
      expect(state.completed).toBe(true);
      const decoded = decodeSaveGame(JSON.stringify(encode(state)));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.saveGame.state.completed).toBe(true);
      expect(decoded.saveGame.state.log.entries.at(-1)?.kind).toBe("safety-stop-skipped");
    });

    it("resumes a v11 save not completed", () => {
      const v11 = encode(createInitialDiveState(103));
      v11.version = 11;
      delete v11.state.completed;
      const result = decodeSaveGame(JSON.stringify(v11));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.migratedFrom).toBe("save-game-v11");
      expect(result.saveGame.state.completed).toBe(false);
    });

    it("rejects an end the model could not have reached", () => {
      const invalid: [string, (save: Encoded) => void][] = [
        ["no flag", (save) => { delete save.state.completed; }],
        ["a flag that is not a boolean", (save) => { save.state.completed = "yes"; }],
        ["a failed dive", (save) => {
          save.state.failure.reason = "hypoxia";
          save.state.events.push({ type: "failure", elapsedTimeS: 0, failureReason: "hypoxia" });
        }],
        ["below the surface", (save) => { save.state.depthM = 1; }],
        ["no skipped stop for a stop not done", (save) => { save.state.log.entries.pop(); }],
        ["a skipped stop for a stop done", (save) => { save.state.safetyStop.complete = true; }],
        ["a skipped stop with a value", (save) => { save.state.log.entries.at(-1)!.value = 1; }],
        ["a skipped stop before the end", (save) => { save.state.log.entries.at(-1)!.elapsedTimeS = 1; }],
      ];
      for (const [what, corrupt] of invalid) {
        const save = encode(surfacedWithoutStop());
        corrupt(save);
        expect(decodeSaveGame(JSON.stringify(save)).ok, what).toBe(false);
      }
    });

    it("rejects a skipped safety stop on a dive still going", () => {
      const going = encode(surfacedWithoutStop());
      going.state.completed = false;
      expect(decodeSaveGame(JSON.stringify(going)).ok).toBe(false);
    });

    it("resumes a legacy save not completed", () => {
      const result = decodeSaveGame(JSON.stringify(legacyV2Save()));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.saveGame.state.completed).toBe(false);
    });
  });

  // v13 adds the rule of thirds (#199).
  describe("the rule of thirds", () => {
    type Encoded = {
      version: number;
      state: { thirds: Record<string, unknown>; tanks: { gasRemainingL: number }[] };
    };
    /** Twenty minutes in under an overhead, a 2400 L plan with 1500 L left: past the turn. */
    const underway = () => {
      const base = createInitialDiveState(107);
      return freezeDiveState({
        ...base,
        elapsedTimeS: seconds(1200),
        tanks: base.tanks.map((tank) => ({ ...tank, gasRemainingL: litres(1500) })),
        thirds: { startingGasL: litres(2400), turnWarned: true, reserveHit: false },
      });
    };
    const encode = (state: DiveState) =>
      JSON.parse(encodeSaveGame(createSaveGame(state, CONSERVATIVE_FACTORS, 1_735_689_600_000))) as Encoded;

    it("round-trips in a current save", () => {
      const decoded = decodeSaveGame(JSON.stringify(encode(underway())));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.saveGame.state.thirds).toEqual({ startingGasL: 2400, turnWarned: true, reserveHit: false });
    });

    it("resumes a v12 save with no plan and no reserve reached", () => {
      const v12 = encode(underway());
      v12.version = 12;
      delete (v12.state as Record<string, unknown>).thirds;
      const result = decodeSaveGame(JSON.stringify(v12));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.migratedFrom).toBe("save-game-v12");
      expect(result.saveGame.state.thirds).toEqual({ startingGasL: 0, turnWarned: false, reserveHit: false });
    });

    it("rejects a plan the model could not have left", () => {
      const invalid: [string, (save: Encoded) => void][] = [
        ["no plan state", (save) => { delete (save.state as Record<string, unknown>).thirds; }],
        ["a plan smaller than the gas carried", (save) => { save.state.thirds.startingGasL = 1000; }],
        ["a turn with no plan open", (save) => { save.state.thirds.startingGasL = 0; }],
        ["a negative plan", (save) => { save.state.thirds.startingGasL = -1; }],
        ["a reserve latch that is not a boolean", (save) => { save.state.thirds.reserveHit = 1; }],
      ];
      for (const [what, corrupt] of invalid) {
        const save = encode(underway());
        corrupt(save);
        expect(decodeSaveGame(JSON.stringify(save)).ok, what).toBe(false);
      }
    });

    it("carries legacy's reserve latch over, with no plan, as legacy restores it", () => {
      const carried = decodeSaveGame(JSON.stringify({ ...legacyV2Save(), thirdsReserveHitThisDive: true }));
      expect(carried.ok).toBe(true);
      if (!carried.ok) return;
      expect(carried.saveGame.state.thirds).toEqual({ startingGasL: 0, turnWarned: false, reserveHit: true });
      const without = decodeSaveGame(JSON.stringify(legacyV2Save()));
      expect(without.ok).toBe(true);
      if (!without.ok) return;
      expect(without.saveGame.state.thirds.reserveHit).toBe(false);
    });
  });

  // v14 adds the barotrauma timer (#189).
  describe("the barotrauma timer", () => {
    type Encoded = { version: number; state: { failure: Record<string, unknown> } };
    const rising = () => {
      const base = createInitialDiveState(109);
      return freezeDiveState({
        ...base,
        elapsedTimeS: seconds(600),
        failure: { ...base.failure, barotraumaS: seconds(6.5) },
      });
    };
    const encode = (state: DiveState) =>
      JSON.parse(encodeSaveGame(createSaveGame(state, CONSERVATIVE_FACTORS, 1_735_689_600_000))) as Encoded;

    it("round-trips in a current save", () => {
      const decoded = decodeSaveGame(JSON.stringify(encode(rising())));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.saveGame.state.failure.barotraumaS).toBe(6.5);
    });

    it("resumes a v13 save at zero, which never ran it, whatever the payload carries", () => {
      for (const carried of [undefined, 6.5]) {
        const v13 = encode(rising());
        v13.version = 13;
        if (carried === undefined) delete v13.state.failure.barotraumaS;
        const result = decodeSaveGame(JSON.stringify(v13));
        expect(result.ok, String(carried)).toBe(true);
        if (!result.ok) return;
        expect(result.migratedFrom).toBe("save-game-v13");
        expect(result.saveGame.state.failure.barotraumaS, String(carried)).toBe(0);
      }
    });

    it("rejects a current save without a valid timer", () => {
      for (const value of [undefined, -1, Number.NaN, "6.5"]) {
        const save = encode(rising());
        save.state.failure.barotraumaS = value;
        expect(decodeSaveGame(JSON.stringify(save)).ok, String(value)).toBe(false);
      }
    });

    it("accepts the save of a dive the model ended in barotrauma", () => {
      // W held from neutral at 30 m in 60 Hz frames until the timer ends it.
      const start = createInitialDiveState(113);
      const model = new DiveModel(
        freezeDiveState({ ...start, depthM: metres(30), maxDepthM: metres(30), bcdGasSurfaceLiters: neutralBcdSurfaceLitres(30) }),
      );
      for (let frame = 0; frame < 2000 && model.snapshot.failure.reason === null; frame++) {
        model.advanceWithBuoyancy({ ceilingM: 0, floorM: 100 }, seconds(0.05), { inflate: true, vent: false });
      }
      const failed = model.snapshot;
      expect(failed.failure.reason).toBe("pulmonary-barotrauma");
      const decoded = decodeSaveGame(encodeSaveGame(createSaveGame(failed, CONSERVATIVE_FACTORS, 1)));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.saveGame.state.failure).toEqual(failed.failure);
    });

    it("carries legacy's barotraumaTime over, and resumes a save without one at zero", () => {
      const carried = decodeSaveGame(JSON.stringify({ ...legacyV2Save(), barotraumaTime: 4.25 }));
      expect(carried.ok).toBe(true);
      if (!carried.ok) return;
      expect(carried.saveGame.state.failure.barotraumaS).toBe(4.25);
      const missing = decodeSaveGame(JSON.stringify(legacyV2Save()));
      expect(missing.ok).toBe(true);
      if (!missing.ok) return;
      expect(missing.saveGame.state.failure.barotraumaS).toBe(0);
    });
  });

  // v15 adds nitrogen narcosis (#189).
  describe("nitrogen narcosis", () => {
    type Encoded = { version: number; state: Record<string, unknown> & { failure: Record<string, unknown> } };
    const deep = () => {
      const base = createInitialDiveState(127);
      return freezeDiveState({
        ...base,
        elapsedTimeS: seconds(600),
        narcosisIndex: 0.96,
        failure: { ...base.failure, narcosisKoS: seconds(12) },
      });
    };
    const encode = (state: DiveState) =>
      JSON.parse(encodeSaveGame(createSaveGame(state, CONSERVATIVE_FACTORS, 1_735_689_600_000))) as Encoded;

    it("round-trips in a current save", () => {
      const decoded = decodeSaveGame(JSON.stringify(encode(deep())));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.saveGame.state.narcosisIndex).toBe(0.96);
      expect(decoded.saveGame.state.failure.narcosisKoS).toBe(12);
    });

    it("resumes a v14 save at zero, which never tracked it, whatever the payload carries", () => {
      for (const carried of [false, true]) {
        const v14 = encode(deep());
        v14.version = 14;
        if (!carried) {
          delete v14.state.narcosisIndex;
          delete v14.state.failure.narcosisKoS;
        }
        const result = decodeSaveGame(JSON.stringify(v14));
        expect(result.ok, String(carried)).toBe(true);
        if (!result.ok) return;
        expect(result.migratedFrom).toBe("save-game-v14");
        expect(result.saveGame.state.narcosisIndex, String(carried)).toBe(0);
        expect(result.saveGame.state.failure.narcosisKoS, String(carried)).toBe(0);
      }
    });

    it("rejects a current save without a valid index or KO timer", () => {
      for (const value of [undefined, -0.1, 1.1, Number.NaN, "0.5"]) {
        const save = encode(deep());
        save.state.narcosisIndex = value;
        expect(decodeSaveGame(JSON.stringify(save)).ok, `index ${String(value)}`).toBe(false);
      }
      for (const value of [undefined, -1, Number.NaN, "12"]) {
        const save = encode(deep());
        save.state.failure.narcosisKoS = value;
        expect(decodeSaveGame(JSON.stringify(save)).ok, `KO timer ${String(value)}`).toBe(false);
      }
    });

    it("accepts the save of a dive the model ended in narcosis", () => {
      // Air at 65 m, in one-second steps, until the KO timer ends it.
      const model = new DiveModel(createInitialDiveState(131));
      model.advance({ depthM: metres(65) }, seconds(15 * 60));
      const failed = model.snapshot;
      expect(failed.failure.reason).toBe("nitrogen-narcosis");
      const decoded = decodeSaveGame(encodeSaveGame(createSaveGame(failed, CONSERVATIVE_FACTORS, 1)));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.saveGame.state.narcosisIndex).toBe(failed.narcosisIndex);
      expect(decoded.saveGame.state.failure).toEqual(failed.failure);
    });

    it("carries legacy's narcosisIndex and narcosisKOTime over, and resumes a save without them at zero", () => {
      const carried = decodeSaveGame(JSON.stringify({ ...legacyV2Save(), narcosisIndex: 0.42, narcosisKOTime: 3.5 }));
      expect(carried.ok).toBe(true);
      if (!carried.ok) return;
      expect(carried.saveGame.state.narcosisIndex).toBe(0.42);
      expect(carried.saveGame.state.failure.narcosisKoS).toBe(3.5);
      const missing = decodeSaveGame(JSON.stringify(legacyV2Save()));
      expect(missing.ok).toBe(true);
      if (!missing.ok) return;
      expect(missing.saveGame.state.narcosisIndex).toBe(0);
      expect(missing.saveGame.state.failure.narcosisKoS).toBe(0);
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
      // 400 s used in a 420 s dive: never more than the dive has run.
      scrubberRemainingS: seconds(10_400),
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
