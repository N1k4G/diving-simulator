import { describe, expect, it } from "vitest";

import {
  DRILLS,
  DRILL_BREATH_HOLD_S,
  DRILL_DEBRIEF_S,
  DRILL_FREEFLOW_S,
  DRILL_MAX_DIVE_TIME_S,
  DRILL_MIN_DEPTH_M,
  DRILL_MIN_DIVE_TIME_S,
  NO_DRILL,
  applyDrillEffect,
  dismissDrillDebrief,
  drillTriggerChance,
  isDrillEligible,
  pickDrill,
  resolveDrillOption,
  startDrill,
  tickDrillDebrief,
  visibleDrillOptions,
  type DrillId,
  type DrillState,
} from "../../src/core/drills";
import { createSaveGame, decodeSaveGame, encodeSaveGame } from "../../src/save/save-game";
import { DRILL_MESSAGES } from "../../src/app/drill-overlay";
import { translate, type MessageKey } from "../../src/app/i18n/catalog";
import { DRILL_FREEFLOW_MULTIPLIER, DiveModel } from "../../src/core/dive-model";
import {
  createCcrState,
  createGasMix,
  createInitialDiveState,
  createTankState,
  freezeDiveState,
  type DiveState,
} from "../../src/core/dive-state";
import { litres, metres, seconds } from "../../src/core/units";
// Legacy's own code for the drills (#160), not a restatement of it.
import constantsSource from "../../src/constants.js?raw";
import gameLoopSource from "../../src/game-loop.js?raw";
import stateSource from "../../src/state.js?raw";

// The training drills against the legacy client (#45): its catalogue, its
// gates, its pick, its options and their effects, and its words, run from its
// own source over the states the wreck can meet. No recorded dive has a drill
// (scripts/baseline-scenarios.cjs turns them off), so the comparison is made
// here, state by state. Legacy's lightFailure needs the cave (#167).

function legacyFunction(source: string, name: string): string {
  const match = new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, "m").exec(source);
  if (!match) throw new Error(`could not read ${name}() from the legacy source`);
  return match[0];
}

/** Legacy's own lines from `start` to the end of `end`, in one function. */
function legacyLines(name: string, start: string, end: RegExp): string {
  const body = legacyFunction(gameLoopSource, name);
  const from = body.indexOf(start);
  const match = from < 0 ? null : end.exec(body.slice(from));
  if (!match) throw new Error(`could not read ${name}()'s drill lines from the legacy source`);
  return body.slice(from, from + match.index + match[0].length);
}

// Legacy's save and restore of a drill under way (#160, TC-45-66): the drill's
// lines of saveDiveState(), restoreDiveState() and _isValidSaveState(). The
// rest of the save is the dive's, which the save-game tests compare.
const LEGACY_SAVES_DRILL = legacyLines(
  "saveDiveState",
  "drillHasRunThisDive: drillHasRunThisDive,",
  /breathHoldUntilDiveSec: drillState\.breathHoldUntilDiveSec\s*\}/,
);
const LEGACY_RESTORES_DRILL = legacyLines("restoreDiveState", "drillHasRunThisDive = !!state", /drillState\.optionRects = \[\];/);
const LEGACY_CHECKS_DRILL = legacyLines("_isValidSaveState", "if (!state.drillState ||", /[\s\S]*?(?=\s*return true;\s*\}$)/);

/** Legacy's globals the drills read and write, set from the model's state. */
const GLOBALS = [
  "drillsEnabled", "drillHasRunThisDive", "diveTime", "depth", "po2ViolationTime", "dcsViolationTime",
  "barotraumaTime", "hypoxiaTime", "ccrHypoxiaTime", "ccrHyperoxiaTime", "diveMode", "diveSite", "inOverhead",
  "torchOn", "ccrState", "tankCount", "tanks", "activeTank",
] as const;
type LegacyGlobals = Record<(typeof GLOBALS)[number], unknown>;
type LegacyCcr = { onBailout: boolean; scrubberFailed: boolean; co2BuildupTime: number; targetSP: number };

const legacy = new Function(
  `${constantsSource}
var ${GLOBALS.join(", ")}, drillState, badAirWarning = false, visibility = 1, verticalVelocity = 0,
  gasSwitchNotifyTime = 0, gasSwitchNotifyText = '', gameState, diveEvents = [], _gsBuilt = true;
// The page's clock, which _drillRealTime() reads; a reloaded page starts its own.
var realS = 0, performance = { now: function () { return realS * 1000; } };
${legacyFunction(stateSource, "ccrAdjustSP")}
${["_drillIsAlarmActive", "isDrillEligibleNow", "_pickEligibleDrill", "_drillById", "startDrill", "_drillRealTime",
  "_openDrillOverlay", "resolveDrillOption", "_visibleDrillOptions", "perSecondToPerFrameProbability",
  "dismissDrillDebrief"]
  .map((name) => legacyFunction(gameLoopSource, name))
  .join("\n")}
return {
  STRINGS: STRINGS, DRILLS: DRILLS,
  constants: { DRILL_MIN_DIVETIME_MIN, DRILL_MAX_DIVETIME_MIN, DRILL_MIN_DEPTH_M, DRILL_TRIGGER_PROB_PER_SEC,
    DRILL_DEBRIEF_DURATION_SEC, DRILL_FREEFLOW_MULT, DRILL_FREEFLOW_DURATION_SEC, DRILL_BREATHHOLD_DURATION_SEC },
  set: function (g) {
    ${GLOBALS.map((name) => `${name} = g.${name};`).join(" ")}
    // src/state.js resetDive()'s drillState.
    drillState = { phase: 'inactive', id: null, selectedOption: -1, correct: false, freeflowUntilDiveSec: 0,
      freeflowDrainTankIdx: -1, lightRestoreAt: 0, breathHoldUntilDiveSec: 0, optionRects: [] };
    gameState = 'diving';
  },
  read: function () { return { drillState: drillState, activeTank: activeTank, ccrState: ccrState, gameState: gameState, diveEvents: diveEvents }; },
  isDrillEligibleNow: isDrillEligibleNow,
  pick: function (r) { var real = Math.random; Math.random = function () { return r; };
    try { var d = _pickEligibleDrill(); return d && d.id; } finally { Math.random = real; } },
  startDrill: startDrill,
  resolveDrillOption: resolveDrillOption,
  chance: function (dt) { return perSecondToPerFrameProbability(DRILL_TRIGGER_PROB_PER_SEC, dt); },
  dismissDrillDebrief: dismissDrillDebrief,
  clock: function (s) { realS = s; },
  save: function () { return { ${LEGACY_SAVES_DRILL} }; },
  // A reloaded page: resetDive()'s drill, then restoreDiveState()'s.
  restore: function (state) {
    gameState = state.gameState;
    drillHasRunThisDive = false;
    drillState = { phase: 'inactive', id: null, selectedOption: -1, correct: false, freeflowUntilDiveSec: 0,
      freeflowDrainTankIdx: -1, lightRestoreAt: 0, breathHoldUntilDiveSec: 0, optionRects: [] };
    ${LEGACY_RESTORES_DRILL}
  },
  valid: function (state) { ${LEGACY_CHECKS_DRILL} return true; }
};`,
)() as {
  STRINGS: Record<"en" | "de", Record<string, unknown> & { drills: Record<string, Record<string, string | string[]>> }>;
  DRILLS: { id: string; options: { correct: boolean; requiresMultiTank?: boolean }[] }[];
  constants: Record<string, number>;
  set(globals: LegacyGlobals): void;
  read(): { drillState: Record<string, unknown>; activeTank: number; ccrState: LegacyCcr; gameState: string; diveEvents: unknown[] };
  isDrillEligibleNow(): boolean;
  pick(random: number): string | null;
  startDrill(id: string): boolean;
  resolveDrillOption(index: number): boolean;
  chance(dt: number): number;
  dismissDrillDebrief(): boolean;
  clock(realS: number): void;
  save(): LegacySavedDrill;
  restore(state: LegacySavedDrill & { gameState: string }): void;
  valid(state: LegacySavedDrill & { gameState: string; tankCount: number }): boolean;
};

interface LegacySavedDrill {
  drillHasRunThisDive: unknown;
  drillState: Record<string, unknown>;
}

const AIR = createGasMix(0.21, 0);

interface Case {
  readonly name: string;
  readonly state: DiveState;
  readonly diveTimeMin: number;
  readonly enabled: boolean;
  readonly ran: boolean;
}

/** The model's state and legacy's globals for the same moment of a dive. */
function legacyGlobals({ state, diveTimeMin, enabled, ran }: Case): LegacyGlobals {
  const { failure, ccr } = state;
  return {
    drillsEnabled: enabled,
    drillHasRunThisDive: ran,
    diveTime: diveTimeMin,
    depth: state.depthM,
    po2ViolationTime: failure.oxygenToxicityS,
    dcsViolationTime: failure.dcsViolationS,
    barotraumaTime: failure.barotraumaS,
    hypoxiaTime: failure.hypoxiaS,
    ccrHypoxiaTime: failure.ccrHypoxiaS,
    ccrHyperoxiaTime: failure.ccrHyperoxiaS,
    diveMode: ccr ? "ccr" : state.tanks.length > 1 ? "tec" : "rec",
    // The wreck, under its overhead with the torch on: lightFailure's other two conditions met.
    diveSite: "wreck",
    inOverhead: true,
    torchOn: true,
    ccrState: {
      onBailout: ccr?.onBailout ?? false,
      scrubberFailed: ccr?.scrubberFailed ?? false,
      co2BuildupTime: ccr?.co2BuildupS ?? 0,
      targetSP: ccr?.targetPo2Bar ?? 0.7,
    },
    tankCount: state.tanks.length,
    tanks: state.tanks.map((tank, index) => ({ gasRemaining: tank.gasRemainingL, label: `T${index + 1}` })),
    activeTank: state.activeTankIndex,
  };
}

function dive(depthM: number, diveTimeMin: number, options: Parameters<typeof createInitialDiveState>[1] = {}, failure = {}): DiveState {
  const state = createInitialDiveState(1, options);
  return freezeDiveState({
    ...state,
    depthM: metres(depthM),
    maxDepthM: metres(depthM),
    elapsedTimeS: seconds(diveTimeMin * 60),
    failure: { ...state.failure, ...failure },
  });
}

const ccr = (overrides: Partial<{ onBailout: boolean; scrubberFailed: boolean }> = {}) => ({
  ccr: { ...createCcrState(AIR), ...overrides },
});
const tanks = (...litresLeft: number[]) => ({
  tanks: litresLeft.map((left) => ({ ...createTankState(AIR), gasRemainingL: litres(left) })),
});

const STATES: readonly [string, DiveState][] = [
  ["open circuit at 20 m", dive(20, 7)],
  ["two cylinders at 30 m", dive(30, 7, tanks(2400, 2400))],
  ["three cylinders, the second empty", dive(30, 7, tanks(2400, 0, 1200))],
  ["a rebreather", dive(20, 7, ccr())],
  ["a rebreather bailed out", dive(20, 7, ccr({ onBailout: true }))],
  ["a rebreather's failed scrubber", dive(20, 7, ccr({ scrubberFailed: true }))],
  ["at 8 m", dive(8, 7)],
  ["at 8.1 m", dive(8.1, 7)],
  ["a PO₂ violation counting", dive(20, 7, {}, { oxygenToxicityS: 0.5 })],
  ["a DCS violation counting", dive(20, 7, {}, { dcsViolationS: 0.5 })],
  ["barotrauma counting", dive(20, 7, {}, { barotraumaS: 0.5 })],
  ["hypoxia counting", dive(20, 7, {}, { hypoxiaS: 0.5 })],
  ["a stale loop hypoxia timer on open circuit", dive(20, 7, {}, { ccrHypoxiaS: 2 })],
  ["loop hypoxia counting", dive(20, 7, ccr(), { ccrHypoxiaS: 2 })],
  ["loop hyperoxia counting", dive(20, 7, ccr(), { ccrHyperoxiaS: 2 })],
];

const CASES: Case[] = STATES.flatMap(([name, state]) =>
  [2.99, 3, 15, 15.01].flatMap((diveTimeMin) =>
    [
      [true, false],
      [false, false],
      [true, true],
    ].map(([enabled, ran]) => ({
      name: `${name}, ${diveTimeMin} min, ${enabled ? "on" : "off"}${ran ? ", one run" : ""}`,
      state,
      diveTimeMin,
      enabled: enabled!,
      ran: ran!,
    })),
  ),
);

describe("the training drills against legacy's own functions (#160)", () => {
  it("has legacy's numbers", () => {
    expect(legacy.constants).toEqual({
      DRILL_MIN_DIVETIME_MIN: DRILL_MIN_DIVE_TIME_S / 60,
      DRILL_MAX_DIVETIME_MIN: DRILL_MAX_DIVE_TIME_S / 60,
      DRILL_MIN_DEPTH_M,
      DRILL_TRIGGER_PROB_PER_SEC: 0.03,
      DRILL_DEBRIEF_DURATION_SEC: DRILL_DEBRIEF_S,
      DRILL_FREEFLOW_MULT: DRILL_FREEFLOW_MULTIPLIER,
      DRILL_FREEFLOW_DURATION_SEC: DRILL_FREEFLOW_S,
      DRILL_BREATHHOLD_DURATION_SEC: DRILL_BREATH_HOLD_S,
    });
    for (const dt of [0, 1 / 144, 1 / 60, 0.033, 0.1]) {
      expect(drillTriggerChance(dt)).toBe(legacy.chance(dt));
    }
  });

  it("has legacy's catalogue, less lightFailure, which needs the cave", () => {
    expect(legacy.DRILLS.map((drill) => drill.id)).toEqual(["lightFailure", ...DRILLS.map((drill) => drill.id)]);
    for (const drill of DRILLS) {
      const theirs = legacy.DRILLS.find((entry) => entry.id === drill.id)!;
      expect(drill.options.map((o) => [o.correct, o.multiTankOnly])).toEqual(
        theirs.options.map((o) => [o.correct, o.requiresMultiTank ?? false]),
      );
    }
  });

  it.each(CASES)("is eligible and picks as legacy: $name", (testCase) => {
    legacy.set(legacyGlobals(testCase));
    const drill = { ...NO_DRILL, ranThisDive: testCase.ran };
    expect(isDrillEligible(drill, testCase.enabled, testCase.state, testCase.diveTimeMin * 60)).toBe(
      legacy.isDrillEligibleNow(),
    );
    for (const random of [0, 0.99]) {
      expect(pickDrill(testCase.state, () => random)).toBe(legacy.pick(random));
    }
  });

  const RESOLUTIONS = STATES.slice(0, 4).flatMap(([name, state]) => {
    const id: DrillId = state.ccr ? "co2" : "freeflow";
    return [0, 1, 2, 3].map((index) => ({ name: `${name}, ${id} option ${index + 1}`, state, id, index }));
  });

  it.each(RESOLUTIONS)("resolves as legacy: $name", ({ state: before, id, index }) => {
    legacy.set(legacyGlobals({ name: "", state: before, diveTimeMin: 7, enabled: true, ran: false }));
    expect(legacy.startDrill(id)).toBe(true);
    const theirs = legacy.read();
    expect(theirs.gameState).toBe("drill");
    // The co2 drill starts as legacy's does, its scrubber failed, and its CO₂
    // has built up for 40 s by the choice, so the options' effect on it shows.
    const starting = new DiveModel(before);
    starting.failScrubber();
    const state = starting.snapshot.ccr
      ? freezeDiveState({ ...starting.snapshot, ccr: { ...starting.snapshot.ccr, co2BuildupS: seconds(40) } })
      : starting.snapshot;
    theirs.ccrState.co2BuildupTime = before.ccr ? 40 : 0;
    expect(state.ccr?.scrubberFailed ?? false).toBe(theirs.ccrState.scrubberFailed);
    const ours = resolveDrillOption(startDrill(NO_DRILL, id), index, state);
    expect(ours !== null).toBe(legacy.resolveDrillOption(index));
    const after = legacy.read();
    if (!ours) {
      expect(after.drillState.phase).toBe("overlay");
      return;
    }
    expect(index).toBeLessThan(visibleDrillOptions(id, state.tanks.length).length);
    expect({
      phase: ours.drill.phase,
      selectedOption: ours.drill.selectedOption,
      correct: ours.drill.correct,
      freeflowUntilS: ours.drill.freeflowUntilS,
      freeflowTankIndex: ours.drill.freeflowTankIndex,
      breathHoldUntilS: ours.drill.breathHoldUntilS,
    }).toEqual({
      phase: after.drillState.phase,
      selectedOption: after.drillState.selectedOption,
      correct: after.drillState.correct,
      freeflowUntilS: after.drillState.freeflowUntilDiveSec,
      freeflowTankIndex: after.drillState.freeflowDrainTankIdx,
      breathHoldUntilS: after.drillState.breathHoldUntilDiveSec,
    });
    // The departure (docs/decisions.md): legacy logs the outcome to
    // diveEvents, where its profile draws it; the model's log does not.
    expect(after.diveEvents.at(-1)).toMatchObject({ kind: "drillOutcome", value: { id, option: index, correct: ours.drill.correct } });
    const model = new DiveModel(state);
    applyDrillEffect(model, ours);
    expect(model.snapshot.log.entries).toEqual(state.log.entries);
    expect(model.snapshot.activeTankIndex).toBe(after.activeTank);
    expect({
      onBailout: model.snapshot.ccr?.onBailout ?? false,
      scrubberFailed: model.snapshot.ccr?.scrubberFailed ?? false,
      co2BuildupS: model.snapshot.ccr?.co2BuildupS ?? 0,
    }).toEqual({
      onBailout: after.ccrState.onBailout,
      scrubberFailed: after.ccrState.scrubberFailed,
      co2BuildupS: after.ccrState.co2BuildupTime,
    });
    expect(model.snapshot.ccr?.targetPo2Bar ?? 0.7).toBeCloseTo(after.ccrState.targetSP, 12);
  });

  it("starts the co2 drill as legacy: the scrubber failed and its CO₂ from zero", () => {
    const state = dive(20, 7, { ccr: { ...createCcrState(AIR), co2BuildupS: seconds(40) } });
    legacy.set(legacyGlobals({ name: "", state, diveTimeMin: 7, enabled: true, ran: false }));
    legacy.startDrill("co2");
    const model = new DiveModel(state);
    model.failScrubber();
    expect({ scrubberFailed: model.snapshot.ccr?.scrubberFailed, co2: model.snapshot.ccr?.co2BuildupS }).toEqual({
      scrubberFailed: legacy.read().ccrState.scrubberFailed,
      co2: legacy.read().ccrState.co2BuildupTime,
    });
  });

  it.each(["en", "de"] as const)("speaks legacy's words, word for word, in %s", (locale) => {
    const strings = legacy.STRINGS[locale];
    const t = (key: MessageKey) => translate(locale, key);
    expect([
      t("setup.drills"),
      t("setup.drills.hint"),
      t("drill.header"),
      t("drill.prompt"),
      t("drill.debrief.header"),
      t("drill.debrief.correct"),
      t("drill.debrief.wrong"),
      t("drill.debrief.why"),
      t("drill.debrief.realWorld"),
      t("drill.debrief.dismiss"),
    ]).toEqual([
      strings.drillsToggleLabel,
      strings.drillsToggleHint,
      strings.drillHeader,
      strings.drillPromptFooter,
      strings.drillDebriefHeader,
      strings.drillDebriefCorrect,
      strings.drillDebriefWrong,
      strings.drillDebriefWhyLabel,
      strings.drillDebriefRealLabel,
      strings.drillDebriefDismiss,
    ]);
    for (const drill of DRILLS) {
      const keys = DRILL_MESSAGES[drill.id];
      const theirs = strings.drills[drill.id]!;
      expect({
        title: t(keys.titleKey),
        text: t(keys.textKey),
        options: keys.optionKeys.map(t),
        why: t(keys.whyKey),
        realWorld: t(keys.realWorldKey),
      }).toEqual(theirs);
    }
  });
});

/** Legacy's saved drill under the model's names, as the save's migration reads it. */
function fromLegacy({ drillHasRunThisDive, drillState: drill }: LegacySavedDrill): Record<keyof DrillState, unknown> {
  return {
    phase: drill.phase,
    id: drill.id,
    ranThisDive: drillHasRunThisDive,
    selectedOption: drill.selectedOption,
    correct: drill.correct,
    debriefRemainingS: drill.debriefRemainingSec,
    freeflowUntilS: drill.freeflowUntilDiveSec,
    freeflowTankIndex: drill.freeflowDrainTankIdx,
    breathHoldUntilS: drill.breathHoldUntilDiveSec,
  };
}

/** A legacy save of `state` (src/game-loop.js saveDiveState) with the drill's fields given. */
function legacySave(state: DiveState, drill: LegacySavedDrill & { gameState: string }): string {
  return JSON.stringify({
    saveVersion: 2,
    savedAt: 1_735_689_600_000,
    depth: state.depthM,
    maxDepth: state.maxDepthM,
    diveTime: state.elapsedTimeS / 60,
    amvRate: 17,
    po2ViolationTime: 0,
    hypoxiaTime: 0,
    ccrHypoxiaTime: 0,
    ccrHyperoxiaTime: 0,
    tissues: [...state.tissues.nitrogenBar],
    tissuesHe: [...state.tissues.heliumBar],
    activeTank: state.activeTankIndex,
    tankCount: state.tanks.length,
    diveMode: state.ccr ? "ccr" : state.tanks.length > 1 ? "tec" : "rec",
    tanks: state.tanks.map(() => ({ fO2: 0.21, fHe: 0, fN2: 0.79, pressure: 135, volume: 12, totalGas: 2_400, gasRemaining: 1_620 })),
    ccrState: {
      o2CylVolume: 2, o2CylPressure: 175, dilCylVolume: 3, dilCylPressure: 160, dilFO2: 0.21, dilFN2: 0.79, dilFHe: 0,
      loopVolume: 6, targetSP: 1.3, actualPO2: 1.28, scrubberRemaining: 150, metabolicO2Rate: 0.8, po2ResponseRate: 0.05,
      onBailout: false, scrubberFailed: state.ccr?.scrubberFailed ?? false, co2BuildupTime: 0,
    },
    ...drill,
  });
}

const FACTORS = { lowPercent: 30, highPercent: 70 };

describe("a drill under way saved and resumed as legacy's save and restore (#160, TC-45-66)", () => {
  // Each drill and option, at its decision, two real seconds into its
  // debriefing, and after it, while its free-flow or held breath runs on.
  const MOMENTS = STATES.slice(0, 4).flatMap(([name, state]) => {
    const id: DrillId = state.ccr ? "co2" : "freeflow";
    const options = visibleDrillOptions(id, state.tanks.length);
    return [
      { name: `${name}, ${id} decision`, state, id, index: null, dismissed: false },
      ...options.flatMap((_, index) => [false, true].map((dismissed) => ({
        name: `${name}, ${id} option ${index + 1}, ${dismissed ? "after the debriefing" : "debriefing"}`,
        state, id, index, dismissed,
      }))),
    ];
  });

  it.each(MOMENTS)("TC-45-66-DRILL-OVERLAY-SURVIVES-RESUME, -EFFECT-TIMERS-SURVIVE-RESUME: $name", ({ state, id, index, dismissed }) => {
    legacy.set(legacyGlobals({ name: "", state, diveTimeMin: 7, enabled: true, ran: false }));
    legacy.clock(1000);
    legacy.startDrill(id);
    let ours: DrillState = startDrill(NO_DRILL, id);
    if (index !== null) {
      legacy.resolveDrillOption(index);
      ours = resolveDrillOption(ours, index, state)!.drill;
      legacy.clock(1002);
      ours = tickDrillDebrief(ours, 2);
      if (dismissed) {
        legacy.dismissDrillDebrief();
        ours = dismissDrillDebrief(ours);
      }
    }
    const theirs = legacy.save();
    const gameState = legacy.read().gameState;
    expect(legacy.valid({ ...theirs, gameState, tankCount: state.tanks.length })).toBe(true);

    // The migration's save holds what legacy's holds, and so does a legacy save it imports.
    const saved = decodeSaveGame(encodeSaveGame(createSaveGame(state, FACTORS, 1, undefined, undefined, ours)));
    const imported = decodeSaveGame(legacySave(state, { ...theirs, gameState }));
    if (!saved.ok || !imported.ok) throw new Error("the dive was not resumed");
    expect(saved.saveGame.drill).toEqual(fromLegacy(theirs));
    expect(imported.saveGame.drill).toEqual(fromLegacy(theirs));

    // Restored on a reloaded page, whose clock starts again: the same drill,
    // the same seconds of debriefing left, and its decision still answerable.
    legacy.clock(3);
    legacy.restore({ ...theirs, gameState });
    const restored = legacy.read().drillState;
    const resumed = saved.saveGame.drill;
    expect(resumed.phase).toBe(restored.phase);
    expect(resumed.debriefRemainingS).toBe(resumed.phase === "debrief" ? (restored.debriefUntilReal as number) - 3 : 0);
    expect(resumed.freeflowUntilS).toBe(restored.freeflowUntilDiveSec);
    const answered = resolveDrillOption(resumed, 0, state);
    expect(answered !== null).toBe(legacy.resolveDrillOption(0));
    expect(answered?.drill.phase ?? resumed.phase).toBe(legacy.read().drillState.phase);
  });

  // Legacy's TC-45-66-VALIDATOR-* payloads, on a two-cylinder dive whose
  // free-flow drill was breathed through and runs on.
  const twoCylinders = STATES[1]![1];
  const base = (): LegacySavedDrill & { gameState: string } => {
    legacy.set(legacyGlobals({ name: "", state: twoCylinders, diveTimeMin: 7, enabled: true, ran: false }));
    legacy.startDrill("freeflow");
    legacy.resolveDrillOption(0);
    legacy.dismissDrillDebrief();
    return { ...legacy.save(), gameState: legacy.read().gameState };
  };
  const PAYLOADS: [string, string, Record<string, unknown>][] = [
    ["the genuine drill", "diving", {}],
    ["an unknown id at the decision", "drill", { phase: "overlay", id: "not-a-real-drill" }],
    ["no id at the decision", "drill", { phase: "overlay", id: null }],
    ["an unknown id in the debriefing", "drill", { phase: "debrief", id: "not-a-real-drill" }],
    ["no id after it", "diving", { id: null }],
    ["the cave's flicker in 'drill'", "drill", { phase: "flicker", id: "lightFailure" }],
    ["a flicker of another drill", "diving", { phase: "flicker" }],
    ["'drill' with none", "drill", { phase: "inactive", id: null, freeflowUntilDiveSec: 0, freeflowDrainTankIdx: -1 }],
    ["'drill' after it", "drill", {}],
    ["'diving' at its decision", "diving", { phase: "overlay" }],
    ["'surface' after it", "surface", {}],
    ["none with an id", "diving", { phase: "inactive", freeflowUntilDiveSec: 0, freeflowDrainTankIdx: -1 }],
    ["a free-flow on a cylinder the dive lacks", "diving", { freeflowDrainTankIdx: 5 }],
    ["a free-flow on none", "diving", { freeflowDrainTankIdx: -1 }],
    ["a cylinder after the free-flow", "diving", { freeflowUntilDiveSec: 0, freeflowDrainTankIdx: 0 }],
    ["a free-flow on the second cylinder", "diving", { freeflowDrainTankIdx: 1 }],
    ["an unknown phase", "diving", { phase: "paused" }],
    ["a timer that is not a number", "diving", { breathHoldUntilDiveSec: null }],
    ["a fractional option", "diving", { selectedOption: 0.5 }],
    ["a verdict that is not one", "diving", { correct: "yes" }],
  ];

  it.each(PAYLOADS)("TC-45-66-VALIDATOR-*: %s, under %s, resumes what legacy restores, or none", (_, gameState, change) => {
    const payload = base();
    const drill = { ...payload, gameState, drillState: { ...payload.drillState, ...change } };
    const imported = decodeSaveGame(legacySave(twoCylinders, drill));
    // Where legacy refuses the whole save the dive is kept, the drill dropped (docs/decisions.md).
    if (!imported.ok) throw new Error("the dive was not resumed");
    const expected = legacy.valid({ ...drill, tankCount: 2 }) ? fromLegacy(drill) : { ...NO_DRILL, ranThisDive: true };
    expect(imported.saveGame.drill).toEqual(expected);
  });

  it("TC-45-66-VALIDATOR-ACCEPTS-GENUINE-FLICKER: legacy's cave drill resumes here with none under way, run", () => {
    const payload = base();
    const drill = { ...payload, drillState: { ...payload.drillState, phase: "flicker", id: "lightFailure" } };
    expect(legacy.valid({ ...drill, tankCount: 2 })).toBe(true);
    const imported = decodeSaveGame(legacySave(twoCylinders, drill));
    expect(imported.ok && imported.saveGame.drill).toEqual({ ...NO_DRILL, ranThisDive: true });
  });
});
